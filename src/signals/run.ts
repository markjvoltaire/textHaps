import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { jevNoulScores } from "../jev/client.ts";
import {
  searchInstagramHashtag,
  searchTikTokVideos,
  tiktokComments,
  tiktokProfile,
  type TikTokComment,
  type TikTokProfile,
  type TikTokVideo,
} from "../search/monid.ts";

/**
 * Dev tool: signal-based search. Find what people on TikTok and Instagram are posting about for an ask in a city
 * (a party, restaurant, bar, or activity), group the posts into spots, check each spot's own account and comments,
 * and have Jev vet the signal before anything would reach a user.
 * Usage: npm run signals -- "afrobeats party" Miami [--verbose]
 */

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_EVENT_MODEL ?? "claude-haiku-5-5";

// Generous: this runs in a terminal, not while someone waits on a text. Instagram's indexed search takes ~10s.
const MONID_DEADLINE_MS = 25000;
const MAX_SPOTS = 12;
// Deepening costs a TikTok search, a profile, and comments per spot, so only the strongest signals get it.
const MAX_DEEPENED = 10;

type Kind = "event" | "place" | "activity";

type Plan = { kind: Kind; tiktok_queries: string[]; instagram_hashtags: string[] };

type Post = {
  id: number;
  platform: "tiktok" | "instagram";
  url: string;
  author: string;
  posted: string;
  caption: string;
  likes: number;
  comments: number;
  location: string | null;
};

type Spot = {
  name: string;
  kind: Kind;
  tiktok_handle: string | null;
  instagram_handle: string | null;
  area: string | null;
  next_date: string | null;
  recurring: string | null;
  post_ids: number[];
};

type Signal = { posts: number; authors: number; independent: number; engagement: number; newest: string };

type Evidence = {
  spot: Spot;
  posts: Post[];
  signal: Signal;
  profile: TikTokProfile | null;
  ownPosts: TikTokVideo[];
  mentions: TikTokVideo[];
  comments: TikTokComment[];
};

type Scores = { real: number; fit: number; buzz: number; sentiment: number; flags: number };

type Verdict = "vetted" | "weak" | "problem";

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["event", "place", "activity"] },
    tiktok_queries: { type: "array", items: { type: "string" } },
    instagram_hashtags: { type: "array", items: { type: "string" } },
  },
  required: ["kind", "tiktok_queries", "instagram_hashtags"],
  additionalProperties: false,
};

const SPOT_SCHEMA = {
  type: "object",
  properties: {
    spots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          kind: { type: "string", enum: ["event", "place", "activity"] },
          tiktok_handle: { type: ["string", "null"], description: "Handle of a TikTok post author that is this spot's own account" },
          instagram_handle: { type: ["string", "null"], description: "Handle of an Instagram post author that is this spot's own account" },
          area: { type: ["string", "null"], description: "Venue, address, or neighborhood" },
          next_date: { type: ["string", "null"], description: "Events only: YYYY-MM-DD of the next date, or null" },
          recurring: { type: ["string", "null"], description: "Events only: e.g. weekly Saturdays; null otherwise" },
          post_ids: { type: "array", items: { type: "integer" } },
        },
        required: ["name", "kind", "tiktok_handle", "instagram_handle", "area", "next_date", "recurring", "post_ids"],
        additionalProperties: false,
      },
    },
  },
  required: ["spots"],
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
          area: { type: ["string", "null"] },
          next_date: { type: ["string", "null"] },
          recurring: { type: ["string", "null"] },
          note: { type: "string" },
        },
        required: ["index", "name", "area", "next_date", "recurring", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["notes"],
  additionalProperties: false,
};

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const today = () => new Date().toISOString().slice(0, 10);
// Cutting a caption mid-emoji leaves half a surrogate pair, which makes the request body invalid JSON.
const wellFormed = (text: string) => text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Words in many names, so they can't tie an account to one spot ("afro" matched @afroeventsmiami).
const GENERIC = new Set([
  "the", "party", "night", "nights", "presents", "edition", "friends", "experience", "ultimate", "with", "and",
  "afro", "afrobeat", "afrobeats", "amapiano", "house", "vibes", "events", "social", "club", "lounge", "rooftop",
  "beat", "beats", "studio", "class", "classes", "dance", "restaurant", "kitchen", "cafe", "coffee", "grill", "bistro", "cocktail", "cocktails", "wine", "brunch",
  "mondays", "tuesdays", "wednesdays", "thursdays", "fridays", "saturdays", "sundays", "weekly",
]);

