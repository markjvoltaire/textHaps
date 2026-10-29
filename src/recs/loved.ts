import { stripLinks } from "../agent/links.ts";
import { getSupabase } from "../db/client.ts";
import { recKey, recText, type RecDraft } from "../db/recs.ts";
import type { Profile } from "../db/types.ts";
import { embedDocument } from "../search/embed.ts";
import { CURATED_RECS_ON } from "../search/recs.ts";
import { metroFor } from "../utils/metro.ts";
import { formatError } from "../utils/text.ts";
import { findRecSite } from "./link.ts";

export type LovedPlace = {
  name: string;
  /** What kind of spot, like the recs categories: restaurant, cocktail bar, dive bar, club. */
  category: string;
  neighborhood: string | null;
  /** What they love about it, in their words. */
  reason: string | null;
};

/** Words that say what a place is, not which one, so they can't tie a name to a site. */
const GENERIC = new Set(["some", "that", "this", "place", "spot", "spots", "bar", "bars", "club", "lounge", "restaurant", "cafe", "coffee", "kitchen", "grill", "tavern", "pub", "rooftop", "brunch", "miami", "angeles", "york"]);

/**
 * The site's domain has a word of the name in it ("gramps.com" for Gramps). Jev alone once matched
 * "some bar in brickell" to one bar's site, so a vague name or a lookalike place is left out instead.
 */
export function siteNamesIt(url: string, place: Pick<LovedPlace, "name" | "neighborhood">): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/[^a-z0-9]/g, "");
  } catch {
    return false;
  }
  const area = recKey(place.neighborhood ?? "").split(" ");
  return recKey(place.name)
    .split(" ")
    .some((word) => word.length >= 4 && !GENERIC.has(word) && !area.includes(word) && host.includes(word));
}

/** How a user shows up in vouched_by, next to curators like "editorial". */
function voucher(profile: Profile): string {
  return `user:${profile.id}`;
}

/**
 * A favorite spot someone named, kept so what locals love can reach others. A place already in recs
 * gets them as a vouch. A new one becomes a draft credited to them, but only when its own site turns
 * up, which is how "some bar in brickell" or a friend's house is told apart from a real place.
 * Drafts are never sent to anyone until someone approves them.
 */
export async function saveLovedPlace(profile: Profile, place: LovedPlace): Promise<void> {
  if (!profile.city) return;
  const metro = metroFor(profile.city);
  const key = recKey(place.name);
  if (key.length < 3) return;
  try {
    const supabase = getSupabase();
    const { data: existing, error: findError } = await supabase
      .from("recs")
      .select("id, vouched_by")
      .eq("metro", metro)
      .eq("key", key)
      .maybeSingle();
    if (findError) throw findError;
    if (existing) {
      const vouched = (existing.vouched_by ?? []) as string[];
      if (vouched.includes(voucher(profile))) return;
      const { error } = await supabase
        .from("recs")
        .update({ vouched_by: [...vouched, voucher(profile)] })
        .eq("id", existing.id);
      if (error) throw error;
      console.log(`[recs] loved place vouched name=${JSON.stringify(place.name)} metro=${metro} by=${profile.id} vouches=${vouched.length + 1}`);
      return;
    }

    const url = await findRecSite({ id: "", name: place.name, category: place.category, neighborhood: place.neighborhood, metro, url: null, url_checked_at: null });
    if (!url || !siteNamesIt(url, place)) {
      console.log(`[recs] loved place skipped, no clear match name=${JSON.stringify(place.name)} metro=${metro}`);
      return;
    }
    const reason = place.reason ? stripLinks(place.reason).replace(/\s+/g, " ").trim().slice(0, 200) : "";
    const draft: RecDraft = {
      metro,
      name: place.name,
      category: place.category,
      neighborhood: place.neighborhood,
      address: null,
      url,
      why: reason || `a local's favorite ${place.category}`,
      best_for: [],
      vibe: null,
      music: null,
      crowd: null,
      price: null,
      schedule: null,
      vouched_by: [voucher(profile)],
      sources: [url],
      status: "draft",
      submitted_by: profile.id,
    };
    // With recs search off the model stays unloaded (512 MB worker); `npm run vectors` fills it in later.
    const embedding = CURATED_RECS_ON ? await embedDocument(recText(draft), draft.name) : null;
    const { error } = await supabase.from("recs").upsert(
      {
        ...draft,
        key,
        embedding: embedding && JSON.stringify(embedding),
        last_checked: new Date().toISOString(),
        url_checked_at: new Date().toISOString(),
      },
      { onConflict: "metro,key", ignoreDuplicates: true },
    );
    if (error) throw error;
    console.log(`[recs] loved place drafted name=${JSON.stringify(place.name)} metro=${metro} by=${profile.id} url=${url}`);
  } catch (err) {
    console.error(`[recs] loved place failed name=${JSON.stringify(place.name)}: ${formatError(err)}`);
  }
}
