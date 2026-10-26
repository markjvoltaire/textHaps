import { getSupabase } from "../db/client.ts";
import { recKey } from "../db/recs.ts";
import { jevNoulScores } from "../jev/client.ts";
import { officialHost } from "../agent/placeLink.ts";
import { searchWeb } from "../search/exa.ts";

/** Jev's score (0-1) a page needs to count as the rec's own site. Official sites scored 0.8-0.9 in testing, Tock, press, and directory pages under 0.1. */
const MATCH = 0.7;
/** A rec with no site found is searched again after this, in case it got one. */
const RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

const METRO_NAMES: Record<string, string> = { miami: "Miami", la: "Los Angeles", nyc: "New York" };

export type LinkableRec = {
  id: string;
  name: string;
  category: string;
  neighborhood: string | null;
  metro: string;
  url: string | null;
  url_checked_at: string | null;
};

/**
 * The rec's official site: an Exa search, then Jev checks each result is the place's own site
 * and not a review, ticketing page, or another place with a similar name. Each site is judged by
 * its best page (Jev scored one homepage 0.36 and its other pages 0.85), and its homepage is
 * what's sent, since it reads best as a card. Null when nothing passes.
 */
export async function findRecSite(rec: LinkableRec): Promise<string | null> {
  const city = METRO_NAMES[rec.metro] ?? rec.metro;
  const where = [rec.neighborhood, city].filter(Boolean).join(" ");
  const results = (await searchWeb(`${rec.name} ${where} official website`)).filter((result) => officialHost(result.url));
  if (results.length === 0) return null;

  const about = `${rec.name}, the ${rec.category} in ${where}`;
  const scores = await jevNoulScores(
    "Match a venue to its own official website. Judge only from the page given.",
    Object.fromEntries(
      results.map((result, i) => [
        `p${i}`,
        {
          type: "noul" as const,
          instructions: `Is this page part of the official website run by ${about} itself? Score low for a review, listing, map, social, press, or ticketing page, or a different place with a similar name.\n\nURL: ${result.url}\nTitle: ${result.title}\nText: ${result.highlights.join(" ").slice(0, 400)}`,
        },
      ]),
    ),
  );
  // Jev unavailable (no key, or no answers): only a domain that spells the name counts.
  const jevAnswered = Object.keys(scores).length > 0;
  const spelled = recKey(rec.name).replace(/ /g, "");

  const sites = new Map<string, { score: number; urls: string[] }>();
  results.forEach((result, i) => {
    const host = officialHost(result.url)!;
    const score = jevAnswered ? (scores[`p${i}`] ?? 0) : spelled.length >= 5 && host.replace(/[^a-z0-9]/g, "").includes(spelled) ? 1 : 0;
    const site = sites.get(host) ?? { score: 0, urls: [] };
    site.score = Math.max(site.score, score);
    site.urls.push(result.url);
    sites.set(host, site);
  });
  const best = [...sites.values()].sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < MATCH) return null;
  return best.urls.sort((a, b) => new URL(a).pathname.length - new URL(b).pathname.length)[0]!;
}

/**
 * The rec's site, looked up and saved to the recs table if it doesn't have one. A miss is saved
 * too (url_checked_at), so the same rec isn't searched on every send. A failed lookup isn't.
 */
export async function ensureRecSite(rec: LinkableRec): Promise<string | null> {
  if (rec.url) return rec.url;
  if (rec.url_checked_at && Date.now() - Date.parse(rec.url_checked_at) < RECHECK_MS) return null;
  let url: string | null;
  try {
    url = await findRecSite(rec);
  } catch (err) {
    console.warn(`[reclink] lookup failed for ${rec.name}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
  const checkedAt = new Date().toISOString();
  // Only fills an empty url, so a link someone set by hand is never overwritten.
  const { error } = await getSupabase().from("recs").update({ url, url_checked_at: checkedAt }).eq("id", rec.id).is("url", null);
  if (error) console.warn(`[reclink] save failed for ${rec.name}:`, error.message);
  console.log(`[reclink] ${rec.name} -> ${url ?? "no site"}`);
  rec.url = url;
  rec.url_checked_at = checkedAt;
  return url;
}
