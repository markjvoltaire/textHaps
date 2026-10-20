import { getSupabase } from "./client.ts";
import type { EventRow } from "./types.ts";

export type ListingRow = {
  id: string;
  source: string;
  source_id: string | null;
  url: string | null;
  title: string;
  description: string;
  city: string;
  venue: string | null;
  starts_at: string | null;
  ends_at: string | null;
  image_url: string | null;
  tags: string[];
  vibe: string | null;
  music: string | null;
  crowd: string | null;
  vibe_scores: Record<string, number>;
  keep_score: number | null;
  created_at: string;
};

export type ListingDraft = {
  source: string;
  source_id?: string;
  url?: string;
  title: string;
  description?: string;
  city: string;
  metro: string;
  venue?: string;
  starts_at?: string;
  ends_at?: string;
  image_url?: string;
  tags?: string[];
  vibe?: string;
  raw?: Record<string, unknown>;
};

export async function upsertListing(draft: ListingDraft): Promise<ListingRow | null> {
  const sb = getSupabase();
  // Only send fields the scraper actually returned, so a re-ingest never wipes
  // stored dates or Jev scores (vibe, tags) with nulls.
  const row: Record<string, unknown> = {
    source: draft.source,
    url: draft.url ?? null,
    title: draft.title,
    city: draft.city,
    metro: draft.metro,
    raw: draft.raw ?? {},
    updated_at: new Date().toISOString(),
  };
  const optional: Record<string, unknown> = {
    source_id: draft.source_id,
    description: draft.description || undefined,
    venue: draft.venue,
    starts_at: draft.starts_at,
    ends_at: draft.ends_at,
    image_url: draft.image_url,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) row[key] = value;
  }

  const { data, error } = await sb.from("listings").upsert(row, { onConflict: "source,url" }).select("*").single();
  if (error) {
    console.warn(`[listings] upsert failed: ${error.message}`);
    return null;
  }
  const saved = data as ListingRow;

  // Source tags only seed rows Jev hasn't scored yet; scored rows keep their picked tags.
  if (saved.keep_score == null && draft.tags?.length) {
    const tags = [...new Set([...saved.tags, ...draft.tags])];
    await sb.from("listings").update({ tags }).eq("id", saved.id);
    saved.tags = tags;
  }
  return saved;
}

export async function datedListingUrls(source: string): Promise<Set<string>> {
  const { data, error } = await getSupabase()
    .from("listings")
    .select("url")
    .eq("source", source)
    .not("starts_at", "is", null);
  if (error) {
    console.warn(`[listings] dated url lookup failed: ${error.message}`);
    return new Set();
  }
  return new Set((data ?? []).map((row: { url: string | null }) => row.url).filter((url): url is string => Boolean(url)));
}

export async function getListing(id: string): Promise<ListingRow | null> {
  const { data, error } = await getSupabase().from("listings").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as ListingRow | null) ?? null;
}

/** Upcoming rows Jev never scored (a failed chunk, say), so each run retries them. */
export async function listUnscoredListings(): Promise<ListingRow[]> {
  const { data, error } = await getSupabase()
    .from("listings")
    .select("*")
    .is("keep_score", null)
    .gte("starts_at", new Date().toISOString())
    .limit(200);
  if (error) {
    console.warn(`[listings] unscored lookup failed: ${error.message}`);
    return [];
  }
  return (data ?? []) as ListingRow[];
}

export async function setListingOrganize(
  id: string,
  patch: {
    keep_score?: number;
    tags?: string[];
    vibe?: string | null;
    music?: string | null;
    crowd?: string | null;
    vibe_scores?: Record<string, number>;
  },
): Promise<void> {
  const { error } = await getSupabase().from("listings").update(patch).eq("id", id);
  if (error) console.warn(`[listings] score failed: ${error.message}`);
}

/** Kept listings in a metro, filtered to the asked window in the query itself so later dates aren't cut off. */
export async function listKeptListings(metro: string, from: Date, to: Date): Promise<EventRow[]> {
  const { data, error } = await getSupabase()
    .from("listings")
    .select("*")
    .eq("metro", metro)
    .gte("keep_score", 0.55)
    .gte("starts_at", from.toISOString())
    .lte("starts_at", to.toISOString())
    .order("starts_at", { ascending: true })
    .limit(120);

  if (error) {
    console.warn(`[listings] query failed: ${error.message}`);
    return [];
  }

  return dedupeListings((data ?? []) as ListingRow[])
    .slice(0, 40)
    .map(listingToEvent);
}

// The same night often shows up on several sources. Keep the best row of each group.
export function dedupeListings(rows: ListingRow[]): ListingRow[] {
  const best = [...rows].sort(
    (a, b) =>
      (b.keep_score ?? 0) - (a.keep_score ?? 0) ||
      Number(Boolean(b.image_url)) - Number(Boolean(a.image_url)) ||
      b.description.length - a.description.length,
  );
  const kept: ListingRow[] = [];
  for (const row of best) {
    if (!kept.some((other) => isSameEvent(row, other))) kept.push(row);
  }
  return kept.sort((a, b) => (a.starts_at ?? "").localeCompare(b.starts_at ?? ""));
}

function isSameEvent(a: ListingRow, b: ListingRow): boolean {
  const titleA = normalizeTitle(a.title);
  const titleB = normalizeTitle(b.title);
  if (!titleA || !titleB) return false;
  const similar =
    titleA === titleB ||
    (Math.min(titleA.length, titleB.length) >= 12 && (titleA.includes(titleB) || titleB.includes(titleA)));
  if (!similar) return false;
  // Same name on clearly different days is a recurring night, not a duplicate.
  if (a.starts_at && b.starts_at) {
    return Math.abs(Date.parse(a.starts_at) - Date.parse(b.starts_at)) < 24 * 60 * 60 * 1000;
  }
  return true;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function listingToEvent(row: ListingRow): EventRow {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    city: row.city,
    neighborhood: null,
    venue: row.venue,
    starts_at: row.starts_at ?? new Date().toISOString(),
    ends_at: row.ends_at,
    url: row.url,
    tags: row.tags,
    vibe: row.vibe,
    music: row.music,
    crowd: row.crowd,
    price_note: null,
    source: row.source,
    image_path: row.image_url,
    created_at: row.created_at,
  };
}
