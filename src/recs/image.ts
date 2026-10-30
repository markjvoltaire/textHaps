import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { getSupabase } from "../db/client.ts";
import { recKey } from "../db/recs.ts";
import { officialHost } from "../agent/placeLink.ts";
import { searchPageImages } from "../search/exa.ts";
import { runProvider } from "../search/monid.ts";
import { formatError } from "../utils/text.ts";
import { siteNamesIt } from "./loved.ts";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_IMAGE_MODEL ?? "claude-sonnet-5-5";

const BUCKET = "rec-images";
const METRO_NAMES: Record<string, string> = { miami: "Miami", la: "Los Angeles", nyc: "New York" };

/** Pages where a venue or event lists itself, with its own photos or flyer. */
const LISTINGS = ["yelp.com", "opentable.com", "tripadvisor.com", "eventbrite.com", "dice.fm", "ra.co", "posh.vip", "partiful.com", "shotgun.live", "lu.ma"];
/** Ticket pages: an event's own page, so its flyer ranks first for a party. */
const TICKETING = /(^|\.)(eventbrite\.com|dice\.fm|ra\.co|posh\.vip|partiful\.com|shotgun\.live|lu\.ma)$/;
const LISTING = /(^|\.)(yelp\.com|opentable\.com|tripadvisor\.com)$/;
/** A single event's page on a ticketing site (eventbrite.com/e/..., ra.co/events/..., dice.fm/event/...). */
const EVENT_PAGE = /^\/(e|events?|event-detail)\//i;

/** Images that never show the place: logos, maps, and platforms' generic share cards. */
const JUNK = /\.svg(\?|$)|logo|favicon|apple-mapkit|maps\.googleapis|staticmap|facebook-preview|social-share|placeholder|default[-_]?(og|share)|\/icons?\//i;
/** Smaller than this on the short side looks blurry as a carousel card. */
const MIN_SIDE = 400;
/** Candidates shown to Claude per tier. */
const PER_TIER = 6;

export type ImageRec = {
  id: string;
  name: string;
  category: string;
  neighborhood: string | null;
  metro: string;
  url: string | null;
  schedule: string | null;
  /** What Haps says about it, so Claude can tell it apart from another place with the same name. */
  why?: string | null;
};

type Candidate = { image: string; page: string; jpeg: Buffer };

