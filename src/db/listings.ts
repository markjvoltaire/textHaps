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
  const row = {
    source: draft.source,
    source_id: draft.source_id ?? null,
    url: draft.url ?? null,
    title: draft.title,
    description: draft.description ?? "",
    city: draft.city,
    venue: draft.venue ?? null,
    starts_at: draft.starts_at ?? null,
    ends_at: draft.ends_at ?? null,
    image_url: draft.image_url ?? null,
    tags: draft.tags ?? [],
    vibe: draft.vibe ?? null,
    raw: draft.raw ?? {},
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await sb.from("listings").upsert(row, { onConflict: "source,url" }).select("*").single();
  if (error) {
    console.warn(`[listings] upsert failed: ${error.message}`);
    return null;
  }
  return data as ListingRow;
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

export async function listKeptListings(city: string): Promise<EventRow[]> {
  const needle = city.trim();
  const { data, error } = await getSupabase()
    .from("listings")
    .select("*")
    .gte("keep_score", 0.55)
    .gte("starts_at", new Date().toISOString())
    .order("starts_at", { ascending: true })
    .limit(40);

  if (error) {
    console.warn(`[listings] query failed: ${error.message}`);
    return [];
  }

  const rows = (data ?? []) as ListingRow[];
  const slug = needle.toLowerCase();
  const aliases =
    slug === "nyc" || slug.includes("new york")
      ? ["nyc", "new york"]
      : slug === "miami"
        ? ["miami"]
        : [slug];

  return rows
    .filter((row) => aliases.some((alias) => row.city.toLowerCase().includes(alias)))
    .map(listingToEvent);
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
