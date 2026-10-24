import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { jevNoulScores } from "../jev/client.ts";
import { searchEventPages } from "../search/exa.ts";
import {
  searchTikTokVideos,
  tiktokComments,
  tiktokProfile,
  type TikTokComment,
  type TikTokProfile,
  type TikTokVideo,
} from "../search/monid.ts";

/**
 * Dev tool: find parties for a genre in a city, check each against its TikTok account, and rank them.
 * Usage: npm run verify -- afrobeats Miami [--verbose]
 */

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_EVENT_MODEL ?? "claude-haiku-5-5";

const DAY_MS = 24 * 60 * 60 * 1000;
// Pages older than this are mostly past nights, which is what made the dateless search stale.
const LISTING_SINCE_DAYS = 45;
const MAX_PARTIES = 12;
// Generous: this runs in a terminal, not while someone waits on a text.
const MONID_DEADLINE_MS = 20000;

type Candidate = { id: number; source: "listing" | "tiktok"; url: string; title: string; text: string; author?: string };

type Party = {
  name: string;
  organizer: string | null;
  next_date: string | null;
  recurring: string | null;
  venue: string | null;
  tiktok_handle: string | null;
  candidate_ids: number[];
};

type Evidence = {
  party: Party;
  listings: Candidate[];
  profile: TikTokProfile | null;
  ownPosts: TikTokVideo[];
  mentions: TikTokVideo[];
  comments: TikTokComment[];
};

type Scores = { real: number; venue: number; credible: number; crowd: number; flags: number };

type Verdict = "verified" | "unverified" | "problem";

const PARTY_SCHEMA = {
  type: "object",
  properties: {
    parties: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          organizer: { type: ["string", "null"] },
          next_date: { type: ["string", "null"], description: "YYYY-MM-DD of the next upcoming date, or null" },
          recurring: { type: ["string", "null"], description: "e.g. weekly Saturdays, monthly; null for one-offs" },
          venue: { type: ["string", "null"] },
          tiktok_handle: { type: ["string", "null"], description: "Author handle of a TikTok candidate posted by the party itself" },
          candidate_ids: { type: "array", items: { type: "integer" } },
        },
        required: ["name", "organizer", "next_date", "recurring", "venue", "tiktok_handle", "candidate_ids"],
        additionalProperties: false,
      },
    },
  },
  required: ["parties"],
  additionalProperties: false,
};

const NOTES_SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          name: { type: "string" },
          next_date: { type: ["string", "null"] },
          recurring: { type: ["string", "null"] },
          venue: { type: ["string", "null"] },
          note: { type: "string" },
        },
        required: ["index", "name", "next_date", "recurring", "venue", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["notes"],
  additionalProperties: false,
};

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const today = () => new Date().toISOString().slice(0, 10);

// Words that show up in many party names, so they can't tie an account to one party ("afro" matched @afroeventsmiami).
const GENERIC = new Set([
  "the", "party", "night", "nights", "presents", "edition", "friends", "experience", "ultimate", "with", "and",
  "afro", "afrobeat", "afrobeats", "amapiano", "house", "vibes", "events", "social", "club", "lounge",
  "mondays", "tuesdays", "wednesdays", "thursdays", "fridays", "saturdays", "sundays", "weekly",
]);

function nameWords(name: string, city: string): string[] {
  const place = slug(city);
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !GENERIC.has(word) && word !== place);
}

async function collectCandidates(genre: string, city: string): Promise<Candidate[]> {
  const since = new Date(Date.now() - LISTING_SINCE_DAYS * DAY_MS);
  // No date words: they outweigh the genre and bring back the wrong music (see the Oct 24–25 test).
  // One query of each missed known-good parties on some runs, so cast a few and dedupe.
  const listingQueries = [`${genre} events in ${city}`, `${genre} party ${city}`];
  const tiktokQueries = [`${genre} party ${city}`, `${genre} ${city}`, `${genre} ${city} nightlife`];
  const settled = await Promise.allSettled([
    ...listingQueries.map((query) => searchEventPages(query, since)),
    ...tiktokQueries.map((query) => searchTikTokVideos(query, MONID_DEADLINE_MS, { limit: 15 })),
  ]);
  const results = settled.map((result) => (result.status === "fulfilled" ? result.value : []));
  const dedupe = <T extends { url: string }>(lists: T[][]) => [...new Map(lists.flat().map((item) => [item.url, item])).values()];
  const pages = dedupe(results.slice(0, listingQueries.length) as Awaited<ReturnType<typeof searchEventPages>>[]);
  const videos = dedupe(results.slice(listingQueries.length) as TikTokVideo[][]);
  const candidates: Candidate[] = [];
  for (const page of pages) {
    candidates.push({
      id: candidates.length,
      source: "listing",
      url: page.url,
      title: page.title,
      text: page.highlights.join(" ").replace(/\s+/g, " ").slice(0, 500),
    });
  }
  for (const video of videos) {
    candidates.push({
      id: candidates.length,
      source: "tiktok",
      url: video.url,
      title: `@${video.author} (posted ${video.posted.slice(0, 10)})`,
      text: video.caption,
      author: video.author,
    });
  }
  return candidates;
}

