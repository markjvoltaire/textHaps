import { attachment, group, type Message, type Space } from "spectrum-ts";
import { generateReply } from "../agent/claude.ts";
import { formatCatalogOverview, getLastSearchEvents } from "../db/events.ts";
import { listSaves } from "../db/saves.ts";
import { upsertProfile } from "../db/profiles.ts";
import { listTaste } from "../db/taste.ts";
import { appendTurn, getHistory } from "../memory/history.ts";
import { extractText, formatError, sanitizeOutgoingText } from "../utils/text.ts";

const FALLBACK_REPLY = "Sorry, I hit an error on my end. Try me again in a sec?";

export async function handleMessage(space: Space, message: Message): Promise<void> {
  if (message.direction === "outbound") return;
  if (message.content.type === "read") return;
  if (message.content.type !== "text") {
    console.log(`[skip] space=${space.id} unsupported content type=${message.content.type}`);
    return;
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

  const platform = message.platform || "imessage";
  let reply: string;
  let imagePaths: string[] = [];
  try {
    const profile = await upsertProfile(platform, senderId);
    const [taste, saves] = await Promise.all([listTaste(profile.id), listSaves(profile.id)]);
    const history = getHistory(senderId);
    const generated = await generateReply({ profile, taste, saves, history, userMessage: text });
    imagePaths = generated.imagePaths;
    reply = sanitizeOutgoingText(generated.text);
    if (!reply && imagePaths.length > 0) {
      reply = sanitizeOutgoingText(formatCatalogOverview(getLastSearchEvents()));
    }
  } catch (err) {
    console.error(`[handler] failed for sender=${senderId}:`, formatError(err));
    await space.send(FALLBACK_REPLY);
    return;
  }

  if (!reply) {
    console.warn(`[claude] empty reply for sender=${senderId}`);
    return;
  }

  // Only commit the exchange once the model actually produced something.
  appendTurn(senderId, { role: "user", content: text });
  appendTurn(senderId, { role: "assistant", content: reply });

  console.log(`[out] space=${space.id} sender=${senderId} reply=${JSON.stringify(reply)} images=${imagePaths.length}`);
  // Short texts, not one block: each blank-line-separated chunk goes out as its own bubble.
  const [lead = reply, ...rest] = reply.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
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
}

function flyerAttachment(ref: string) {
  if (/^https?:\/\//i.test(ref)) {
    return attachment(new URL(ref), { mimeType: "image/jpeg", name: "flyer.jpg" });
  }
  return attachment(ref);
}
