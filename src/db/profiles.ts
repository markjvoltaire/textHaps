import { getSupabase } from "./client.ts";
import type { OnboardingField, Profile, TasteSignal } from "./types.ts";

export type ProfilePatch = Partial<Record<(typeof PROFILE_FIELDS)[number], string>>;

export async function upsertProfile(platform: string, platformUserId: string): Promise<Profile> {
  const sb = getSupabase();
  const { data: existing, error: lookupError } = await sb
    .from("profiles")
    .select("*")
    .eq("platform", platform)
    .eq("platform_user_id", platformUserId)
    .maybeSingle();

  if (lookupError) throw lookupError;
  if (existing) return existing as Profile;

  const { data, error } = await sb
    .from("profiles")
    .insert({ platform, platform_user_id: platformUserId })
    .select("*")
    .single();

  if (error?.code === "23505") {
    const { data: raced, error: racedError } = await sb
      .from("profiles")
      .select("*")
      .eq("platform", platform)
      .eq("platform_user_id", platformUserId)
      .single();
    if (racedError) throw racedError;
    return raced as Profile;
  }

  if (error) throw error;
  return data as Profile;
}

export async function updateProfile(profileId: string, patch: ProfilePatch): Promise<Profile> {
  const { data, error } = await getSupabase()
    .from("profiles")
    .update(patch)
    .eq("id", profileId)
    .select("*")
    .single();

  if (error) throw error;
  return data as Profile;
}

/** The basics before Haps can recommend well: how they found Haps, their city, and one thing they like. Name is optional. */
export function missingOnboarding(profile: Profile, taste: TasteSignal[]): OnboardingField[] {
  const missing: OnboardingField[] = [];
  if (!profile.found_us?.trim()) missing.push("found_us");
  if (!profile.city?.trim()) missing.push("city");
  if (!taste.some((signal) => signal.kind === "like")) missing.push("taste");
  return missing;
}

export function isOnboarded(profile: Profile, taste: TasteSignal[]): boolean {
  return missingOnboarding(profile, taste).length === 0;
}

/** Which of the ten things onboarding learns are still unknown, for Claude to pick the next question from. */
export function unknownTopics(profile: Profile, taste: TasteSignal[]): string[] {
  const has = (...categories: string[]) => taste.some((signal) => signal.category && categories.includes(signal.category));
  const topics: [string, boolean][] = [
    ["where they go out (city, neighborhoods)", Boolean(profile.city && (profile.area || profile.neighborhoods))],
    ["how far they'll travel", Boolean(profile.travel)],
    ["what they like doing (parties, food, live music, comedy...)", has("activity")],
    ["specific tastes (music, food, scenes)", has("music", "food", "scene")],
    ["the vibe they want", has("vibe")],
    ["budget for a normal night", Boolean(profile.budget)],
    ["who they go out with", Boolean(profile.social) || has("social")],
    ["when they go out and how they plan", Boolean(profile.going_out) || has("timing")],
    ["dealbreakers", taste.some((signal) => signal.kind === "dislike" || signal.kind === "constraint")],
    ["favorite places and why", has("place")],
    ["what they want Haps to make better", Boolean(profile.discovery_goal) || has("goal")],
  ];
  return topics.filter(([, known]) => !known).map(([topic]) => topic);
}

export function applyProfileUpdate(profile: Profile, updated: Profile): void {
  for (const field of PROFILE_FIELDS) profile[field] = updated[field];
}

/** What update_profile can change. */
export const PROFILE_FIELDS = [
  "name",
  "full_name",
  "email",
  "city",
  "area",
  "neighborhoods",
  "travel",
  "budget",
  "going_out",
  "social",
  "discovery_goal",
  "found_us",
] as const satisfies readonly (keyof Profile)[];

export async function markBackgroundCleared(profileId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("profiles")
    .update({ background_set_at: null })
    .eq("id", profileId);

  if (error) throw error;
}