async function askJson<T>(system: string, input: string, schema: Record<string, unknown>): Promise<T> {
  const response = await anthropic.messages.create(
    {
      model: MODEL,
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: input }],
      output_config: { effort: "low", format: { type: "json_schema", schema } },
    },
    { timeout: 30000 },
  );
  if (response.stop_reason === "max_tokens" || response.stop_reason === "refusal") {
    throw new Error(`haiku ended with ${response.stop_reason}`);
  }
  const block = response.content.find((item): item is Anthropic.TextBlock => item.type === "text");
  return JSON.parse(block?.text ?? "{}") as T;
}

/** Haiku reads every result and groups them into parties, dropping ads, vendors, and other cities. */
async function groupParties(candidates: Candidate[], genre: string, city: string): Promise<Party[]> {
  const system = `Today is ${today()}. You sort search results about ${genre} nights out in ${city}. Group results that are the same party (same name or organizer, any edition) into one entry. Keep only parties someone could go to in or near ${city}: a one-off whose date hasn't passed, or a recurring series even if this result shows a past edition. Drop ads, rentals, vendors, DJ mixes, recaps with no party behind them, and other cities. Use only facts in the results.`;
  const input = candidates
    .map((candidate) => `[${candidate.id}] ${candidate.source} · ${candidate.title}\n${candidate.url}\n${candidate.text}`)
    .join("\n\n");
  const { parties } = await askJson<{ parties: Party[] }>(system, input, PARTY_SCHEMA);
  return (parties ?? []).slice(0, MAX_PARTIES);
}

/** The party's own TikTok account plus other people's posts about it. Null when no account clearly matches. */
async function findAccount(
  party: Party,
  city: string,
  candidates: Candidate[],
): Promise<{ handle: string; ownPosts: TikTokVideo[]; mentions: TikTokVideo[] } | null> {
  const words = nameWords(party.name, city);
  const place = slug(city);
  const venue = party.venue ? slug(party.venue) : "";
  const videos = await searchTikTokVideos(`${party.name} ${city}`, MONID_DEADLINE_MS, { days: 180, limit: 20 });
  const mentionsCity = (text: string) => slug(text).includes(place) || (!!venue && slug(text).includes(venue));

  // A handle counts only if it carries the party's name and its posts are about this city, so AFROSOCIAL UK can't pass for Miami.
  const authors = [party.tiktok_handle, ...videos.map((video) => video.author)].filter((handle): handle is string => !!handle);
  if (words.length === 0) return null;
  const handle = [...new Set(authors)].find((author) => {
    if (!words.some((word) => slug(author).includes(word))) return false;
    const posts = videos.filter((video) => video.author === author);
    const ownCandidate = candidates.some((candidate) => candidate.author === author);
    return ownCandidate || slug(author).includes(place) || posts.some((post) => mentionsCity(post.caption));
  });
  if (!handle) return null;

  const ownPosts = videos.filter((video) => video.author === handle).sort((a, b) => b.posted.localeCompare(a.posted));
  const mentions = videos.filter(
    (video) => video.author !== handle && words.some((word) => slug(video.caption).includes(word)) && mentionsCity(video.caption),
  );
  return { handle, ownPosts, mentions };
}

async function gatherEvidence(party: Party, city: string, candidates: Candidate[]): Promise<Evidence> {
  const listings = party.candidate_ids.map((id) => candidates[id]).filter((candidate): candidate is Candidate => !!candidate);
  const empty = { party, listings, profile: null, ownPosts: [], mentions: [], comments: [] };
  let account: Awaited<ReturnType<typeof findAccount>>;
  try {
    account = await findAccount(party, city, candidates);
  } catch (err) {
    console.warn(`[verify] tiktok search failed for ${party.name}: ${err instanceof Error ? err.message : String(err)}`);
    return empty;
  }
  if (!account) return empty;

  // Comments on the latest posts that have any, since that's where people ask about the venue or complain.
  const commented = account.ownPosts.filter((post) => post.comments > 0).slice(0, 2);
  const [profile, ...commentPages] = await Promise.all([
    tiktokProfile(account.handle, MONID_DEADLINE_MS).catch(() => null),
    ...commented.map((post) => tiktokComments(post.url, MONID_DEADLINE_MS).catch(() => [])),
  ]);
  return { ...empty, profile, ownPosts: account.ownPosts, mentions: account.mentions, comments: commentPages.flat() };
}

