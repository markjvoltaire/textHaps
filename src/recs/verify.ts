import { getSupabase } from "../db/client.ts";
import type { Profile, SaveRow } from "../db/types.ts";
import { jevNoulScores } from "../jev/client.ts";
import { EVENT_DOMAINS, searchEventPages, searchWeb, type WebResult } from "../search/exa.ts";
import { formatError } from "../utils/text.ts";
import { saveSharedRec } from "./shared.ts";

/** Jev's score (0-1) a page needs to count as this exact event, the same bar as a rec's own site. */
const MATCH = 0.7;
// Both searches in full (8 ticketing + 5 web): a cap at 8 cut every web result, and plenty of nights only show up there.
const MAX_PAGES = 13;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * The web page for an event from a flyer, or null. Exa looks for the event online (ticketing sites
 * and the open web, since plenty of nights only live on Instagram), and Jev checks each page is this
 * exact event: same name, venue, and date. Throws when a search or Jev fails.
 */
export async function findFlyerPage(profile: Profile, save: SaveRow): Promise<string | null> {
  if (!save.title || !save.event_date) return null;
  const day = `${MONTHS[+save.event_date.slice(5, 7) - 1]} ${+save.event_date.slice(8, 10)}`;
  const about = [save.title, save.venue && `at ${save.venue}`, `on ${day}, ${save.event_date.slice(0, 4)}`].filter(Boolean).join(" ");
  const query = [save.title, save.venue, profile.city, day].filter(Boolean).join(" ");
  const [tickets, web] = await Promise.all([searchEventPages(query), searchWeb(query)]);
  const seen = new Set<string>();
  const pages = [...tickets, ...web].filter((page) => !seen.has(page.url) && seen.add(page.url)).slice(0, MAX_PAGES);
  const url = await bestMatch(about, pages);
  console.log(`[verify] ${JSON.stringify(save.title)} -> ${url ?? "not verified"} (${pages.length} pages)`);
  return url;
}

/**
 * A flyer someone sent has no link, and what Claude read off it could be wrong. The page that
 * findFlyerPage verifies becomes the save's link and the event becomes a rec draft credited to them.
 * Nothing passing (or Jev being down) leaves the save as it is and keeps the event out of recs.
 */
export async function verifyFlyerEvent(profile: Profile, save: SaveRow): Promise<string | null> {
  if (save.url || !save.title || !save.event_date) return null;
  try {
    const url = await findFlyerPage(profile, save);
    if (!url) return null;

    // Only fills an empty link, so one they sent later isn't overwritten.
    const { error } = await getSupabase().from("saves").update({ url }).eq("id", save.id).is("url", null);
    if (error) throw error;
    await saveSharedRec(profile, url, {
      title: save.title,
      starts_at: save.starts_at ?? save.event_date,
      ends_at: null,
      venue: save.venue,
      address: null,
      city: profile.city,
      price_note: null,
      age: null,
      summary: null,
    });
    return url;
  } catch (err) {
    console.warn(`[verify] failed for ${JSON.stringify(save.title)}: ${formatError(err)}`);
    return null;
  }
}

async function bestMatch(about: string, pages: WebResult[]): Promise<string | null> {
  if (pages.length === 0) return null;
  const scores = await jevNoulScores(
    "Match an event from a flyer to a web page about that same event. Judge only from the page given.",
    Object.fromEntries(
      pages.map((page, i) => [
        `p${i}`,
        {
          type: "noul" as const,
          instructions: `Is this page about this exact event: ${about}? A flyer and a listing often name the same night differently (a series name on one, the headliner or host on the other), so the name alone does not decide it. Count it when the venue and date match and the page names an act, host, or promoter from the flyer, or when it is a weekly or recurring night at that venue that runs on that date. Score low for a different date, a different venue, or a page that only lists many events.\n\nURL: ${page.url}\nTitle: ${page.title}\nText: ${page.highlights.join(" ").slice(0, 400)}`,
        },
      ]),
    ),
  );
  // Of the pages that pass, a ticketing page wins over a scraped copy, since it's where they'd buy.
  const passing = pages.map((page, i) => ({ url: page.url, score: scores[`p${i}`] ?? 0 })).filter((page) => page.score >= MATCH);
  passing.sort((a, b) => Number(isTicketing(b.url)) - Number(isTicketing(a.url)) || b.score - a.score);
  return passing[0]?.url ?? null;
}

function isTicketing(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return EVENT_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}
