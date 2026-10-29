import type { Space } from "spectrum-ts";
import { getSupabase } from "../db/client.ts";
import type { Profile, SaveRow } from "../db/types.ts";
import { hasFeedback } from "../db/feedback.ts";
import { appendAssistantTurn, getHistory } from "../memory/history.ts";
import { formatError } from "../utils/text.ts";
import { reminderDeadline, zoneFor, type ReminderKind } from "./schedule.ts";
import { writeReminder } from "./write.ts";

const POLL_MS = 60_000;
/** A claim this old is a worker that died mid-send, so another worker can take the reminder. */
const LEASE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

type DueReminder = {
  id: string;
  kind: ReminderKind;
  send_at: string;
  space_id: string;
  claimed_at: string | null;
  attempts: number;
  profiles: Profile;
  saves: SaveRow;
};

/**
 * Sends reminders as they come due, from this worker's platform only, so a terminal session
 * never texts an iMessage user. Returns a stop function.
 */
export function startReminders(platform: string, spaceFor: (id: string) => Promise<Space>): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sendDue(platform, spaceFor);
    } catch (err) {
      console.error(`[remind] tick failed: ${formatError(err)}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), POLL_MS);
  console.log(`[remind] on for platform=${platform}`);
  return () => clearInterval(timer);
}

/** Gives up on a reminder for good, with the reason in the logs and on the row. */
async function drop(reminder: DueReminder, reason: string): Promise<void> {
  console.log(`[remind] drop id=${reminder.id} kind=${reminder.kind} attempts=${reminder.attempts}, ${reason}`);
  const { error } = await getSupabase()
    .from("reminders")
    .update({ dropped_at: new Date().toISOString(), claimed_at: null, last_error: reason })
    .eq("id", reminder.id);
  if (error) console.error(`[remind] drop failed id=${reminder.id}: ${formatError(error)}`);
}

async function sendDue(platform: string, spaceFor: (id: string) => Promise<Space>): Promise<void> {
  const now = Date.now();
  const leaseCutoff = new Date(now - LEASE_MS).toISOString();
  const { data, error } = await getSupabase()
    .from("reminders")
    .select("id, kind, send_at, space_id, claimed_at, attempts, profiles(*), saves(*)")
    .eq("platform", platform)
    .is("sent_at", null)
    .is("dropped_at", null)
    .lte("send_at", new Date(now).toISOString())
    .or(`claimed_at.is.null,claimed_at.lt."${leaseCutoff}"`)
    .order("send_at", { ascending: true })
    .limit(20);
  if (error) throw error;

  for (const reminder of (data ?? []) as unknown as DueReminder[]) {
    // Claimed before anything is sent: during a deploy both workers see it, and only one wins.
    // Matching the claim it was read with means a stale lease is taken over by one worker, not both.
    let claim = getSupabase()
      .from("reminders")
      .update({ claimed_at: new Date().toISOString() })
      .eq("id", reminder.id)
      .is("sent_at", null)
      .is("dropped_at", null);
    claim = reminder.claimed_at ? claim.eq("claimed_at", reminder.claimed_at) : claim.is("claimed_at", null);
    const { data: claimed, error: claimError } = await claim.select("id");
    if (claimError) throw claimError;
    if (!claimed?.length) continue;

    const { profiles: profile, saves: save } = reminder;
    const zone = zoneFor(profile.city);
    if (reminder.kind === "follow_up" && (await hasFeedback(save.id))) {
      await drop(reminder, "they already said how it went");
      continue;
    }
    if (Date.now() > reminderDeadline(reminder.kind, save, zone, Date.parse(reminder.send_at))) {
      await drop(reminder, "past its deadline");
      continue;
    }
    if (reminder.attempts >= MAX_ATTEMPTS) {
      await drop(reminder, "out of attempts");
      continue;
    }

    let text = "";
    let linesSent = 0;
    try {
      const history = await getHistory(profile.id);
      text = await writeReminder({ profile, save, kind: reminder.kind, zone, history });
      const space = await spaceFor(reminder.space_id);
      for (const line of text.split("\n")) {
        await space.send(line);
        linesSent += 1;
      }
    } catch (err) {
      // Once any line went out, a retry would double-text them, so it counts as sent.
      if (!linesSent) {
        const attempts = reminder.attempts + 1;
        console.error(`[remind] send failed id=${reminder.id} attempt=${attempts}: ${formatError(err)}`);
        const { error: releaseError } = await getSupabase()
          .from("reminders")
          .update({ claimed_at: null, attempts, last_error: formatError(err).slice(0, 500) })
          .eq("id", reminder.id);
        // Left claimed, it's retried once the lease runs out.
        if (releaseError) console.error(`[remind] release failed id=${reminder.id}: ${formatError(releaseError)}`);
        continue;
      }
      console.error(`[remind] send broke after ${linesSent} line(s) id=${reminder.id}, not retrying: ${formatError(err)}`);
    }

    // If this write fails, the lease keeps other workers off it for 10 minutes; that's the one double-text risk left.
    const { error: sentError } = await getSupabase()
      .from("reminders")
      .update({ sent_at: new Date().toISOString(), claimed_at: null })
      .eq("id", reminder.id);
    if (sentError) console.error(`[remind] marking sent failed id=${reminder.id}: ${formatError(sentError)}`);
    console.log(`[remind] sent id=${reminder.id} kind=${reminder.kind} space=${reminder.space_id} text=${JSON.stringify(text)}`);
    // In the thread, so their reply ("yeah still going") makes sense to Haps.
    await appendAssistantTurn(profile.id, profile.platform_user_id, text).catch((err: unknown) =>
      console.error(`[remind] history save failed id=${reminder.id}: ${formatError(err)}`),
    );
  }
}
