import type { Space } from "spectrum-ts";
import { setRsvpStatus, staleRsvps, startRsvp, type RsvpRow } from "../db/rsvps.ts";
import { getSupabase } from "../db/client.ts";
import type { Profile, SaveRow } from "../db/types.ts";
import { appendAssistantTurn } from "../memory/history.ts";
import { formatError } from "../utils/text.ts";
import { resultText, runRsvp } from "./run.ts";

const SWEEP_MS = 60_000;
// The agent bumps its heartbeat every step and every 2s while waiting on a code, so 3 minutes quiet is a dead worker.
const STALE_MS = 3 * 60_000;

let spaceFor: ((id: string) => Promise<Space>) | undefined;

/** Texts them in the conversation the RSVP came from, and keeps it in the thread so their reply makes sense. */
async function textThem(profile: Profile, spaceId: string, text: string): Promise<void> {
  if (!spaceFor) throw new Error("rsvp texts aren't set up: startRsvps wasn't called");
  const space = await spaceFor(spaceId);
  for (const line of text.split("\n")) await space.send(line);
  await appendAssistantTurn(profile.id, profile.platform_user_id, text).catch((err: unknown) =>
    console.error(`[rsvp] history save failed: ${formatError(err)}`),
  );
}

/**
 * Starts an RSVP in the background and returns right away, so the reply ("on it") goes out while the
 * browser works. Null when this event already has one going.
 */
export async function beginRsvp(input: { profile: Profile; save: SaveRow; url: string; platform: string; spaceId: string }): Promise<RsvpRow | null> {
  const { profile, save, url, platform, spaceId } = input;
  const rsvp = await startRsvp({ profileId: profile.id, saveId: save.id, url, platform, spaceId });
  if (!rsvp) return null;
  // A flyer save found its page through search: keep the link with the save.
  if (!save.url) {
    const { error } = await getSupabase().from("saves").update({ url }).eq("id", save.id).is("url", null);
    if (error) console.warn(`[rsvp] couldn't keep the link on save=${save.id}: ${formatError(error)}`);
  }
  console.log(`[rsvp] start id=${rsvp.id} save=${save.id} url=${url}`);
  void runRsvp({ rsvp, profile, save }, { notify: (text) => textThem(profile, spaceId, text) });
  return rsvp;
}

type StaleRsvp = RsvpRow & { profiles: Profile; saves: SaveRow };

/**
 * Wires up texting and closes out runs a deploy cut off, from this worker's platform only. A run is
 * marked failed once, so if the old worker comes back to it, it doesn't text them a second time.
 */
export function startRsvps(platform: string, getSpace: (id: string) => Promise<Space>): () => void {
  spaceFor = getSpace;
  const sweep = async () => {
    try {
      for (const rsvp of (await staleRsvps(STALE_MS)) as StaleRsvp[]) {
        if (rsvp.platform !== platform) continue;
        if (!(await setRsvpStatus(rsvp.id, "failed", "error"))) continue;
        console.warn(`[rsvp] id=${rsvp.id} went quiet, closing it out`);
        const text = `${resultText("error", rsvp.saves, rsvp.url, rsvp.profiles.email ?? "")}\nor say the word and i'll run it again`;
        await textThem(rsvp.profiles, rsvp.space_id, text).catch((err: unknown) =>
          console.error(`[rsvp] cut-off text failed id=${rsvp.id}: ${formatError(err)}`),
        );
      }
    } catch (err) {
      console.error(`[rsvp] sweep failed: ${formatError(err)}`);
    }
  };
  const timer = setInterval(() => void sweep(), SWEEP_MS);
  return () => clearInterval(timer);
}
