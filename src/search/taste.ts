import { getSupabase } from "../db/client.ts";
import type { Profile, TasteSignal } from "../db/types.ts";
import { embedQuery } from "./embed.ts";

/** How much their taste pulls a search, next to the search itself (1). Tested: a vague ask ("something fun saturday") turns personal, a specific one ("afrobeats party") still leads. */
const TASTE_PULL = 0.7;

/**
 * Who they are as one passage to embed: what they like, the vibe, who they go with, and what
 * they want more of. Dislikes stay out, since "no techno" embeds close to techno.
 */
export function tasteText(profile: Profile, taste: TasteSignal[]): string | null {
  const likes = taste
    .filter((signal) => signal.kind === "like")
    .sort((a, b) => b.confidence * b.weight - a.confidence * a.weight)
    .map((signal) => signal.label);
  if (likes.length === 0) return null;
  return [
    `Into ${likes.join(", ")}`,
    profile.social && `Goes out with ${profile.social}`,
    profile.discovery_goal && `Wants ${profile.discovery_goal}`,
  ]
    .filter(Boolean)
    .join(". ");
}

/** Re-embeds their taste after it changed, and keeps it on the profile for this reply's searches. */
export async function refreshTasteEmbedding(profile: Profile, taste: TasteSignal[]): Promise<void> {
  const text = tasteText(profile, taste);
  const embedding = text ? await embedQuery(text) : null;
  const value = embedding ? JSON.stringify(embedding) : null;
  const { error } = await getSupabase()
    .from("profiles")
    .update({ taste_embedding: value, taste_embedded_at: new Date().toISOString() })
    .eq("id", profile.id);
  if (error) throw error;
  profile.taste_embedding = value;
}

/** Their taste vector, if they have one. pgvector comes back from the API as "[0.1,...]" text. */
export function tasteVector(profile: Profile): number[] | undefined {
  if (!profile.taste_embedding) return undefined;
  const vector = JSON.parse(profile.taste_embedding) as number[];
  return vector.length ? vector : undefined;
}

/** The search pulled toward their taste, scaled back to length 1 like every stored vector. */
export function withTaste(query: number[], taste: number[] | undefined): number[] {
  if (!taste) return query;
  const mixed = query.map((value, i) => value + TASTE_PULL * (taste[i] ?? 0));
  const length = Math.hypot(...mixed);
  return mixed.map((value) => value / length);
}
