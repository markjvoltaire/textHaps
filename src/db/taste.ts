import { getSupabase } from "./client.ts";
import type { TasteCategory, TasteKind, TasteSignal, TasteSource } from "./types.ts";

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
  category?: TasteCategory;
  confidence?: number;
  evidence?: string;
  weight?: number;
}): Promise<TasteSignal> {
  const sb = getSupabase();
  const label = input.label.trim();
  const source = input.source ?? "explicit";
  const weight = input.weight ?? 1;
  const fields = {
    weight,
    source,
    category: input.category ?? null,
    // Said outright is sure; anything else starts as a guess until it comes up again.
    confidence: Math.min(1, Math.max(0.1, input.confidence ?? (source === "explicit" ? 1 : 0.5))),
    evidence: input.evidence?.trim() || null,
  };

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
    const prior = existing as TasteSignal;
    // Coming up again makes a guess surer, and something said outright stays said outright.
    const confirmed =
      prior.source === "explicit" && source !== "explicit"
        ? { source: prior.source, confidence: prior.confidence, evidence: prior.evidence }
        : { confidence: Math.max(fields.confidence, Math.min(1, prior.confidence + 0.2)) };
    // created_at doubles as "last said", so a taste said again counts as fresh.
    const { data, error } = await sb
      .from("taste_signals")
      .update({ ...fields, category: fields.category ?? prior.category, ...confirmed, created_at: new Date().toISOString() })
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
      ...fields,
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
