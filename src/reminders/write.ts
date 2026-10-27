import Anthropic from "@anthropic-ai/sdk";
import { startObservation } from "@langfuse/tracing";
import type { Profile, SaveRow } from "../db/types.ts";
import type { ChatTurn } from "../memory/history.ts";
import { stripLinks } from "../agent/links.ts";
import { formatError } from "../utils/text.ts";
import type { ReminderKind } from "./schedule.ts";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";

const TASKS: Record<ReminderKind, string> = {
  check_in:
    "They saved this event a while back and it's in two days. Text them first: bring it back up like a friend would (\"yo that MOVE party at tomorrowland is saturday\") and ask if they're still thinking about going. Don't push.",
  day_of:
    "This event they saved is coming up (today, or tomorrow morning if it starts early). Give them a quick heads-up with when and where, like a friend would. If they already said they're going, hype it a little; if they never said, ask if they're still going.",
};

const STYLE = `You are Haps, a friend who knows the scene, texting over iMessage. You're texting first, unprompted, about an event they saved.
- all lowercase, including "i". no periods. one short thought per line, 1-2 lines total
- say when and where the way a friend would, in a sentence, not a list. use the day name ("saturday") and the time if you know it
- no links, no emojis unless they add something, no markdown
- never say you're a reminder, a bot, or that this is automated. never mention saving, tools, or apps
- don't recite their tastes back to them, and don't pitch anything else`;

function when(save: SaveRow, zone: string): string {
  const options: Intl.DateTimeFormatOptions = { timeZone: zone, weekday: "long", month: "long", day: "numeric" };
  if (save.starts_at) {
    return new Intl.DateTimeFormat("en-US", { ...options, hour: "numeric", minute: "2-digit" }).format(new Date(save.starts_at));
  }
  if (!save.event_date) return "date unknown";
  // A bare date, read at noon UTC so no zone moves it to another day.
  const day = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(new Date(`${save.event_date}T12:00:00Z`));
  return `${day}, start time unknown`;
}

/** The fallback when Claude can't write it, so a reminder still goes out on time. */
function plain(save: SaveRow, kind: ReminderKind, zone: string): string {
  const name = save.title ?? "that event you saved";
  const day = when(save, zone).split(",")[0]!.toLowerCase();
  return kind === "check_in"
    ? `yo ${name} is ${day}\nyou still thinking about going?`
    : `heads up, ${name} is ${day === "date unknown" ? "coming up" : `${day}`}${save.venue ? ` at ${save.venue.toLowerCase()}` : ""}`;
}

/** The text for one reminder, in Haps's voice, with the last few turns so it fits the thread. */
export async function writeReminder(input: {
  profile: Profile;
  save: SaveRow;
  kind: ReminderKind;
  zone: string;
  history: ChatTurn[];
}): Promise<string> {
  const { profile, save, kind, zone } = input;
  const recent = input.history
    .slice(-6)
    .map((turn) => `${turn.role === "user" ? "them" : "you"}: ${turn.content}`)
    .join("\n");
  const content = [
    TASKS[kind],
    "",
    `Event: ${save.title ?? "untitled"}`,
    `When: ${when(save, zone)}`,
    save.venue && `Where: ${save.venue}`,
    save.note && `Their note: ${save.note}`,
    profile.name && `Their name: ${profile.name}`,
    "",
    "Your last few texts with them, oldest first:",
    recent || "(none)",
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");

  const generation = startObservation("reminder", { model: MODEL, input: { system: STYLE, content } }, { asType: "generation" });
  try {
    const response = await anthropic.messages.create(
      { model: MODEL, max_tokens: 300, system: STYLE, messages: [{ role: "user", content }] },
      { timeout: 20_000, maxRetries: 1 },
    );
    generation.update({ output: response.content }).end();
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    // Titles and notes came from web pages, so nothing they planted goes out as a link.
    const lines = stripLinks(text)
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 2);
    return lines.length ? lines.join("\n") : plain(save, kind, zone);
  } catch (err) {
    generation.update({ level: "ERROR", statusMessage: formatError(err) }).end();
    console.warn(`[remind] writing failed, sending the plain one: ${formatError(err)}`);
    return plain(save, kind, zone);
  }
}
