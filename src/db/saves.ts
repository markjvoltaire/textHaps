import { getSupabase } from "./client.ts";
import { getListing, type ListingRow } from "./listings.ts";
import type { SaveRow } from "./types.ts";

const SAVE_SELECT = "*, listing:listings(*)";

export async function listSaves(profileId: string): Promise<SaveRow[]> {
  const { data, error } = await getSupabase()
    .from("saves")
    .select(SAVE_SELECT)
    .eq("profile_id", profileId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) throw error;
  return (data ?? []) as SaveRow[];
}

export async function saveEvent(input: {
  profileId: string;
  listingId?: string;
  url?: string;
  title?: string;
  note?: string;
}): Promise<SaveRow> {
  if (!input.listingId && !input.url) {
    throw new Error("save_event needs an event_id or a url");
  }

  const sb = getSupabase();

  if (input.listingId) {
    const { data: existing, error: lookupError } = await sb
      .from("saves")
      .select(SAVE_SELECT)
      .eq("profile_id", input.profileId)
      .eq("listing_id", input.listingId)
      .maybeSingle();

    if (lookupError) throw lookupError;
    if (existing) return existing as SaveRow;

    const listing = await getListing(input.listingId);
    if (!listing) throw new Error(`no listing ${input.listingId}, use an id from search_events`);
    const { data, error } = await sb
      .from("saves")
      .insert({
        profile_id: input.profileId,
        listing_id: listing.id,
        url: listing.url ?? input.url ?? null,
        title: listing.title,
        note: input.note ?? null,
      })
      .select(SAVE_SELECT)
      .single();

    if (error) throw error;
    return data as SaveRow;
  }

  const { data, error } = await sb
    .from("saves")
    .insert({
      profile_id: input.profileId,
      url: input.url,
      title: input.title ?? null,
      note: input.note ?? null,
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as SaveRow;
}

export function formatSave(save: SaveRow): string {
  const listing = save.listing as ListingRow | null | undefined;
  const title = listing?.title ?? save.title ?? save.url ?? "saved item";
  const when = listing?.starts_at ? ` · ${listing.starts_at}` : "";
  return `${title}${when}`;
}
