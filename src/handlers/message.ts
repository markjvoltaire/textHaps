import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { attachment, contact, group, type Message, type Space } from "spectrum-ts";
import { background, nativeContactCard } from "spectrum-ts/providers/imessage";
import { generateReply } from "../agent/claude.ts";
import { formatCatalogOverview } from "../db/events.ts";
import { listSaves } from "../db/saves.ts";
import { claimMessage } from "../db/handled.ts";
import { markBackgroundSet, markContactCardSent, upsertProfile } from "../db/profiles.ts";
import type { Profile } from "../db/types.ts";
import { flushTracing } from "../observability.ts";
import { listTaste } from "../db/taste.ts";
import { appendExchange, getHistory } from "../memory/history.ts";
import { checkRateLimit, noteVoiceFailure, shouldWarn, voiceAllowed } from "./rateLimit.ts";
import { extractText, formatError, sanitizeOutgoingText } from "../utils/text.ts";
import { transcribe } from "../voice/deepgram.ts";

const FALLBACK_REPLY = "ugh my bad, something glitched\ntry me again?";
const RATE_LIMIT_REPLY = "ok i need a breather, hit me back in a bit";
const SEARCHING_REPLIES = ["let me check for you", "let me see what i find", "one sec, looking"];
const VOICE_FALLBACK_REPLY = "couldn't catch that voice note\ntext it to me instead?";
// A few minutes of voice note is well under this.
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const AUDIO_READ_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type Audio = { mimeType: string; read: () => Promise<Buffer> };

/** A voice note, or an audio file sent as an attachment. */
function audioOf(content: Message["content"]): Audio | undefined {
  if (content.type === "voice") return content;
  if (content.type === "attachment" && content.mimeType.startsWith("audio/")) return content;
  return undefined;
}
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const BACKGROUND_PATH = join(ASSETS_DIR, "haps-bg.jpg");
const ICON_PATH = join(ASSETS_DIR, "haps-icon.jpg");

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

/**
 * Once per person: shares Haps's iMessage name and photo (set on the Photon project
 * profile), which shows "Maybe: Haps" and an Add banner, then sends a Haps contact
 * card with the icon when HAPS_PHONE_NUMBER is set. A failure never blocks the reply.
 */
async function ensureContactCard(space: Space, profile: Profile): Promise<void> {
  if (profile.platform !== "imessage" || profile.contact_card_sent_at) return;
  try {
    await space.send(nativeContactCard());
    // Marked now so a failing card send below can't re-send the native card on every reply.
    await markContactCardSent(profile.id);
    const phone = process.env.HAPS_PHONE_NUMBER;
    if (phone) {
      await space.send(
        contact({
          name: { first: "Haps" },
          phones: [{ value: phone, type: "mobile" }],
          photo: { mimeType: "image/jpeg", read: () => readFile(ICON_PATH) },
        }),
      );
    }
    console.log(`[contact] shared with sender=${profile.platform_user_id} card=${Boolean(phone)}`);
  } catch (err) {
    console.warn(`[contact] failed for sender=${profile.platform_user_id}:`, formatError(err));
  }
}

