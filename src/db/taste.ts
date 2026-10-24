import { getSupabase } from "./client.ts";
import type { TasteKind, TasteSignal, TasteSource } from "./types.ts";

export async function listTaste(profileId: string): Promise<TasteSignal[]> {
  const { data, error } = await getSupabase()
    .from("taste_signals")
    .select("*")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: false })
    .limit(40);

  if (error) throw error;
  return (data ?? []) as TasteSignal[];
}

export async function rememberTaste(input: {
  profileId: string;
  kind: TasteKind;
  label: string;
  source?: TasteSource;
  weight?: number;
}): Promise<TasteSignal> {
  const sb = getSupabase();
  const label = input.label.trim();
  const source = input.source ?? "explicit";
  const weight = input.weight ?? 1;

  const { data: existing, error: lookupError } = await sb
    .from("taste_signals")
    .select("*")
    .eq("profile_id", input.profileId)
    .eq("kind", input.kind)
    .ilike("label", label)
    .maybeSingle();

  if (lookupError) throw lookupError;

  // Tastes change: liking something now replaces disliking it before, and the other way round.
  const opposite: TasteKind | null = input.kind === "like" ? "dislike" : input.kind === "dislike" ? "like" : null;
  if (opposite) {
    const { error } = await sb
      .from("taste_signals")
      .delete()
      .eq("profile_id", input.profileId)
      .eq("kind", opposite)
      .ilike("label", label);
    if (error) throw error;
  }

  if (existing) {
    // created_at doubles as "last said", so a taste said again counts as fresh.
    const { data, error } = await sb
      .from("taste_signals")
      .update({ weight, source, created_at: new Date().toISOString() })
      .eq("id", (existing as TasteSignal).id)
      .select("*")
      .single();
    if (error) throw error;
    return data as TasteSignal;
  }

  const { data, error } = await sb
    .from("taste_signals")
    .insert({
      profile_id: input.profileId,
      kind: input.kind,
      label,
      weight,
      source,
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as TasteSignal;
}

/** Drops a taste they've moved on from, whatever kind it was saved as. Returns what was removed. */
export async function forgetTaste(profileId: string, label: string): Promise<TasteSignal[]> {
  const { data, error } = await getSupabase()
    .from("taste_signals")
    .delete()
    .eq("profile_id", profileId)
    .ilike("label", label.trim())
    .select("*");

  if (error) throw error;
  return (data ?? []) as TasteSignal[];
}
