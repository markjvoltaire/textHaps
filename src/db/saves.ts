import { getSupabase } from "./client.ts";
import { getEvent } from "./events.ts";
import type { EventRow, SaveRow } from "./types.ts";

export async function listSaves(profileId: string): Promise<SaveRow[]> {
  const { data, error } = await getSupabase()
    .from("saves")
    .select("*, event:events(*)")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) throw error;
  return (data ?? []) as SaveRow[];
}

export async function saveEvent(input: {
  profileId: string;
  eventId?: string;
  url?: string;
  title?: string;
  note?: string;
}): Promise<SaveRow> {
  if (!input.eventId && !input.url) {
    throw new Error("save_event needs an event_id or a url");
  }

  const sb = getSupabase();

  if (input.eventId) {
    const { data: existing, error: lookupError } = await sb
      .from("saves")
      .select("*, event:events(*)")
      .eq("profile_id", input.profileId)
      .eq("event_id", input.eventId)
      .maybeSingle();

    if (lookupError) throw lookupError;
    if (existing) return existing as SaveRow;

    const event = await getEvent(input.eventId);
    const { data, error } = await sb
      .from("saves")
      .insert({
        profile_id: input.profileId,
        event_id: input.eventId,
        url: event?.url ?? input.url ?? null,
        title: event?.title ?? input.title ?? null,
        note: input.note ?? null,
      })
      .select("*, event:events(*)")
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
  const event = save.event as EventRow | null | undefined;
  const title = event?.title ?? save.title ?? save.url ?? "saved item";
  const when = event?.starts_at ? ` · ${event.starts_at}` : "";
  return `${title}${when}`;
}