/** A one-off or weekly night out, judged by its flyer and crowd. Everything else is a place, judged by its room and food. */
function isEvent(rec: ImageRec): boolean {
  return /party|rave|night|festival/i.test(rec.category);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Where a page sits in the ranking. 0 is the rec's own: its site, or for an event its ticket page.
 * 1 is a listing it's on (Yelp, OpenTable), 2 is anything else, mostly press (Eater, Time Out).
 */
function tierOf(page: string, rec: ImageRec): number {
  const host = hostOf(page);
  if (!host) return 2;
  if (rec.url && hostOf(rec.url) === host) return 0;
  if (officialHost(page) && siteNamesIt(page, rec)) return 0;
  // Only an event's own page counts, not a ticketing site's guide ("clubs in LA") that features many.
  if (TICKETING.test(host)) return EVENT_PAGE.test(new URL(page).pathname) ? (isEvent(rec) ? 0 : 1) : 2;
  if (LISTING.test(host)) return 1;
  return 2;
}

/** A candidate that downloads as a real photo big enough for a card, shrunk for Claude to look at. */
async function load(image: string, page: string): Promise<Candidate | null> {
  try {
    const response = await fetch(image, { signal: AbortSignal.timeout(10000), headers: { "user-agent": "Mozilla/5.0" } });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < MIN_SIDE) return null;
    // Kept at card size, which is also what gets stored if it's picked.
    const jpeg = await sharp(buffer).rotate().resize(1200, 1200, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    return { image, page, jpeg };
  } catch {
    return null;
  }
}

/** Claude looks at the candidates and picks the one that sells the rec, or none. */
async function pick(rec: ImageRec, candidates: Candidate[]): Promise<Candidate | null> {
  const where = [rec.neighborhood, METRO_NAMES[rec.metro] ?? rec.metro].filter(Boolean).join(", ");
  const look = isEvent(rec)
    ? `It's a night out. Best is its flyer or a photo of the crowd at it; a flyer for one edition of it (a themed night with its own title) still counts as it.${rec.schedule ? ` It happens ${rec.schedule}, so a flyer with one past date on it is worse than a crowd photo.` : ""}`
    : "It's a place. Best is the room, the food, or the drinks; the outside is ok. Not a photo centered on one named performer or celebrity.";
  const content: Anthropic.ContentBlockParam[] = candidates.flatMap((candidate, i) => [
    { type: "text" as const, text: `Image ${i}, from ${candidate.page}:` },
    {
      type: "image" as const,
      source: { type: "base64" as const, media_type: "image/jpeg" as const, data: candidate.jpeg.toString("base64") },
    },
  ]);
  content.push({
    type: "text",
    text: `Candidate pictures for "${rec.name}", a ${rec.category} in ${where}${rec.why ? ` (${rec.why})` : ""}, to show as a card in a swipeable iMessage carousel. ${look} Never a logo, a menu, a map, a text-only graphic, or a different place or event: use the page each one is from to tell, since another place can share the name. Answer with JSON only: {"index": <number, or -1 if none fit>}`,
  });
  const response = await anthropic.messages.create({ model: MODEL, max_tokens: 300, messages: [{ role: "user", content }] });
  const text = response.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  const index = Number(text.match(/"index"\s*:\s*(-?\d+)/)?.[1] ?? -1);
  return candidates[index] ?? null;
}

/** The Google listing's photos for a place, through Monid (SerpApi). Two paid calls, so only when Exa found nothing. */
async function googlePhotos(rec: ImageRec): Promise<{ image: string; page: string }[]> {
  const where = [rec.neighborhood, METRO_NAMES[rec.metro] ?? rec.metro].filter(Boolean).join(" ");
  const search = (await runProvider("serpapi", "/google/maps", { queryParams: { type: "search", q: `${rec.name} ${where}`, hl: "en" } }, 30000)) as {
    place_results?: { data_id?: string; title?: string };
    local_results?: { data_id?: string; title?: string }[];
  } | null;
  const place = search?.place_results ?? search?.local_results?.find((result) => result.title && recKey(result.title).includes(recKey(rec.name)));
  if (!place?.data_id) return [];
  const photos = (await runProvider("serpapi", "/google/maps-photos", { queryParams: { data_id: place.data_id, hl: "en" } }, 30000)) as {
    photos?: { image?: string }[];
  } | null;
  const page = `https://www.google.com/maps/place/?q=place_id:${place.data_id}`;
  return (photos?.photos ?? []).flatMap((photo) => (photo.image ? [{ image: photo.image, page }] : [])).slice(0, 12);
}

export type FoundImage = { jpeg: Buffer; image: string; page: string; tier: number };

/** Claude's pick from a set of pictures already found for the rec (a search, or its Instagram posts). */
export async function chooseRecImage(rec: ImageRec, found: { image: string; page: string }[], tier: number, shown = PER_TIER): Promise<FoundImage | null> {
  const loaded = (await Promise.all(found.slice(0, shown * 2).map((one) => load(one.image, one.page)))).filter(
    (candidate): candidate is Candidate => candidate !== null,
  );
  const chosen = loaded.length ? await pick(rec, loaded.slice(0, shown)) : null;
  return chosen ? { jpeg: chosen.jpeg, image: chosen.image, page: chosen.page, tier } : null;
}

/**
 * The best picture for a rec, by tier: its own site or ticket page first, then listings, then the
 * Google listing (Monid, places only), then press. Claude picks within the highest tier that has
 * one worth showing. Null when nothing fits, and the rec keeps going out as a rich link.
 */
export async function findRecImage(rec: ImageRec, options: { monid?: boolean } = {}): Promise<FoundImage | null> {
  const where = [rec.neighborhood, METRO_NAMES[rec.metro] ?? rec.metro].filter(Boolean).join(" ");
  const query = `${rec.name} ${rec.category} ${where}`;
  const pages = [...(await searchPageImages(query)), ...(await searchPageImages(query, LISTINGS))];

  const byTier = new Map<number, { image: string; page: string }[]>();
  const seen = new Set<string>();
  for (const page of pages) {
    const tier = tierOf(page.url, rec);
    for (const image of page.images) {
      if (seen.has(image) || JUNK.test(image)) continue;
      seen.add(image);
      byTier.set(tier, [...(byTier.get(tier) ?? []), { image, page: page.url }]);
    }
  }

  const tryTier = (tier: number, found: { image: string; page: string }[]) => chooseRecImage(rec, found, tier);

  for (const tier of [0, 1]) {
    const found = await tryTier(tier, byTier.get(tier) ?? []);
    if (found) return found;
  }
  if (options.monid !== false && !isEvent(rec)) {
    const google = await googlePhotos(rec).catch((err: unknown) => {
      console.warn(`[recimage] google photos failed for ${rec.name}: ${formatError(err)}`);
      return [];
    });
    const found = await tryTier(1, google);
    if (found) return found;
  }
  return tryTier(2, byTier.get(2) ?? []);
}

/** Stores the picture as Haps's own copy and points the rec at it. A miss is recorded too, so it isn't searched every run. */
export async function saveRecImage(rec: ImageRec & { key?: string }, found: FoundImage | null): Promise<string | null> {
  const supabase = getSupabase();
  const checked = new Date().toISOString();
  if (!found) {
    const { error } = await supabase.from("recs").update({ image_checked_at: checked }).eq("id", rec.id);
    if (error) throw error;
    return null;
  }
  const path = `${rec.metro}/${rec.key ?? recKey(rec.name).replace(/ /g, "-")}-${rec.id.slice(0, 8)}.jpg`;
  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, found.jpeg, { contentType: "image/jpeg", upsert: true });
  if (uploadError) throw uploadError;
  const imageUrl = supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  const { error } = await supabase.from("recs").update({ image_url: imageUrl, image_source: found.page, image_checked_at: checked }).eq("id", rec.id);
  if (error) throw error;
  return imageUrl;
}
