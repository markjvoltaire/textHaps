import Anthropic from "@anthropic-ai/sdk";
import { listEventFlyers } from "../db/events.ts";
import { isOnboarded, nextOnboardingField } from "../db/profiles.ts";
import type { Profile, SaveRow, TasteSignal } from "../db/types.ts";
import type { ChatTurn } from "../memory/history.ts";
import { formatSave } from "../db/saves.ts";
import { HAPS_TOOLS, runTool } from "./tools.ts";

export type AgentReply = {
  text: string;
  imagePaths: string[];
};

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
const MAX_TOOL_ROUNDS = 4;

function buildSystemPrompt(profile: Profile, taste: TasteSignal[], saves: SaveRow[]): string {
  const tasteLines =
    taste.length === 0
      ? "None yet."
      : taste.map((signal) => `- ${signal.kind}: ${signal.label}`).join("\n");
  const saveLines =
    saves.length === 0 ? "None yet." : saves.map((save) => `- ${formatSave(save)}`).join("\n");
  const nextField = nextOnboardingField(profile);
  const onboarded = isOnboarded(profile);

  return `You are Haps, an event discovery friend that texts over iMessage.

Today's date is ${new Date().toISOString().split("T")[0]}.
Onboarding: ${onboarded ? "complete" : `incomplete, ask only for ${nextField}`}.
Name: ${profile.name ?? "unknown"}.
City: ${profile.city ?? "unknown"}.

Known taste:
${tasteLines}

Saved:
${saveLines}

Onboarding:
- New users must give their name and city before any recommendations.
- Ask one field at a time, in this order: name, then city. Never ask for both in the same message.
- Do not ask for a birthday or date of birth.
- First message: introduce yourself in one short line, then ask only for their name.
- After they give a name, save it with update_profile, then ask only what city they are in.
- If they volunteer their city early, save it, then still ask the next missing field by itself.
- Do not search_events until onboarding is complete.
- After they finish, confirm once ("Got it, Mark — NYC") and then help them find things.

Rules:
- Keep replies short and conversational — usually 1-3 sentences, like a text message.
- Plain text only. No Markdown, no asterisks, no backticks, no bullet lists.
- Recommend only events returned by search_events. Never invent a venue, date, or night.
- The test catalog is small and mixed-city on purpose. Always recommend those events. Never say you found nothing, nothing nearby, or that their city is empty.
- When they ask for recs, call search_events. The app sends Here's what I found plus the flyer album. Do not write a recap.
- When they like, skip, or constrain something, call remember_taste.
- When they want to keep an event or paste a link, call save_event.
- Keep the text short and do not describe the images.`;
}

function textFrom(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export async function generateReply(input: {
  profile: Profile;
  taste: TasteSignal[];
  saves: SaveRow[];
  history: ChatTurn[];
  userMessage: string;
}): Promise<AgentReply> {
  const messages: Anthropic.MessageParam[] = [
    ...input.history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user" as const, content: input.userMessage },
  ];
  let searchedEvents = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(input.profile, input.taste, input.saves),
      tools: HAPS_TOOLS,
      messages,
    });

    if (response.stop_reason !== "tool_use") {
      return {
        text: textFrom(response.content),
        imagePaths: searchedEvents ? await listEventFlyers() : [],
      };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const args = (block.input ?? {}) as Record<string, unknown>;
      if (block.name === "search_events") searchedEvents = true;
      console.log(`[tool] ${block.name} ${JSON.stringify(args)}`);
      try {
        const result = await runTool(input.profile, block.name, args);
        console.log(`[tool] ${block.name} ok`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[tool] ${block.name} failed:`, msg);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          is_error: true,
          content: msg,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  return {
    text: "",
    imagePaths: searchedEvents ? await listEventFlyers() : [],
  };
}
