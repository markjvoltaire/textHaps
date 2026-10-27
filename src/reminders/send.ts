import type { Space } from "spectrum-ts";
import { getSupabase } from "../db/client.ts";
import type { Profile, SaveRow } from "../db/types.ts";
import { hasFeedback } from "../db/feedback.ts";
import { appendAssistantTurn, getHistory } from "../memory/history.ts";
import { formatError } from "../utils/text.ts";
import { zoneFor, type ReminderKind } from "./schedule.ts";
import { writeReminder } from "./write.ts";

const POLL_MS = 60_000;
/** A reminder this late (the worker was down) is about a moment that's gone, so it's dropped. */
const STALE_MS = 3 * 3600_000;

type DueReminder = {
  id: string;
  kind: ReminderKind;
  send_at: string;
  space_id: string;
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

async function sendDue(platform: string, spaceFor: (id: string) => Promise<Space>): Promise<void> {
  const now = Date.now();
  const { data, error } = await getSupabase()
    .from("reminders")
    .select("id, kind, send_at, space_id, profiles(*), saves(*)")
    .eq("platform", platform)
    .is("sent_at", null)
    .lte("send_at", new Date(now).toISOString())
    .order("send_at", { ascending: true })
    .limit(20);
  if (error) throw error;

  for (const reminder of (data ?? []) as unknown as DueReminder[]) {
    // Claimed before anything is sent: during a deploy both workers see it, and only one wins.
    const { data: claimed, error: claimError } = await getSupabase()
      .from("reminders")
      .update({ sent_at: new Date().toISOString() })
      .eq("id", reminder.id)
      .is("sent_at", null)
      .select("id");
    if (claimError) throw claimError;
    if (!claimed?.length) continue;

    const { profiles: profile, saves: save } = reminder;
    const late = now - Date.parse(reminder.send_at);
    // The follow-up is meant for after it, so only the reminders before it go stale when it starts.
    const over = reminder.kind !== "follow_up" && save.starts_at ? Date.parse(save.starts_at) < now : false;
    if (reminder.kind === "follow_up" && (await hasFeedback(save.id))) {
      console.log(`[remind] skip id=${reminder.id} kind=follow_up, they already said how it went`);
      continue;
    }
    if (late > STALE_MS || over) {
      console.log(`[remind] skip id=${reminder.id} kind=${reminder.kind}, ${over ? "event started" : `${Math.round(late / 60_000)}m late`}`);
      continue;
    }
    try {
      const zone = zoneFor(profile.city);
      const history = await getHistory(profile.id);
      const text = await writeReminder({ profile, save, kind: reminder.kind, zone, history });
      const space = await spaceFor(reminder.space_id);
      for (const line of text.split("\n")) await space.send(line);
      console.log(`[remind] sent id=${reminder.id} kind=${reminder.kind} space=${reminder.space_id} text=${JSON.stringify(text)}`);
      // In the thread, so their reply ("yeah still going") makes sense to Haps.
      await appendAssistantTurn(profile.id, profile.platform_user_id, text).catch((err: unknown) =>
        console.error(`[remind] history save failed id=${reminder.id}: ${formatError(err)}`),
      );
    } catch (err) {
      // Not retried: it's marked sent, and a second try could double-text them.
      console.error(`[remind] send failed id=${reminder.id}: ${formatError(err)}`);
    }
  }
}
