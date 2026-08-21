import type { Message, Space } from "spectrum-ts";
import { generateReply } from "../agent/claude.ts";
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

  const history = getHistory(senderId);

  let reply: string;
  try {
    reply = sanitizeOutgoingText(await generateReply(history, text));
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

  console.log(`[out] space=${space.id} sender=${senderId} reply=${JSON.stringify(reply)}`);
  await space.send(reply);
}
