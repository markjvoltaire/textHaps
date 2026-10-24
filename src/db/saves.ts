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

export async function saveEvent(input: { profileId: string; url?: string; title?: string; note?: string }): Promise<SaveRow> {
  if (!input.url) {
    throw new Error("save_event needs a url");
  }

  const { data, error } = await getSupabase()
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
  return save.title ?? save.url ?? "saved item";
}