function describe(evidence: Evidence): string {
  const { party, listings, profile, ownPosts, mentions, comments } = evidence;
  const lines = [
    `Party: ${party.name}. Organizer: ${party.organizer ?? "unknown"}. Next date: ${party.next_date ?? "unknown"}. Recurring: ${party.recurring ?? "no"}. Listed venue: ${party.venue ?? "unknown"}.`,
    "Listings:",
    ...listings.map((listing) => `- ${listing.title}: ${listing.text.slice(0, 240)}`),
  ];
  if (profile) {
    lines.push(
      `TikTok account @${profile.handle}: ${profile.followers} followers, ${profile.likes} likes, ${profile.videos} videos, since ${profile.since}. Bio: ${profile.bio || "(empty)"}. Link: ${profile.link ?? "none"}.`,
      "Account's recent posts:",
      ...ownPosts.slice(0, 4).map((post) => `- ${post.posted.slice(0, 10)}: ${post.caption.slice(0, 220)}`),
    );
  } else {
    lines.push("TikTok account: none found for this party in this city.");
  }
  if (mentions.length > 0) {
    lines.push("Other people's posts:", ...mentions.slice(0, 4).map((post) => `- @${post.author} ${post.posted.slice(0, 10)}: ${post.caption.slice(0, 160)}`));
  }
  if (comments.length > 0) {
    lines.push("Comments:", ...comments.slice(0, 15).map((comment) => `- "${comment.text.slice(0, 140)}" (${comment.likes} likes)`));
  }
  return lines.join("\n");
}

/** Jev answers five 0–1 questions about one party from its evidence. */
async function scoreParty(evidence: Evidence, city: string): Promise<Scores> {
  const blurb = describe(evidence);
  const ask = (instructions: string) => ({ type: "noul" as const, instructions: `${instructions}\n\n${blurb}` });
  try {
    const scores = await jevNoulScores(
      `Verify nightlife recommendations in ${city} before they're sent to someone. Today is ${today()}. Judge only from the evidence given.`,
      {
        real: ask(`Is this a real party that is still happening in or near ${city}, with an upcoming date or a recurring night the account still promotes?`),
        venue: ask("Do the listings and the TikTok posts agree on where it happens? Score low if the account now names a different venue than the listing. Score 0.5 if there isn't enough to tell."),
        credible: ask("Is the organizer credible: an account that has posted for a while, posts about this party regularly, and links to tickets or RSVP?"),
        crowd: ask("Do people who went or plan to go speak well of it (packed, a vibe, can't wait)? Score 0.5 when there are no comments."),
        flags: ask("Are there red flags: complaints, scam or cancellation talk, broken ticket links, venue not announced, or posts that are really for another city?"),
      },
    );
    return { real: scores.real ?? 0, venue: scores.venue ?? 0.5, credible: scores.credible ?? 0, crowd: scores.crowd ?? 0.5, flags: scores.flags ?? 0 };
  } catch (err) {
    console.warn(`[verify] jev failed for ${evidence.party.name}: ${err instanceof Error ? err.message : String(err)}`);
    return { real: 0, venue: 0.5, credible: 0, crowd: 0.5, flags: 0 };
  }
}

function judge(evidence: Evidence, scores: Scores): { verdict: Verdict; score: number } {
  const score = 0.35 * scores.real + 0.25 * scores.credible + 0.25 * scores.crowd + 0.15 * scores.venue;
  // No account means nothing confirmed it, not that it's fake.
  if (!evidence.profile) return { verdict: "unverified", score: score * 0.6 };
  if (scores.flags >= 0.5 || scores.venue < 0.4) return { verdict: "problem", score };
  if (scores.real >= 0.6 && scores.credible >= 0.5) return { verdict: "verified", score };
  return { verdict: "unverified", score };
}

type Refined = { name: string; next_date: string | null; recurring: string | null; venue: string | null; note: string };

/**
 * Re-read each party from all its evidence. The grouping step only saw search results, but the account's bio and
 * latest posts hold the real schedule ("Saturday is for the Shrine", "11/7 — MIAMI"), so they win.
 */