function nameWords(name: string, city: string): string[] {
  const place = slug(city);
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !GENERIC.has(word) && word !== place);
}

async function askJson<T>(system: string, input: string, schema: Record<string, unknown>): Promise<T> {
  const response = await anthropic.messages.create(
    {
      model: MODEL,
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: wellFormed(input) }],
      output_config: { effort: "low", format: { type: "json_schema", schema } },
    },
    { timeout: 60000 },
  );
  if (response.stop_reason === "max_tokens" || response.stop_reason === "refusal") {
    throw new Error(`haiku ended with ${response.stop_reason}`);
  }
  const block = response.content.find((item): item is Anthropic.TextBlock => item.type === "text");
  return JSON.parse(block?.text ?? "{}") as T;
}

/** Turn the ask into what people actually type and tag on each platform. */
async function planSearch(ask: string, city: string): Promise<Plan> {
  const system = `You plan social searches for "${ask}" in ${city}. Say whether it's an event (parties, club nights, shows), a place (restaurants, bars, cafes), or an activity (run clubs, classes, things to do). Give 3 TikTok search phrases people would type, each naming ${city}, without dates. Give 3 Instagram hashtags without # that local posts about this use, like miamibars or miamibrunch; prefer city-first tags that real venues and creators use over niche ones.`;
  const plan = await askJson<Plan>(system, ask, PLAN_SCHEMA);
  return {
    kind: plan.kind,
    tiktok_queries: [...new Set([`${ask} ${city}`, `best ${ask} in ${city}`, ...(plan.tiktok_queries ?? []).slice(0, 3)])],
    instagram_hashtags: (plan.instagram_hashtags ?? []).map((tag) => tag.replace(/^#/, "")).slice(0, 3),
  };
}

async function collectPosts(plan: Plan): Promise<Post[]> {
  // Events are promoted a few weeks out; places keep getting posted about, so look back further.
  const days = plan.kind === "event" ? 30 : 60;
  const settled = await Promise.allSettled([
    ...plan.tiktok_queries.map((query) => searchTikTokVideos(query, MONID_DEADLINE_MS, { days, limit: 20 })),
    ...plan.instagram_hashtags.map((tag) => searchInstagramHashtag(tag, MONID_DEADLINE_MS)),
  ]);
  const posts: Post[] = [];
  const seen = new Set<string>();
  settled.forEach((result, index) => {
    const platform = index < plan.tiktok_queries.length ? "tiktok" : "instagram";
    if (result.status === "rejected") {
      console.warn(`[signals] ${platform} search failed: ${errorText(result.reason)}`);
      return;
    }
    for (const item of result.value) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      posts.push({
        id: posts.length,
        platform,
        url: item.url,
        author: item.author,
        posted: item.posted,
        caption: item.caption,
        likes: item.likes,
        comments: item.comments,
        location: "location" in item ? item.location : null,
      });
    }
  });
  return posts;
}

/** Haiku groups posts into spots: the same party, restaurant, or bar however it's spelled or tagged. */
async function groupSpots(posts: Post[], ask: string, city: string): Promise<Spot[]> {
  const system = `Today is ${today()}. You read social posts about "${ask}" in ${city} and list the specific spots they're about: an event series, a restaurant, a bar, or an activity someone could go to. Group posts about the same spot, including creator roundups that name it. Name the series, not one edition. Skip spots outside ${city} and its area, ads for rentals or services, DJs or creators with no spot behind them, and one-off events whose date has passed. Keep a series or promoter that throws editions again and again even when the posted edition has passed (set next_date null), since its account may list the next one. Use only facts in the posts.`;
  const input = posts
    .map((post) => `[${post.id}] ${post.platform} @${post.author} ${post.posted.slice(0, 10)}${post.location ? ` at ${post.location}` : ""} · ${post.likes} likes\n${post.caption}`)
    .join("\n\n");
  const { spots } = await askJson<{ spots: Spot[] }>(system, input, SPOT_SCHEMA);
  return spots ?? [];
}

/** How loud the signal is, counted in code: posts, distinct authors, and how many of them aren't the spot itself. */
function measure(spot: Spot, posts: Post[]): Signal {
  const own = new Set([spot.tiktok_handle, spot.instagram_handle].filter(Boolean).map((handle) => slug(handle!)));
  const authors = new Set(posts.map((post) => slug(post.author)));
  return {
    posts: posts.length,
    authors: authors.size,
    independent: [...authors].filter((author) => !own.has(author)).length,
    engagement: posts.reduce((sum, post) => sum + post.likes + post.comments * 3, 0),
    newest: posts.map((post) => post.posted).sort().at(-1)?.slice(0, 10) ?? "",
  };
}

/** The spot's own TikTok account plus other people's posts about it. Null when no account clearly matches. */
async function findAccount(spot: Spot, city: string): Promise<{ handle: string | null; ownPosts: TikTokVideo[]; mentions: TikTokVideo[] }> {
  const words = nameWords(spot.name, city);
  const place = slug(city);
  const area = spot.area ? slug(spot.area) : "";
  const videos = await searchTikTokVideos(`${spot.name} ${city}`, MONID_DEADLINE_MS, { days: 180, limit: 20 });
  const local = (text: string) => slug(text).includes(place) || (!!area && slug(text).includes(area));
  const named = (text: string) => words.length > 0 && words.some((word) => slug(text).includes(word));

  // A handle counts only if it carries the spot's name and posts about this city, so AFROSOCIAL UK can't pass for Miami.
  const authors = [spot.tiktok_handle, ...videos.map((video) => video.author)].filter((handle): handle is string => !!handle);
  const handle =
    [...new Set(authors)].find((author) => {
      if (!named(author)) return false;
      const posts = videos.filter((video) => video.author === author);
      return author === spot.tiktok_handle || slug(author).includes(place) || posts.some((post) => local(post.caption));
    }) ?? null;

  const ownPosts = videos.filter((video) => video.author === handle).sort((a, b) => b.posted.localeCompare(a.posted));
  const mentions = videos.filter((video) => video.author !== handle && named(video.caption) && local(video.caption));
  return { handle, ownPosts, mentions };
}

async function deepen(spot: Spot, posts: Post[], city: string): Promise<Evidence> {
  const base: Evidence = { spot, posts, signal: measure(spot, posts), profile: null, ownPosts: [], mentions: [], comments: [] };
  let account: Awaited<ReturnType<typeof findAccount>>;
  try {
    account = await findAccount(spot, city);
  } catch (err) {
    console.warn(`[signals] tiktok lookup failed for ${spot.name}: ${errorText(err)}`);
    return base;
  }
  // Comments on the account's latest posts with any, plus the busiest post from someone else: reviews live there.
  const commented = [
    ...account.ownPosts.filter((post) => post.comments > 0).slice(0, 2),
    ...account.mentions.filter((post) => post.comments > 0).sort((a, b) => b.comments - a.comments).slice(0, 1),
  ];
  const [profile, ...pages] = await Promise.all([
    account.handle ? tiktokProfile(account.handle, MONID_DEADLINE_MS).catch(() => null) : Promise.resolve(null),
    ...commented.map((post) => tiktokComments(post.url, MONID_DEADLINE_MS).catch(() => [])),
  ]);
  const mentionAuthors = account.mentions.map((post) => post.author);
  const signal = measure(spot, posts);
  // Independent TikTok mentions found while deepening are signal too, so they count toward independent authors.
  signal.independent += new Set(mentionAuthors.filter((author) => !posts.some((post) => post.author === author))).size;
  return { ...base, signal, profile, ownPosts: account.ownPosts, mentions: account.mentions, comments: pages.flat() };
}

function describe(evidence: Evidence): string {
  const { spot, posts, signal, profile, ownPosts, mentions, comments } = evidence;
  const lines = [
    `Spot: ${spot.name} (${spot.kind}). Area: ${spot.area ?? "unknown"}.${spot.kind === "event" ? ` Next date: ${spot.next_date ?? "unknown"}. Recurring: ${spot.recurring ?? "no"}.` : ""}`,
    `Signal: ${signal.posts} posts from ${signal.authors} accounts, ${signal.independent} not the spot itself; newest ${signal.newest}.`,
    "Posts found:",
    ...posts.slice(0, 6).map((post) => `- ${post.platform} @${post.author} ${post.posted.slice(0, 10)} (${post.likes} likes): ${post.caption.slice(0, 220)}`),
  ];
  if (profile) {
    lines.push(
      `Own TikTok @${profile.handle}: ${profile.followers} followers, ${profile.likes} likes, ${profile.videos} videos, since ${profile.since}. Bio: ${profile.bio || "(empty)"}. Link: ${profile.link ?? "none"}.`,
      ...ownPosts.slice(0, 3).map((post) => `- own ${post.posted.slice(0, 10)}: ${post.caption.slice(0, 200)}`),
    );
  } else {
    lines.push("Own TikTok: none found.");
  }
  if (mentions.length > 0) {
    lines.push("Other people on TikTok:", ...mentions.slice(0, 4).map((post) => `- @${post.author} ${post.posted.slice(0, 10)} (${post.views} views): ${post.caption.slice(0, 160)}`));
  }
  if (comments.length > 0) {
    lines.push("Comments:", ...comments.slice(0, 15).map((comment) => `- "${comment.text.slice(0, 140)}" (${comment.likes} likes)`));
  }
  return wellFormed(lines.join("\n"));
}

/**
 * The earliest upcoming date in a bio's schedule ("11/7 — MIAMI · 12/5 — ATL"), in this city when the bio names cities.
 * Done in code because Haiku kept picking the biggest edition over the next one.
 */
function nextBioDate(bio: string, city: string): string | null {
  const now = today();
  const place = slug(city);
  const entries = bio.split(/[\n|·•,]+/).flatMap((part) => {
    const match = part.match(/\b(\d{1,2})\/(\d{1,2})\b/);
    if (!match) return [];
    const [month, day] = [Number(match[1]), Number(match[2])];
    if (month < 1 || month > 12 || day < 1 || day > 31) return [];
    const year = Number(now.slice(0, 4));
    const pad = (n: number) => String(n).padStart(2, "0");
    let date = `${year}-${pad(month)}-${pad(day)}`;
    if (date < now) date = `${year + 1}-${pad(month)}-${pad(day)}`;
    return [{ date, local: slug(part).includes(place), named: /[a-z]{3,}/i.test(part.replace(match[0], "")) }];
  });
  const local = entries.filter((entry) => entry.local);
  const pool = local.length > 0 ? local : entries.some((entry) => entry.named) ? [] : entries;
  return pool.map((entry) => entry.date).sort()[0] ?? null;
}

type Refined = { index: number; name: string; area: string | null; next_date: string | null; recurring: string | null; note: string };

/** Re-read each spot from all its evidence, trusting the account's bio and newest posts over older mentions. */
async function refine(evidence: Evidence[], ask: string, city: string): Promise<string[]> {
  const system = `Today is ${today()}. For each spot found for "${ask}" in ${city}, use all its evidence and trust the spot's own bio and newest posts over older posts. Give its usual name; its current venue, address, or neighborhood; for events, the next date on or after today in ${city} as YYYY-MM-DD (or null) and how it repeats (or null). Dates listed in a bio, like "11/7 — MIAMI", are the schedule: the next date is the earliest one on or after today in ${city}, not the biggest or most-posted one. A bio like "Saturday is for X", or own posts promoting the same weekday again and again, means it repeats weekly on that day; and one short note (under 120 characters) for someone deciding whether to recommend it: what people say and any problem worth telling the user, like a venue change, a broken link, closed or moved, or nothing independent backing it. Facts from the evidence only.`;
  const input = evidence.map((item, index) => `#${index}\n${describe(item)}`).join("\n\n");
  try {
    const { notes } = await askJson<{ notes: Refined[] }>(system, input, NOTES_SCHEMA);
    return evidence.map((item, index) => {
      const refined = notes?.find((note) => note.index === index);
      if (!refined) return "";
      Object.assign(item.spot, {
        name: refined.name || item.spot.name,
        area: refined.area ?? item.spot.area,
        next_date: refined.next_date,
        recurring: refined.recurring,
      });
      return refined.note;
    });
  } catch (err) {
    console.warn(`[signals] refine failed: ${errorText(err)}`);
    return evidence.map(() => "");
  }
}

/** Jev vets the signal: is it real, does it fit the ask, are people other than the spot talking, and do they like it. */
async function vet(evidence: Evidence, ask: string, city: string): Promise<Scores> {
  const blurb = describe(evidence);
  const question = (instructions: string) => ({ type: "noul" as const, instructions: `${instructions}\n\n${blurb}` });
  const event = evidence.spot.kind === "event";
  try {
    const scores = await jevNoulScores(
      `Vet social signal for recommendations of "${ask}" in ${city} before they're sent to someone. Today is ${today()}. Judge only from the evidence. A spot's own promo posts are weak signal; other people posting about it is strong signal.`,
      {
        real: question(
          event
            ? `Is this a real event still happening in or near ${city}, with an upcoming date or a recurring night its account still promotes?`
            : `Is this a real ${evidence.spot.kind} that is open and operating in or near ${city} now?`,
        ),
        fit: question(`Does this match what the person asked for: "${ask}"?`),
        buzz: question("Are people other than the spot itself posting about it recently (creators, guests, roundups), not just its own promo?"),
        sentiment: question("Do people who've been, or plan to go, speak well of it (great, a vibe, packed, must try)? Score 0.5 when there's nothing to go on."),
        flags: question("Are there red flags: complaints about the experience, scam or cancellation talk, closed, broken links, or posts that are really for another city? People reselling or hunting for tickets is demand, not a red flag, and a venue change the account announced isn't one either."),
      },
    );
    return { real: scores.real ?? 0, fit: scores.fit ?? 0, buzz: scores.buzz ?? 0, sentiment: scores.sentiment ?? 0.5, flags: scores.flags ?? 0 };
  } catch (err) {
    console.warn(`[signals] jev failed for ${evidence.spot.name}: ${errorText(err)}`);
    return { real: 0, fit: 0, buzz: 0, sentiment: 0.5, flags: 0 };
  }
}

function judge(scores: Scores): { verdict: Verdict; score: number } {
  const score = 0.3 * scores.real + 0.25 * scores.fit + 0.25 * scores.buzz + 0.2 * scores.sentiment - 0.15 * scores.flags;
  if (scores.flags >= 0.6) return { verdict: "problem", score };
  if (scores.real >= 0.6 && scores.fit >= 0.6 && (scores.buzz >= 0.5 || scores.sentiment >= 0.6)) return { verdict: "vetted", score };
  return { verdict: "weak", score };
}

const ICON: Record<Verdict, string> = { vetted: "✅ vetted", weak: "❓ weak", problem: "⚠️ problem" };

export async function runSignals(ask: string, city: string, verbose = false): Promise<void> {
  const started = Date.now();
  const plan = await planSearch(ask, city);
  console.log(`[signals] ${plan.kind} · tiktok: ${plan.tiktok_queries.join(" | ")} · instagram: #${plan.instagram_hashtags.join(" #")}`);

  const posts = await collectPosts(plan);
  console.log(`[signals] ${posts.length} posts (${posts.filter((p) => p.platform === "tiktok").length} tiktok, ${posts.filter((p) => p.platform === "instagram").length} instagram)`);

  const spots = await groupSpots(posts, ask, city);
  const postsOf = (spot: Spot) => spot.post_ids.map((id) => posts[id]).filter((post): post is Post => !!post);
  // Strongest raw signal first, so the deepening budget goes to spots people are actually posting about.
  const ranked = spots
    .map((spot) => ({ spot, signal: measure(spot, postsOf(spot)) }))
    .sort((a, b) => b.signal.authors - a.signal.authors || b.signal.engagement - a.signal.engagement)
    .slice(0, MAX_SPOTS);
  console.log(`[signals] ${spots.length} spots: ${ranked.map(({ spot }) => spot.name).join(", ")}`);

  const evidence = await Promise.all(
    ranked.map(({ spot }, index) =>
      index < MAX_DEEPENED
        ? deepen(spot, postsOf(spot), city)
        : Promise.resolve({ spot, posts: postsOf(spot), signal: measure(spot, postsOf(spot)), profile: null, ownPosts: [], mentions: [], comments: [] }),
    ),
  );
  const notes = await refine(evidence, ask, city);
  for (const item of evidence) {
    const bioDate = item.spot.kind === "event" && item.profile ? nextBioDate(item.profile.bio, city) : null;
    if (bioDate) item.spot.next_date = bioDate;
  }
  const scores = await Promise.all(evidence.map((item) => vet(item, ask, city)));

  const rows = evidence
    .map((item, index) => ({ item, scores: scores[index]!, note: notes[index]!, ...judge(scores[index]!) }))
    .sort((a, b) => b.score - a.score);

  console.log(`\n#  ${"SPOT".padEnd(26)} ${"WHEN / WHERE".padEnd(22)} ${"SIGNAL".padEnd(9)} ${"VERDICT".padEnd(12)} SCORE  NOTE`);
  rows.forEach((row, index) => {
    const spot = row.item.spot;
    const when = (spot.kind === "event" ? (spot.recurring ?? spot.next_date) : spot.area) ?? "?";
    const signal = `${row.item.signal.posts}p/${row.item.signal.independent}i`;
    console.log(
      `${String(index + 1).padEnd(2)} ${spot.name.slice(0, 26).padEnd(26)} ${when.slice(0, 22).padEnd(22)} ${signal.padEnd(9)} ${ICON[row.verdict].padEnd(12)} ${row.score.toFixed(2).padEnd(6)} ${row.note}`,
    );
    if (verbose) {
      const s = row.scores;
      console.log(`   real ${s.real.toFixed(2)} · fit ${s.fit.toFixed(2)} · buzz ${s.buzz.toFixed(2)} · sentiment ${s.sentiment.toFixed(2)} · flags ${s.flags.toFixed(2)}`);
      console.log(describe(row.item).replace(/^/gm, "   "));
      console.log("");
    }
  });
  console.log(`\nSIGNAL = posts found / independent accounts posting about it (not the spot itself)`);
  console.log(`[signals] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

const isMain = process.argv[1]?.includes("signals/run");
if (isMain) {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const [ask, ...cityParts] = args.filter((arg) => !arg.startsWith("--"));
  const missing = ["MONID_API_KEY", "JEV_API_KEY", "ANTHROPIC_API_KEY"].filter((key) => !process.env[key]);
  if (!ask || cityParts.length === 0) {
    console.error('usage: npm run signals -- "<what>" <city> [--verbose]   e.g. "afrobeats party" Miami');
    process.exit(1);
  }
  if (missing.length > 0) {
    console.error(`[signals] missing ${missing.join(", ")} in .env`);
    process.exit(1);
  }
  try {
    await runSignals(ask, cityParts.join(" "), verbose);
    process.exit(0);
  } catch (err) {
    console.error(`[signals] failed: ${errorText(err)}`);
    process.exit(1);
  }
}
