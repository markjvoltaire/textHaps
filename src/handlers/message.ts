import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { attachment, group, type Message, type Space } from "spectrum-ts";
import { background } from "spectrum-ts/providers/imessage";
import { generateReply } from "../agent/claude.ts";
import { formatCatalogOverview } from "../db/events.ts";
import { listSaves } from "../db/saves.ts";
import { claimMessage } from "../db/handled.ts";
import { markBackgroundSet, upsertProfile } from "../db/profiles.ts";
import type { Profile } from "../db/types.ts";
import { flushTracing } from "../observability.ts";
import { listTaste } from "../db/taste.ts";
import { appendExchange, getHistory } from "../memory/history.ts";
import { checkRateLimit, shouldWarn } from "./rateLimit.ts";
import { extractText, formatError, sanitizeOutgoingText } from "../utils/text.ts";

const FALLBACK_REPLY = "ugh my bad, something glitched\ntry me again?";
const RATE_LIMIT_REPLY = "ok i need a breather, hit me back in a bit";
const BACKGROUND_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "haps-bg.jpg");

/** Sets the Haps chat background once per person. A failure never blocks the reply. */
async function ensureBackground(space: Space, profile: Profile): Promise<void> {
  if (profile.platform !== "imessage" || profile.background_set_at) return;
  try {
    await space.send(background(BACKGROUND_PATH));
    await markBackgroundSet(profile.id);
    console.log(`[background] set for sender=${profile.platform_user_id}`);
  } catch (err) {
    console.warn(`[background] failed for sender=${profile.platform_user_id}:`, formatError(err));
  }
}

export async function handleMessage(space: Space, message: Message): Promise<void> {
  if (message.direction === "outbound") return;
  if (message.content.type === "read") return;
  if (message.content.type !== "text") {
    console.log(`[skip] space=${space.id} unsupported content type=${message.content.type}`);
    return;
  }

  // Old and new workers overlap during a deploy and both get every message. Answer it once.
  // Terminal mode has a single process and no Photon message ids worth tracking.
  if (message.platform !== "terminal") {
    const claimed = await claimMessage(message.id).catch((err: unknown) => {
      console.warn(`[claim] failed id=${message.id}, answering anyway:`, formatError(err));
      return true;
    });
    if (!claimed) {
      console.log(`[claim] skip id=${message.id}, another worker has it`);
      return;
    }
  }

  // Mark the chat read before Claude work so the sender sees "Read" quickly.
  await message.read().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[read] failed space=${space.id}: ${msg}`);
  });

  const senderId = message.sender?.id ?? space.id;
  const text = extractText(message.content).trim();
  if (!text) return;

  console.log(`[in] space=${space.id} sender=${senderId} text=${JSON.stringify(text)}`);

  // One Langfuse trace per reply: the text in, what was actually sent out, and the
  // Claude calls and tools in between (no-op when Langfuse keys aren't set).
  await startActiveObservation("imessage-reply", async (span) => {
    span.update({ input: text });
    const platform = message.platform || "imessage";
    let profileId: string;
    let reply: string;
    let imagePaths: string[] = [];
    try {
      const profile = await upsertProfile(platform, senderId);
      profileId = profile.id;
      const limit = await checkRateLimit(profile.id);
      if (!limit.ok) {
        console.warn(`[limit] sender=${senderId} over ${limit.window} limit`);
        if (shouldWarn(profile.id, limit.window)) await space.send(RATE_LIMIT_REPLY);
        return;
      }
      await ensureBackground(space, profile);
      const [taste, saves, history] = await Promise.all([
        listTaste(profile.id),
        listSaves(profile.id),
        getHistory(profile.id),
      ]);
      const generated = await propagateAttributes({ userId: profile.id, sessionId: profile.id }, () =>
        generateReply({ profile, taste, saves, history, userMessage: text }),
      );
      imagePaths = generated.imagePaths;
      reply = sanitizeOutgoingText(generated.text);
      if (!reply && imagePaths.length > 0) {
        reply = sanitizeOutgoingText(formatCatalogOverview(generated.events));
      }
    } catch (err) {
      console.error(`[handler] failed for sender=${senderId}:`, formatError(err));
      span.update({ level: "ERROR", statusMessage: formatError(err) });
      await space.send(FALLBACK_REPLY);
      return;
    }

    if (!reply) {
      console.warn(`[claude] empty reply for sender=${senderId}`);
      return;
    }

    // Only commit the exchange once the model actually produced something.
    // Keep only what the user actually sees: the lead plus up to 2 more bubbles.
    const bubbles = reply.split(/\n+/).map((part) => part.trim()).filter(Boolean).slice(0, 3);
    span.update({ output: bubbles.join("\n"), metadata: { platform, flyers: imagePaths.length } });
    await appendExchange(profileId, senderId, text, bubbles.join("\n")).catch((err: unknown) => {
      console.error(`[history] save failed for sender=${senderId}:`, formatError(err));
    });

    console.log(`[out] space=${space.id} sender=${senderId} reply=${JSON.stringify(reply)} images=${imagePaths.length}`);
    // Short texts, not one block: each line goes out as its own bubble.
    const [lead = reply, ...rest] = bubbles;
    const flyers = imagePaths.map(flyerAttachment);
    const first = flyers[0];
    const second = flyers[1];
    if (first && second) {
      await space.send(group(first, second, ...flyers.slice(2)), lead);
    } else if (first) {
      await space.send(first, lead);
    } else {
      await space.send(lead);
    }
    for (const bubble of rest.slice(0, 2)) {
      await new Promise((resolve) => setTimeout(resolve, 900));
      await space.send(bubble);
    }
  });
  await flushTracing();
}

function flyerAttachment(ref: string) {
  if (/^https?:\/\//i.test(ref)) {
    return attachment(new URL(ref), { mimeType: "image/jpeg", name: "flyer.jpg" });
  }
  return attachment(ref);
}
