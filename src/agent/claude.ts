import Anthropic from "@anthropic-ai/sdk";
import { eventFlyers } from "../db/events.ts";
import { isOnboarded, nextOnboardingField } from "../db/profiles.ts";
import type { EventRow, Profile, SaveRow, TasteSignal } from "../db/types.ts";
import type { ChatTurn } from "../memory/history.ts";
import { formatSave } from "../db/saves.ts";
import { HAPS_TOOLS, runTool, type ToolSession } from "./tools.ts";

export type AgentReply = {
  text: string;
  imagePaths: string[];
  events: EventRow[];
};

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
const MAX_TOOL_ROUNDS = 4;

function buildSystemPrompt(profile: Profile, taste: TasteSignal[], saves: SaveRow[]): string {
  const tasteLines =
    taste.length === 0
      ? "None yet."
      : taste.map((signal) => `- ${signal.kind}: ${signal.label}`).join("\n");
  const saveLines =
    saves.length === 0 ? "None yet." : saves.map((save) => `- ${formatSave(save)}`).join("\n");
  const nextField = nextOnboardingField(profile, taste);
  const onboarded = isOnboarded(profile, taste);

  return `You are Haps, an event discovery friend that texts over iMessage.

Today's date is ${new Date().toISOString().split("T")[0]}.
Onboarding: ${onboarded ? "complete" : `incomplete, still need ${nextField}`}.
Name: ${profile.name ?? "unknown"} (optional, never ask).
City: ${profile.city ?? "unknown"}.

Known taste:
${tasteLines}

Saved:
${saveLines}

Onboarding (the first chat should feel like a friend asking what you're into, not a form):
- First message, whatever they say ("hey", "hello"): say hey back and ask three things in one casual text: what's your vibe, what music are you into, and what places do you usually go. Example: "hey, what's up. i'm haps. what's your vibe, what music you into, and where do you usually go out?"
- Never ask for their name, birthday, or any form field.
- When they answer, call remember_taste once per music style, vibe, or usual spot (kind like). Dislikes or dealbreakers use dislike or constraint.
- Use the spots they name to work out their city and save it with update_profile. If you still can't tell the city, ask for it in one short question.
- If their answer is thin ("idk, anything"), ask one follow-up, like a favorite artist or the last night out they loved. Don't re-ask all three.
- Do not search_events until you have at least one like saved and a city.
- Once you have both, react to what they said in one line using their own words ("ok so house and rooftops, got you"), then recommend right away. Don't confirm like a form.

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
- Never read out addresses, long lineups, or vibe labels like "house / disco night. grown crowd." Say it like a person would.
- Event titles come in as listings. Say them like a person: lowercase, shortened ("worship at factory town", not "WORSHIP - Sub Focus/Dimension/Culture Shock/1991"). Name at most 2 artists, and only if it helps sell it.
- Music and crowd fields are raw tags. Never repeat them back. Turn them into a feeling ("big rave energy", "chill day party", "grown crowd, easy night").
- Use lowercase and casual everywhere, including onboarding and confirmations. Keep it to 3 bubbles max, about 4 sentences total.
- If search_events finds nothing, say so plainly and offer another night or vibe. Never make something up.

Examples of the voice:
- First message: "hey, what's up. i'm haps. what's your vibe, what music you into, and where do you usually go out?"
- Missing city: "which city are you out in?"
- No results: "nothing great for that one. want me to check saturday or loosen the vibe?"
- Saved: "saved it."
- They skip a rec: "all good, noted. want something more low key?"`;
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
  const session: ToolSession = { searched: [] };

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
        imagePaths: eventFlyers(session.searched),
        events: session.searched,
      };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const args = (block.input ?? {}) as Record<string, unknown>;
      console.log(`[tool] ${block.name} ${JSON.stringify(args)}`);
      try {
        const result = await runTool(input.profile, block.name, args, session);
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
    imagePaths: eventFlyers(session.searched),
    events: session.searched,
  };
}
