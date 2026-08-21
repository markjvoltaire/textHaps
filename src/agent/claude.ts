import Anthropic from "@anthropic-ai/sdk";
import type { ChatTurn } from "../memory/history.ts";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

const SYSTEM_PROMPT = `You are a helpful assistant that talks to people over iMessage.

Today's date is ${new Date().toISOString().split("T")[0]}.

Rules:
- Keep replies short and conversational — usually 1-3 sentences, like a text message.
- Plain text only. No Markdown, no asterisks, no backticks, no bullet lists.
- Refer back to earlier messages in the conversation when it's relevant.
- If a request is ambiguous, ask one short clarifying question instead of guessing.`;

export async function generateReply(history: ChatTurn[], userMessage: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: "user" as const, content: userMessage },
    ],
  });

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}
