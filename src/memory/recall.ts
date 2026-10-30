import { getSupabase } from "../db/client.ts";
import { stripLinks } from "../agent/links.ts";
import { embedDocument, embedQuery } from "../search/embed.ts";
import { CURATED_RECS_ON } from "../search/recs.ts";
import { MAX_TURNS } from "./history.ts";
import { withoutPhotoText } from "./photoText.ts";

/** Same as LINKS_NOTE in agent/claude.ts: a history-only note listing unsent links, never something they saw. */
const LINKS_NOTE = "(links for what i mentioned, not sent:";
/** "ok", "lol", "yes": too short to mean anything on their own, so not worth finding again. */
const MIN_CHARS = 12;
/** How much of each side is embedded and recalled. A long rant still gets found by its start. */
const MAX_SIDE = 600;
/** Older exchanges brought back per message. More starts to pull Claude off what they just asked. */
const RECALL_COUNT = 5;
/**
 * Cosine distance past which an old exchange isn't really about this message. On Haps's own chats,
 * related asks ("place to eat" / "i'm feeling palma") came in at 0.40-0.55 and unrelated ones at 0.70+.
 */
const MAX_DISTANCE = 0.55;
/**
 * Sign-in details, codes, passwords, emails and phone numbers, the kind the old RSVP flow asked for.
 * Never embedded, so they can't be recalled into a later prompt (the profile already keeps the email).
 * A bare 4-8 digit message is a code.
 */
const SENSITIVE =
  /\b(pass(word|code)|credentials?|log ?in|sign[- ]?in|otp|verification code|security code|cvv|card number)\b|^\W*\d{4,8}\W*$|[^\s@]+@[^\s@]+\.[a-z]{2,}|\+?\d[\d\s().-]{8,}\d/i;

export type Recalled = { content: string; reply: string; at: string };

/** One side of an exchange as stored for search: no flyer text, no links, no links note. */
function clean(text: string): string {
  const kept = withoutPhotoText(text)
    .split("\n")
    .filter((line) => !line.trim().toLowerCase().startsWith(LINKS_NOTE))
    .join("\n");
  return stripLinks(kept).replace(/\s+/g, " ").trim().slice(0, MAX_SIDE);
}

/** What gets embedded for an exchange, or null when what they said is too short to find again. */
export function exchangeText(user: string, reply: string): string | null {
  // Checked before links are stripped, which would cut an email's domain off.
  if (SENSITIVE.test(withoutPhotoText(user))) return null;
  const said = clean(user);
  if (said.length < MIN_CHARS) return null;
  return `them: ${said}\nhaps: ${clean(reply)}`;
}

/**
 * Embeds an exchange on its user turn, so it can be recalled later. The embedding model only runs
 * when curated recs are on (the 512 MB worker can't hold it otherwise); off, turns are left for
 * the backfill. Marked done either way, so a too-short turn isn't retried forever.
 */
export async function embedExchange(turnId: string, user: string, reply: string): Promise<void> {
  if (!CURATED_RECS_ON) return;
  const text = exchangeText(user, reply);
  const embedding = text ? await embedDocument(text) : null;
  const { error } = await getSupabase()
    .from("chat_turns")
    .update({ embedding: embedding ? JSON.stringify(embedding) : null, embedded_at: new Date().toISOString() })
    .eq("id", turnId);
  if (error) throw error;
}

/**
 * Their older exchanges that mean the same as this message, beyond the turns already in history,
 * oldest first. Only this profile's turns. Empty when recs are off or the message is too short.
 */
export async function recallExchanges(profileId: string, message: string): Promise<Recalled[]> {
  if (!CURATED_RECS_ON) return [];
  const asked = clean(message);
  if (asked.length < MIN_CHARS) return [];
  const { data, error } = await getSupabase().rpc("match_chat_turns", {
    match_profile: profileId,
    query_embedding: JSON.stringify(await embedQuery(asked)),
    skip_recent: MAX_TURNS,
    match_count: RECALL_COUNT,
  });
  if (error) throw error;
  return ((data ?? []) as { content: string; reply: string | null; created_at: string; distance: number }[])
    .filter((row) => row.distance <= MAX_DISTANCE)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((row) => ({ content: clean(row.content), reply: clean(row.reply ?? ""), at: row.created_at }));
}
