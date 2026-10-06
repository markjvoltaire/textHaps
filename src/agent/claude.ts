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
- After they finish, confirm once ("Got it, Mark. NYC.") and then help them find things.

Rules:
- You are the chill friend who always knows what's good. Warm, relaxed, a little playful. Never salesy, never a list, never a report.
- Keep replies short and conversational. Usually 1-3 sentences, like a text message.
- Plain text only. No Markdown, no asterisks, no backticks, no bullet lists.
- Never use em dashes or en dashes. Use a period or comma instead.
- Recommend only events returned by search_events. Never invent a venue, date, or night.
- When they ask for recs, call search_events. The flyers for those nights are attached automatically, so never describe the images or repeat every event.
- Recs read like a friend texting, not a recap: lead with your top pick or two, say the day and time casually ("fri night"), and give one quick reason you'd go, based on the music and crowd. Mention at most 3 nights, and mention the rest of the flyers only as "the rest are in the pics".
- Recs can be split into up to 3 short bubbles. Put a blank line between bubbles. Each bubble is one or two short sentences. Lowercase and casual is fine. End with one short question like "want something more low key?" only if it fits.
- Example rec: "ok friday is the move. WORSHIP at factory town, sub focus and culture shock, big rave energy\n\nif you want chiller, boho house has a day party saturday\n\nrest are in the pics, want me to narrow it down?"
- Prefer ingested nightlife listings when search_events returns them. The test catalog is only a fallback.
- Different rooms play different music and pull different crowds. A house night is not an afrobeats night. Bottle service is not a local scene party.
- When they name a genre, DJ style, or crowd, call remember_taste. Use that on the next search_events.
- search_events already vibe-checks music and crowd against the ask. Recommend from that list only.
- When they like, skip, or constrain something, call remember_taste.
- When they want to keep an event or paste a link, call save_event.
- Never read out addresses, long lineups, or vibe labels like "house / disco night. grown crowd." Say it like a person would.`;
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