async function refineParties(evidence: Evidence[], city: string): Promise<string[]> {
  const system = `Today is ${today()}. For each party, use all its evidence, trusting the TikTok bio and newest posts over older listings. Give: its usual name (the series, not one edition, e.g. "Stamped" not "Ghana Independence Day poolside party"); the next date in ${city} on or after today as YYYY-MM-DD, or null; how it repeats (e.g. "weekly Saturdays"), or null; the current venue, or null; and one short note (under 120 characters) for someone deciding whether to recommend it: what TikTok confirms and any problem worth telling the user, like a venue change, a broken ticket link, an unannounced venue, or no account found. Facts from the evidence only.`;
  const input = evidence.map((item, index) => `#${index}\n${describe(item)}`).join("\n\n");
  try {
    const { notes } = await askJson<{ notes: (Refined & { index: number })[] }>(system, input, NOTES_SCHEMA);
    return evidence.map((item, index) => {
      const refined = notes?.find((note) => note.index === index);
      if (!refined) return "";
      Object.assign(item.party, {
        name: refined.name || item.party.name,
        next_date: refined.next_date,
        recurring: refined.recurring,
        venue: refined.venue ?? item.party.venue,
      });
      return refined.note;
    });
  } catch (err) {
    console.warn(`[verify] refine failed: ${err instanceof Error ? err.message : String(err)}`);
    return evidence.map(() => "");
  }
}

const ICON: Record<Verdict, string> = { verified: "✅ verified", unverified: "❓ unverified", problem: "⚠️ problem" };

export async function runVerify(genre: string, city: string, verbose = false): Promise<void> {
  const started = Date.now();
  const candidates = await collectCandidates(genre, city);
  console.log(`[verify] ${candidates.length} results (${candidates.filter((c) => c.source === "listing").length} listings, ${candidates.filter((c) => c.source === "tiktok").length} tiktok)`);

  const parties = await groupParties(candidates, genre, city);
  console.log(`[verify] ${parties.length} parties: ${parties.map((party) => party.name).join(", ")}`);

  const evidence = await Promise.all(parties.map((party) => gatherEvidence(party, city, candidates)));
  // Refine first so Jev scores the schedule the account actually posts, not the one an old listing showed.
  const notes = await refineParties(evidence, city);
  const scores = await Promise.all(evidence.map((item) => scoreParty(item, city)));

  const rows = evidence
    .map((item, index) => ({ item, scores: scores[index]!, note: notes[index]!, ...judge(item, scores[index]!) }))
    .sort((a, b) => b.score - a.score);

  console.log(`\n#  ${"PARTY".padEnd(26)} ${"NEXT".padEnd(18)} ${"VERDICT".padEnd(14)} SCORE  NOTES`);
  rows.forEach((row, index) => {
    const party = row.item.party;
    const next = (party.recurring ?? party.next_date ?? "?").slice(0, 18);
    const account = row.item.profile ? ` @${row.item.profile.handle}` : "";
    console.log(
      `${String(index + 1).padEnd(2)} ${party.name.slice(0, 26).padEnd(26)} ${next.padEnd(18)} ${ICON[row.verdict].padEnd(14)} ${row.score.toFixed(2).padEnd(6)} ${row.note}${account}`,
    );
    if (verbose) {
      const s = row.scores;
      console.log(`   real ${s.real.toFixed(2)} · venue ${s.venue.toFixed(2)} · credible ${s.credible.toFixed(2)} · crowd ${s.crowd.toFixed(2)} · flags ${s.flags.toFixed(2)}`);
      console.log(describe(row.item).replace(/^/gm, "   "));
      console.log("");
    }
  });
  console.log(`\n[verify] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

const isMain = process.argv[1]?.includes("verify/run");
if (isMain) {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const [genre, ...cityParts] = args.filter((arg) => !arg.startsWith("--"));
  const missing = ["EXA_API_KEY", "MONID_API_KEY", "JEV_API_KEY", "ANTHROPIC_API_KEY"].filter((key) => !process.env[key]);
  if (!genre || cityParts.length === 0) {
    console.error("usage: npm run verify -- <genre> <city> [--verbose]");
    process.exit(1);
  }
  if (missing.length > 0) {
    console.error(`[verify] missing ${missing.join(", ")} in .env`);
    process.exit(1);
  }
  try {
    await runVerify(genre, cityParts.join(" "), verbose);
    process.exit(0);
  } catch (err) {
    console.error(`[verify] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
