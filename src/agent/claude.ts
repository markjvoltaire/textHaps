import Anthropic from "@anthropic-ai/sdk";
import { startObservation } from "@langfuse/tracing";
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

/** Anthropic-hosted web search for places (bars, restaurants). Parties stay on search_events. */
function webSearchTool(profile: Profile): Anthropic.WebSearchTool20260209 {
  return {
    type: "web_search_20260209",
    name: "web_search",
    max_uses: 3,
    ...(profile.city && {
      user_location: { type: "approximate", city: profile.city, country: "US", timezone: "America/New_York" },
    }),
  };
}

function buildSystemPrompt(profile: Profile, taste: TasteSignal[], saves: SaveRow[]): string {
  const tasteLines =
    taste.length === 0
      ? "None yet."
      : taste.map((signal) => `- ${signal.kind}: ${signal.label}`).join("\n");
  const saveLines =
    saves.length === 0 ? "None yet." : saves.map((save) => `- ${formatSave(save)}`).join("\n");
  const nextField = nextOnboardingField(profile, taste);
  const onboarded = isOnboarded(profile, taste);

  return `You are Haps, an event discovery assistant that texts over iMessage.

Today's date is ${new Date().toISOString().split("T")[0]}.
Onboarding: ${onboarded ? "complete" : `incomplete, still need ${nextField}`}.
Name: ${profile.name ?? "unknown"}.
City: ${profile.city ?? "unknown"}.

Known taste:
${tasteLines}

Saved:
${saveLines}

Two ways to find things:
- Parties, club nights, raves, and other events: call search_events. Recommend only events it returns. Never invent an event or date. Wait to call it until you know at least one thing they like and their city.
- Places that aren't parties, like wine bars, bars, restaurants, cafes, or brunch spots: call web_search in their city. Never use search_events for these. Recommend only places the results back up, and don't make up hours or details. If you don't know their city, ask first.
- You can always look up places with web_search, even if earlier messages in the chat said you couldn't.

Other tools:
- When they share a like, dislike, or constraint, call remember_taste.
- When they mention their city or name, call update_profile.
- When they want to keep an event or send a link, call save_event.
- Flyers for searched events are attached as photos automatically. Don't describe the images.
- Don't say you're searching. Just answer.

How you text:
- all lowercase, including "i"
- no periods. line breaks end each thought
- one short thought per line. each line goes out as its own text
- send 1-3 short lines at a time, never a wall of text. only the first 3 lines get sent, so for recs pick your top 2 or 3, one per line
- use slang like "lol", "rn", "ngl", "lowkey", "fr" sometimes, not every message
- keep question marks when asking something
- emojis rarely, only if they add something
- no markdown, bullet points, bold, or headers. this is imessage

Never say:
- "how can i help you today?"
- "certainly!", "absolutely!", "great question!"
- "as an ai..."
- anything that sounds like customer service or a press release`;
}

/**
 * The reply text. Web search answers come back split into many text blocks at
 * citation boundaries, so only text after the last search result counts (that
 * drops any "let me look" preamble) and the pieces are joined back together.
 */
function textFrom(content: Anthropic.ContentBlock[]): string {
  const lastSearch = content.findLastIndex((block) => block.type === "web_search_tool_result");
  return content
    .slice(lastSearch + 1)
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
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
    const system = buildSystemPrompt(input.profile, input.taste, input.saves);
    const generation = startObservation(
      "claude",
      { model: MODEL, input: { system, messages: structuredClone(messages) } },
      { asType: "generation" },
    );
    let response: Anthropic.Message;
    try {
      response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system,
        tools: [...HAPS_TOOLS, webSearchTool(input.profile)],
        messages,
      });
    } catch (err) {
      generation.update({ level: "ERROR", statusMessage: err instanceof Error ? err.message : String(err) }).end();
      throw err;
    }
    generation
      .update({
        output: response.content,
        usageDetails: { input: response.usage.input_tokens, output: response.usage.output_tokens },
        metadata: { stop_reason: response.stop_reason, web_searches: response.usage.server_tool_use?.web_search_requests ?? 0 },
      })
      .end();

    for (const block of response.content) {
      if (block.type === "server_tool_use") console.log(`[tool] ${block.name} ${JSON.stringify(block.input)}`);
    }

    // A long web search can pause mid-turn. Sending the turn back resumes it.
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

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
      const tool = startObservation(block.name, { input: args }, { asType: "tool" });
      try {
        const result = await runTool(input.profile, block.name, args, session);
        console.log(`[tool] ${block.name} ok`);
        tool.update({ output: result }).end();
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[tool] ${block.name} failed:`, msg);
        tool.update({ level: "ERROR", statusMessage: msg }).end();
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
