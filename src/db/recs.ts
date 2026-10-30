import { getSupabase } from "./client.ts";

export type RecStatus = "draft" | "approved" | "rejected";

export type RecDraft = {
  metro: string;
  name: string;
  category: string;
  neighborhood: string | null;
  address: string | null;
  url: string | null;
  why: string;
  best_for: string[];
  vibe: string | null;
  music: string | null;
  crowd: string | null;
  price: string | null;
  schedule: string | null;
  vouched_by: string[];
  sources: string[];
  status?: RecStatus;
  /** The user who sent Haps the link, for recs that came from a chat. */
  submitted_by?: string | null;
};

export type RecRow = RecDraft & { id: string; key: string; status: RecStatus; created_at: string; url_checked_at: string | null; image_url?: string | null };

export type RecMatch = {
  id: string;
  name: string;
  category: string;
  neighborhood: string | null;
  why: string;
  url: string | null;
  distance: number;
};

/** One rec per name per metro, however the name is cased or punctuated. */
export function recKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^the /, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

type RecTextFields = Pick<RecDraft, "name" | "category" | "neighborhood" | "why" | "best_for" | "vibe" | "music" | "crowd" | "price" | "schedule">;

/** What a rec is about, as the text that gets embedded. */
export function recText(rec: RecTextFields): string {
  return [rec.name, rec.category, rec.neighborhood, rec.why, rec.best_for.join(", "), rec.vibe, rec.music, rec.crowd, rec.price, rec.schedule]
    .filter(Boolean)
    .join(". ");
}

/** Every rec, any status, for re-embedding after a model change. */
export async function listAllRecs(): Promise<(RecTextFields & { id: string })[]> {
  const { data, error } = await getSupabase()
    .from("recs")
    .select("id, name, category, neighborhood, why, best_for, vibe, music, crowd, price, schedule");
  if (error) throw error;
  return (data ?? []) as (RecTextFields & { id: string })[];
}

export async function setRecEmbedding(id: string, embedding: number[]): Promise<void> {
  const { error } = await getSupabase().from("recs").update({ embedding: JSON.stringify(embedding) }).eq("id", id);
  if (error) throw error;
}

/** Keys already stored for a metro (any status), so drafting never redoes a rec or revives a rejected one. */
export async function listRecKeys(metro: string): Promise<Set<string>> {
  const { data, error } = await getSupabase().from("recs").select("key").eq("metro", metro);
  if (error) throw error;
  return new Set((data ?? []).map((row: { key: string }) => row.key));
}

export async function insertRec(draft: RecDraft, embedding: number[]): Promise<RecRow> {
  const { data, error } = await getSupabase()
    .from("recs")
    .insert({ ...draft, key: recKey(draft.name), embedding: JSON.stringify(embedding), last_checked: new Date().toISOString() })
    .select("*")
    .single();
  if (error) throw error;
  return data as RecRow;
}

/** Full rows for matched ids, without the embedding. */
export async function getRecs(ids: string[]): Promise<RecRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await getSupabase()
    .from("recs")
    .select("id, key, metro, name, category, neighborhood, address, url, url_checked_at, image_url, why, best_for, vibe, music, crowd, price, schedule, vouched_by, sources, status, created_at")
    .in("id", ids);
  if (error) throw error;
  return (data ?? []) as RecRow[];
}

/** Closest approved recs to an embedded search, nearest first. */
export async function matchRecs(
  embedding: number[],
  options: { metro?: string; categories?: string[]; limit?: number } = {},
): Promise<RecMatch[]> {
  const { data, error } = await getSupabase().rpc("match_recs", {
    query_embedding: JSON.stringify(embedding),
    match_metro: options.metro ?? null,
    match_categories: options.categories ?? null,
    match_count: options.limit ?? 5,
  });
  if (error) throw error;
  return (data ?? []) as RecMatch[];
}
