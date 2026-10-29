import { getSupabase } from "../db/client.ts";
import type { SaveRow } from "../db/types.ts";
import { metroFor } from "../utils/metro.ts";

export type ReminderKind = "check_in" | "day_of" | "follow_up";

const HOUR = 3600_000;
/** A reminder this close to now isn't worth a text: they just talked about it. */
const MIN_LEAD_MS = 12 * HOUR;

/** The supported metros' zones. Everywhere else is assumed Eastern until Haps knows better. */
export function zoneFor(city: string | null): string {
  return city && metroFor(city) === "la" ? "America/Los_Angeles" : "America/New_York";
}

/** How far `zone` is ahead of UTC at `at`, in ms. */
function zoneOffset(zone: string, at: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  return Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!) - at;
}

/** The instant it's `hour`:00 on `date` (YYYY-MM-DD), `daysBefore` days earlier, on the clocks in `zone`. */
export function localTime(date: string, hour: number, zone: string, daysBefore = 0): number {
  const wall = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) - daysBefore, hour);
  // Twice, so a day that crosses a clock change lands on the right side of it.
  const first = wall - zoneOffset(zone, wall);
  return wall - zoneOffset(zone, first);
}

/** A start before this hour belongs to the night before: doors at 12:30am sunday is a saturday night out. */
const NIGHT_ENDS = 5;

/** The day before `date` (YYYY-MM-DD). */
function dayBefore(date: string): string {
  return new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) - 1)).toISOString().slice(0, 10);
}

/** For an event that starts after midnight, the day whose night it is (YYYY-MM-DD). Null for any other start. */
export function lateNightOf(save: Pick<SaveRow, "starts_at">, zone: string): string | null {
  const start = save.starts_at ? Date.parse(save.starts_at) : NaN;
  if (Number.isNaN(start)) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" })
      .formatToParts(new Date(start))
      .map((part) => [part.type, part.value]),
  );
  return +parts.hour! < NIGHT_ENDS ? dayBefore(`${parts.year}-${parts.month}-${parts.day}`) : null;
}

/** The day reminders count from: the night it belongs to, so "tomorrow", "today" and "last night" are said on the right days. */
function nightOf(save: Pick<SaveRow, "starts_at" | "event_date">, zone: string): string | null {
  return save.event_date && (lateNightOf(save, zone) ?? save.event_date);
}

/**
 * When to text about a saved event. A check-in the day before at 7pm ("still going tomorrow?"),
 * a heads-up at noon the day of (skipped for something that starts before 2pm, since the night
 * before covers it), and a follow-up at 1pm the day after ("did you go? how was it?"). A party that
 * starts after midnight counts as the night before, so 12:30am sunday is reminded about as saturday.
 * Anything already past, or too soon after saving, is left out.
 */
export function reminderTimes(
  save: Pick<SaveRow, "starts_at" | "event_date">,
  zone: string,
  now = Date.now(),
): Partial<Record<ReminderKind, number>> {
  const night = nightOf(save, zone);
  if (!night) return {};
  const start = save.starts_at ? Date.parse(save.starts_at) : null;
  const early = start !== null && start < localTime(night, 14, zone);
  const times: Partial<Record<ReminderKind, number>> = {
    check_in: localTime(night, 19, zone, 1),
    follow_up: localTime(night, 13, zone, -1),
  };
  if (!early) times.day_of = localTime(night, 12, zone);
  for (const kind of Object.keys(times) as ReminderKind[]) {
    if (times[kind]! < now + MIN_LEAD_MS) delete times[kind];
  }
  return times;
}

/**
 * The last moment a reminder is still worth sending, when the worker was down or a send failed:
 * a check-in until the day of starts, a heads-up until the event does (6pm when the time isn't
 * known), and a follow-up until two days after.
 */
export function reminderDeadline(
  kind: ReminderKind,
  save: Pick<SaveRow, "starts_at" | "event_date">,
  zone: string,
  sendAt: number,
): number {
  // Rows are only planned with a date, but a later save can clear it.
  const night = nightOf(save, zone);
  if (!night) return sendAt + 3 * HOUR;
  if (kind === "check_in") return localTime(night, 0, zone);
  if (kind === "day_of") return save.starts_at ? Date.parse(save.starts_at) : localTime(night, 18, zone);
  return localTime(night, 0, zone, -3);
}

/**
 * Sets this save's reminders to match when it is now: new times replace old ones, and a
 * reminder that no longer fits is dropped. One that already went out is left alone.
 * Nothing is planned unless they said yes to reminders.
 */
export async function scheduleReminders(
  save: SaveRow,
  where: { platform: string; spaceId: string; zone: string },
): Promise<Partial<Record<ReminderKind, number>>> {
  const times = save.remind ? reminderTimes(save, where.zone) : {};
  const supabase = getSupabase();
  const { error: dropError } = await supabase.from("reminders").delete().eq("save_id", save.id).is("sent_at", null);
  if (dropError) throw dropError;
  const rows = (Object.entries(times) as [ReminderKind, number][]).map(([kind, at]) => ({
    profile_id: save.profile_id,
    save_id: save.id,
    kind,
    send_at: new Date(at).toISOString(),
    platform: where.platform,
    space_id: where.spaceId,
  }));
  if (rows.length) {
    // A kind that already went out keeps its row, so it isn't sent twice.
    const { error } = await supabase.from("reminders").upsert(rows, { onConflict: "save_id,kind", ignoreDuplicates: true });
    if (error) throw error;
  }
  return times;
}
