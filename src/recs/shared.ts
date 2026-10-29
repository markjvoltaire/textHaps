import { describeWhen, type EventDetails } from "../agent/eventLink.ts";
import { getSupabase } from "../db/client.ts";
import { recKey, recText, type RecDraft } from "../db/recs.ts";
import type { Profile } from "../db/types.ts";
import { embedDocument } from "../search/embed.ts";
import { CURATED_RECS_ON } from "../search/recs.ts";
import { metroFor } from "../utils/metro.ts";
import { formatError } from "../utils/text.ts";

/**
 * An event someone sent Haps, kept as a rec draft with who sent it, so what one person finds can
 * reach others once it's approved. Drafts are never sent to anyone until someone approves them.
 * The first person to send an event keeps the credit; later sends of the same one are skipped.
 */
export async function saveSharedRec(profile: Profile, url: string, event: EventDetails): Promise<void> {
  const name = event.title ?? event.venue;
  const city = event.city ?? profile.city;
  if (!name || !city) return;
  const draft: RecDraft = {
    metro: metroFor(city),
    name,
    category: event.category ?? "party",
    neighborhood: event.neighborhood,
    address: event.address,
    url,
    why: event.summary ?? [event.title, event.venue && `at ${event.venue}`].filter(Boolean).join(" "),
    best_for: event.best_for,
    vibe: event.vibe,
    music: event.music,
    crowd: event.crowd,
    price: event.price_note,
    schedule: event.starts_at ? describeWhen(event.starts_at, event.ends_at).when : null,
    vouched_by: [],
    sources: [url],
    status: "draft",
    submitted_by: profile.id,
  };
  try {
    // With curated recs off the model stays unloaded (512 MB worker); `npm run vectors` fills it in later.
    const embedding = CURATED_RECS_ON ? await embedDocument(recText(draft), draft.name) : null;
    const { error } = await getSupabase()
      .from("recs")
      .upsert(
        { ...draft, key: recKey(draft.name), embedding: embedding && JSON.stringify(embedding), last_checked: new Date().toISOString() },
        { onConflict: "metro,key", ignoreDuplicates: true },
      );
    if (error) throw error;
    console.log(`[recs] shared rec kept name=${JSON.stringify(name)} metro=${draft.metro} by=${profile.id}`);
  } catch (err) {
    console.error(`[recs] shared rec failed for ${url}: ${formatError(err)}`);
  }
}
