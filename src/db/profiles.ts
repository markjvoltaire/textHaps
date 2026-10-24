import { getSupabase } from "./client.ts";
import type { OnboardingField, Profile, TasteSignal } from "./types.ts";

export type ProfilePatch = {
  name?: string;
  city?: string;
  area?: string;
  email?: string;
  full_name?: string;
};

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

/** Onboarding is done once we know their taste (vibe, music, places) and city. Name is optional. */
export function missingOnboarding(profile: Profile, taste: TasteSignal[]): OnboardingField[] {
  const missing: OnboardingField[] = [];
  if (!taste.some((signal) => signal.kind === "like")) missing.push("taste");
  if (!profile.city?.trim()) missing.push("city");
  return missing;
}

export function nextOnboardingField(profile: Profile, taste: TasteSignal[]): OnboardingField | null {
  return missingOnboarding(profile, taste)[0] ?? null;
}

export function isOnboarded(profile: Profile, taste: TasteSignal[]): boolean {
  return missingOnboarding(profile, taste).length === 0;
}

export function applyProfileUpdate(profile: Profile, updated: Profile): void {
  profile.name = updated.name;
  profile.city = updated.city;
  profile.area = updated.area;
  profile.email = updated.email;
  profile.full_name = updated.full_name;
}

export async function markBackgroundCleared(profileId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("profiles")
    .update({ background_set_at: null })
    .eq("id", profileId);

  if (error) throw error;
}

export async function markContactCardSent(profileId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("profiles")
    .update({ contact_card_sent_at: new Date().toISOString() })
    .eq("id", profileId);

  if (error) throw error;
}
