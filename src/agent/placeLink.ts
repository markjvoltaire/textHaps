import type { WebResult } from "../search/exa.ts";

// Review, map, social, press, and ticket sites. Their pages are about a place, not the place's own site.
const NOT_OFFICIAL =
  /(^|\.)(yelp|tripadvisor|timeout|google|goo|instagram|facebook|tiktok|x|twitter|threads|youtube|opentable|resy|sevenrooms|exploretock|tock|eater|theinfatuation|infatuation|miaminewtimes|secretmiami|thrillist|cntraveler|timeoutmiami|wikipedia|reddit|foursquare|ubereats|doordash|grubhub|seamless|postmates|menupages|allmenus|zomato|yahoo|bing|apple|mapquest|wanderlog|eventbrite|dice|posh|partiful|ra|shotgun|exa|linktr|linktree)\.[a-z.]+$/i;

// City and filler words venues put around their name, e.g. sablemiami.com and "Barcelona Wynwood" are "sable" and "barcelona".
const FILLER = "miami|wynwood|brickell|beach|nyc|newyork|brooklyn|manhattan|official|restaurant|cafe|bar|the|club|lounge";
// Domains run words together, so only a trailing city word (or a leading "the") comes off: "barcelona" keeps its "bar".
const HOST_EDGES = new RegExp(`^the|(${FILLER})+$`, "g");
const WORD_EDGES = new RegExp(`^((${FILLER}) )+|( (${FILLER}))+$`, "g");

// Title pieces that name a page, not the place ("Visit — Sable").
const GENERIC = new Set(["visit", "home", "menu", "menus", "about", "contact", "hours", "reservations", "book", "welcome", "info", "official site", "events", "gallery", "vinyl lounge"]);

function words(text: string): string {
  return ` ${text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim()} `;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** Ways a reply might name the place behind this result: its domain, the domain minus city words, and its title. */
function namesFor(result: WebResult, host: string): string[] {
  const core = host.split(".")[0] ?? "";
  const titleParts = result.title.split(/\s*[|—–·:]\s*|\s+-\s+/).map((part) => words(part).trim());
  return [core, core.replace(HOST_EDGES, ""), ...titleParts, ...titleParts.map((part) => part.replace(WORD_EDGES, ""))]
    .map((name) => words(name).trim())
    .filter((name) => name.length >= 4 && !GENERIC.has(name));
}

/**
 * The official site of the one place a reply talks about, picked from this reply's web results.
 * Null when the reply names no place with its own site in the results, or names more than one,
 * since a list of recs shouldn't end on one place's card.
 */
export function placeLinkFor(reply: string, results: WebResult[]): string | null {
  const said = words(reply);
  const matched = new Map<string, string[]>();
  for (const result of results) {
    const host = hostOf(result.url);
    if (!host || NOT_OFFICIAL.test(host)) continue;
    if (!namesFor(result, host).some((name) => said.includes(` ${name} `))) continue;
    matched.set(host, [...(matched.get(host) ?? []), result.url]);
  }
  if (matched.size !== 1) return null;
  const [urls] = [...matched.values()];
  // The homepage reads best as a card, so prefer the shortest path on that site.
  return urls!.sort((a, b) => new URL(a).pathname.length - new URL(b).pathname.length)[0]!;
}
