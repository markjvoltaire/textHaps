import { getSupabase } from "./client.ts";
import type { SaveRow } from "./types.ts";

export async function listSaves(profileId: string): Promise<SaveRow[]> {
  const { data, error } = await getSupabase()
    .from("saves")
    .select("*")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) throw error;
  return (data ?? []) as SaveRow[];
}

export type SaveInput = {
  profileId: string;
  url?: string;
  title?: string;
  note?: string;
  /** A full start with its offset ("2026-11-14T22:00:00-05:00"), or just the day ("2026-11-14"). */
  startsAt?: string | null;
  venue?: string;
  /** Whether Haps texts them before it. Left as it was when not given. */
  remind?: boolean;
};

/** Saves an event, or updates the save with that url, so the start time or a yes to reminders can come later. */
export async function saveEvent(input: SaveInput): Promise<SaveRow> {
  if (!input.url) {
    throw new Error("save_event needs a url");
  }
  const fields: Record<string, string | boolean | null> = {};
  if (input.remind !== undefined) fields.remind = input.remind;
  if (input.title) fields.title = input.title;
  if (input.note) fields.note = input.note;
  if (input.venue) fields.venue = input.venue;
  if (input.startsAt) {
    // The day as written is the venue's own, so it isn't moved by converting to UTC.
    fields.event_date = input.startsAt.slice(0, 10);
    fields.starts_at = input.startsAt.length > 10 ? input.startsAt : null;
  }

  const { data: existing, error: findError } = await getSupabase()
    .from("saves")
    .select("id")
    .eq("profile_id", input.profileId)
    .eq("url", input.url)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (findError) throw findError;

  // Nothing new to write (same link again) just reads the save back.
  const query = existing
    ? Object.keys(fields).length
      ? getSupabase().from("saves").update(fields).eq("id", existing.id)
      : getSupabase().from("saves").select("*").eq("id", existing.id)
    : getSupabase().from("saves").insert({ profile_id: input.profileId, url: input.url, ...fields });
  const { data, error } = await query.select("*").single();

  if (error) throw error;
  return data as SaveRow;
}

/** Drops a save and, with it, any reminders still waiting to go out. */
export async function removeSave(profileId: string, saveId: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("saves")
    .delete()
    .eq("profile_id", profileId)
    .eq("id", saveId)
    .select("id");

  if (error) throw error;
  return (data ?? []).length > 0;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** One save for the prompt: what it is, and when and where when known. */
export function formatSave(save: SaveRow): string {
  const name = save.title ?? save.url ?? "saved item";
  const date = save.event_date ? `${MONTHS[+save.event_date.slice(5, 7) - 1]} ${+save.event_date.slice(8, 10)}` : null;
  return [name, date, save.venue].filter(Boolean).join(", ");
}