export async function handleMessage(space: Space, message: Message): Promise<void> {
  if (message.direction === "outbound") return;
  if (message.content.type === "read") return;
  const audio = audioOf(message.content);
  if (message.content.type !== "text" && !audio) {
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
  const platform = message.platform || "imessage";
  let text = extractText(message.content).trim();
  if (!text && !audio) return;

  // Before any voice work, so an over-limit sender can't run up the Deepgram bill.
  let profile: Profile;
  try {
    profile = await upsertProfile(platform, senderId);
    const limit = await checkRateLimit(profile.id);
    if (!limit.ok) {
      console.warn(`[limit] sender=${senderId} over ${limit.window} limit`);
      if (shouldWarn(profile.id, limit.window)) await space.send(RATE_LIMIT_REPLY);
      return;
    }
  } catch (err) {
    console.error(`[handler] profile or limit check failed for sender=${senderId}:`, formatError(err));
    await space.send(FALLBACK_REPLY);
    return;
  }

  // Voice notes become text first, then go through the same flow as a typed message.
  if (audio) {
    if (!voiceAllowed(profile.id)) {
      console.warn(`[voice] sender=${senderId} too many failed voice notes, skipping`);
      return;
    }
    try {
      // Spectrum doesn't give the size up front, so a stalled download is cut off instead.
      const buf = await withTimeout(audio.read(), AUDIO_READ_TIMEOUT_MS, "audio download");
      if (buf.length > MAX_AUDIO_BYTES) throw new Error(`audio too large: ${buf.length} bytes`);
      text = await transcribe(buf, audio.mimeType);
      console.log(`[voice] sender=${senderId} mime=${audio.mimeType} transcript=${JSON.stringify(text)}`);
    } catch (err) {
      console.warn(`[voice] transcription failed for sender=${senderId}:`, formatError(err));
    }
    if (!text) {
      noteVoiceFailure(profile.id);
      await space.send(VOICE_FALLBACK_REPLY);
      return;
    }
  }

  console.log(`[in] space=${space.id} sender=${senderId} text=${JSON.stringify(text)}`);

  // One Langfuse trace per reply: the text in, what was actually sent out, and the
  // Claude calls and tools in between (no-op when Langfuse keys aren't set).
  await startActiveObservation("imessage-reply", async (span) => {
    span.update({ input: text, metadata: { voice: Boolean(audio) } });
    let reply: string;
    let imagePaths: string[] = [];
    // Web searches take a few seconds, so text a quick heads-up once and keep the typing dots going.
    let searchingNotice: Promise<void> | undefined;
    const onWebSearch = () => {
      if (searchingNotice) return;
      const notice = SEARCHING_REPLIES[Math.floor(Math.random() * SEARCHING_REPLIES.length)]!;
      searchingNotice = space
        .send(notice)
        .then(() => space.startTyping())
        .catch((err: unknown) => console.warn(`[searching] notice failed for sender=${senderId}:`, formatError(err)));
    };
    try {
      await ensureBackground(space, profile);
      const [taste, saves, history] = await Promise.all([
        listTaste(profile.id),
        listSaves(profile.id),
        getHistory(profile.id),
      ]);
      const generated = await propagateAttributes({ userId: profile.id, sessionId: profile.id }, () =>
        generateReply({ profile, taste, saves, history, userMessage: text, onWebSearch }),
      );
      // The heads-up must land before the answer.
      await searchingNotice;
      imagePaths = generated.imagePaths;
      reply = sanitizeOutgoingText(generated.text);
      if (!reply && imagePaths.length > 0) {
        reply = sanitizeOutgoingText(formatCatalogOverview(generated.events));
      }
    } catch (err) {
      console.error(`[handler] failed for sender=${senderId}:`, formatError(err));
      span.update({ level: "ERROR", statusMessage: formatError(err) });
      // Let a pending heads-up land first so the glitch message doesn't arrive before it.
      await searchingNotice;
      await space.send(FALLBACK_REPLY);
      return;
    }

    if (!reply) {
      console.warn(`[claude] empty reply for sender=${senderId}`);
      // They were told "let me check", so don't leave them hanging.
      if (searchingNotice) await space.send(FALLBACK_REPLY);
      return;
    }

    // Only commit the exchange once the model actually produced something.
    // Keep only what the user actually sees: the lead plus up to 2 more bubbles.
    const bubbles = reply.split(/\n+/).map((part) => part.trim()).filter(Boolean).slice(0, 3);
    span.update({ output: bubbles.join("\n"), metadata: { platform, flyers: imagePaths.length } });
    await appendExchange(profile.id, senderId, text, bubbles.join("\n")).catch((err: unknown) => {
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
    // After the first reply, not before it, so the chat opens with Haps talking.
    await ensureContactCard(space, profile);
  });
  await flushTracing();
}

function flyerAttachment(ref: string) {
  if (/^https?:\/\//i.test(ref)) {
    return attachment(new URL(ref), { mimeType: "image/jpeg", name: "flyer.jpg" });
  }
  return attachment(ref);
}
