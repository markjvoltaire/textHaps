import { getSupabase } from "./client.ts";
import type { OnboardingField, Profile } from "./types.ts";

export type ProfilePatch = {
  name?: string;
  city?: string;
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

export function missingOnboarding(profile: Profile): OnboardingField[] {
  const missing: OnboardingField[] = [];
  if (!profile.name?.trim()) missing.push("name");
  if (!profile.city?.trim()) missing.push("city");
  return missing;
}

export function nextOnboardingField(profile: Profile): OnboardingField | null {
  return missingOnboarding(profile)[0] ?? null;
}

export function isOnboarded(profile: Profile): boolean {
  return missingOnboarding(profile).length === 0;
}

export function applyProfileUpdate(profile: Profile, updated: Profile): void {
  profile.name = updated.name;
  profile.city = updated.city;
}
