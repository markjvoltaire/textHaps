import { getSupabase } from "./client.ts";
import { recKey } from "./recs.ts";

export type ShownRec = {
  id: string;
  name: string;
  url: string | null;
  /** Looks up and saves the rec's own site when it has none. Started early, so it's usually done by send time. */
  site?: () => Promise<string | null>;
};
export type PickOutcome = "picked" | "passed";

/** The searched recs a reply actually sent, by name ("stamped" counts for "Stamped: AYA x Friends"). */
export function recsNamedIn(text: string, offered: ShownRec[]): ShownRec[] {
  const said = ` ${recKey(text)} `;
  return offered.filter((rec) => {
    const names = [rec.name, rec.name.split(":")[0] ?? ""].map((name) => recKey(name)).filter((name) => name.length >= 3);
    return names.some((name) => said.includes(` ${name} `));
  });
}

/** Logs the recs a reply named, so a later pick can be matched to what they were sent. */
export async function recordShown(profileId: string, recs: ShownRec[]): Promise<void> {
  if (recs.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await getSupabase()
    .from("rec_picks")
    .insert(recs.map((rec) => ({ profile_id: profileId, rec_id: rec.id, name: rec.name, rec_key: recKey(rec.name), url: rec.url, shown_at: now })));
  if (error) throw error;
}

/**
 * Marks the rec they named as picked or passed. Matches the latest one Haps sent them in the last
 * two weeks ("stamped" finds "Stamped: AYA x Friends"); anything else is logged by name alone.
 */
export async function recordPick(input: { profileId: string; name: string; outcome: PickOutcome; note?: string }): Promise<{ name: string; matched: boolean }> {
  const sb = getSupabase();
  const key = recKey(input.name);
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from("rec_picks")
    .select("id, name, rec_key")
    .eq("profile_id", input.profileId)
    .not("shown_at", "is", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) throw error;
  const shown = (data ?? []) as { id: string; name: string; rec_key: string }[];
  const match =
    shown.find((row) => row.rec_key === key) ??
    shown.find((row) => key.length >= 3 && (row.rec_key.startsWith(key) || key.startsWith(row.rec_key)));
  const outcome = { outcome: input.outcome, outcome_at: new Date().toISOString(), note: input.note?.trim() || null };

  if (match) {
    const { error: updateError } = await sb.from("rec_picks").update(outcome).eq("id", match.id);
    if (updateError) throw updateError;
    return { name: match.name, matched: true };
  }
  const { error: insertError } = await sb
    .from("rec_picks")
    .insert({ profile_id: input.profileId, name: input.name.trim(), rec_key: key, ...outcome });
  if (insertError) throw insertError;
  return { name: input.name.trim(), matched: false };
}
