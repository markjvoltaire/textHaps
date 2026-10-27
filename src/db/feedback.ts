import { getSupabase } from "./client.ts";
import { recKey } from "./recs.ts";
import type { SaveRow } from "./types.ts";

export type Verdict = "loved" | "liked" | "meh" | "bad";
export const VERDICTS: Verdict[] = ["loved", "liked", "meh", "bad"];

export type FeedbackInput = {
  profileId: string;
  metro: string | null;
  title: string;
  save: SaveRow | null;
  went: boolean;
  verdict: Verdict | null;
  feedback: string | null;
};

/** The rec an event is, by its link or its name in their metro, so feedback counts toward it. */
async function recFor(url: string | null, title: string, metro: string | null): Promise<string | null> {
  const supabase = getSupabase();
  if (url) {
    const { data } = await supabase.from("recs").select("id").eq("url", url).limit(1).maybeSingle();
    if (data) return data.id as string;
  }
  if (!metro) return null;
  const { data } = await supabase.from("recs").select("id").eq("metro", metro).eq("key", recKey(title)).limit(1).maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/** Whether they went and how it was. Telling Haps again about the same saved event updates it. */
export async function recordFeedback(input: FeedbackInput): Promise<{ id: string; rec_id: string | null }> {
  const url = input.save?.url ?? null;
  const row = {
    profile_id: input.profileId,
    save_id: input.save?.id ?? null,
    rec_id: await recFor(url, input.title, input.metro),
    metro: input.metro,
    title: input.save?.title ?? input.title,
    url,
    venue: input.save?.venue ?? null,
    event_date: input.save?.event_date ?? null,
    went: input.went,
    verdict: input.went ? input.verdict : null,
    feedback: input.feedback,
  };
  const supabase = getSupabase();
  const existing = input.save
    ? (await supabase.from("event_feedback").select("id").eq("save_id", input.save.id).maybeSingle()).data
    : null;
  const query = existing
    ? supabase.from("event_feedback").update(row).eq("id", existing.id)
    : supabase.from("event_feedback").insert(row);
  const { data, error } = await query.select("id, rec_id").single();
  if (error) throw error;
  return data as { id: string; rec_id: string | null };
}

/** Whether they already said how a saved event went, so the follow-up isn't sent. */
export async function hasFeedback(saveId: string): Promise<boolean> {
  const { count, error } = await getSupabase()
    .from("event_feedback")
    .select("id", { count: "exact", head: true })
    .eq("save_id", saveId);
  if (error) throw error;
  return (count ?? 0) > 0;
}

export type LovedBySimilar = {
  title: string;
  url: string | null;
  venue: string | null;
  event_date: string | null;
  verdict: Verdict;
  feedback: string | null;
  rec_id: string | null;
  rec_name: string | null;
  schedule: string | null;
  distance: number;
};

/**
 * Taste this close (cosine distance) counts as similar; further than this, "people like you loved it"
 * isn't true. On Oct 27, 2026 the 3 profiles with a taste vector sat 0.37-0.68 apart (median 0.63),
 * so 0.5 keeps roughly the closest tenth. Worth recalibrating once there are more people.
 */
const SIMILAR = 0.5;

/** Events people with taste closest to theirs went to and loved or liked, nearest taste first. */
export async function lovedBySimilar(taste: number[], profileId: string, metro: string | null, limit = 5): Promise<LovedBySimilar[]> {
  const { data, error } = await getSupabase().rpc("match_loved_by_similar", {
    query_embedding: JSON.stringify(taste),
    exclude_profile: profileId,
    match_metro: metro,
    match_count: limit,
  });
  if (error) throw error;
  return ((data ?? []) as LovedBySimilar[]).filter((row) => row.distance <= SIMILAR);
}
