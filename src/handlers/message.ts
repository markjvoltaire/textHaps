import { attachment, group, type Message, type Space } from "spectrum-ts";
import { generateReply } from "../agent/claude.ts";
import { formatCatalogOverview, listCatalogEvents } from "../db/events.ts";
import { listSaves } from "../db/saves.ts";
import { upsertProfile } from "../db/profiles.ts";
import { listTaste } from "../db/taste.ts";
import { appendTurn, getHistory } from "../memory/history.ts";
import { extractText, sanitizeOutgoingText } from "../utils/text.ts";

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
  const profile = await upsertProfile(platform, senderId);
  const [taste, saves] = await Promise.all([listTaste(profile.id), listSaves(profile.id)]);
  const history = getHistory(senderId);

  let reply: string;
  let imagePaths: string[] = [];
  try {
    const generated = await generateReply({ profile, taste, saves, history, userMessage: text });
    imagePaths = generated.imagePaths;
    reply = imagePaths.length > 0
      ? formatCatalogOverview(await listCatalogEvents())
      : sanitizeOutgoingText(generated.text);
  } catch (err) {
    console.error(`[claude] failed for sender=${senderId}:`, err instanceof Error ? err.message : err);
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
  const flyers = imagePaths.map((path) => attachment(path));
  const first = flyers[0];
  const second = flyers[1];
  if (first && second) {
    await space.send(group(first, second, ...flyers.slice(2)), reply);
  } else if (first) {
    await space.send(first, reply);
  } else {
    await space.send(reply);
  }
}
