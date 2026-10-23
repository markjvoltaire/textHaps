import { countUserTurnsSince } from "../memory/history.ts";

const HOURLY_LIMIT = Number(process.env.RATE_LIMIT_HOURLY ?? 30);
const DAILY_LIMIT = Number(process.env.RATE_LIMIT_DAILY ?? 100);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type RateCheck = { ok: true } | { ok: false; window: "hour" | "day" };

/** Counts recent messages per number so one sender can't run up the Claude and Jev bill. */
export async function checkRateLimit(profileId: string): Promise<RateCheck> {
  const now = Date.now();
  const [lastHour, lastDay] = await Promise.all([
    countUserTurnsSince(profileId, new Date(now - HOUR_MS)),
    countUserTurnsSince(profileId, new Date(now - DAY_MS)),
  ]);
  if (lastDay >= DAILY_LIMIT) return { ok: false, window: "day" };
  if (lastHour >= HOURLY_LIMIT) return { ok: false, window: "hour" };
  return { ok: true };
}

/** Last time each profile was told it hit the limit, so a spammer gets one notice, not a reply per text. */
const warnedAt = new Map<string, number>();

export function shouldWarn(profileId: string, window: "hour" | "day"): boolean {
  pruneStale();
  const last = warnedAt.get(profileId);
  if (last && Date.now() - last < (window === "day" ? DAY_MS : HOUR_MS)) return false;
  warnedAt.set(profileId, Date.now());
  return true;
}

const VOICE_FAILURES_PER_HOUR = 5;

/** Failed voice notes never reach history, so they're counted here to cap Deepgram spend on junk audio. */
const voiceFailures = new Map<string, number[]>();

export function voiceAllowed(profileId: string): boolean {
  pruneStale();
  const recent = (voiceFailures.get(profileId) ?? []).filter((at) => Date.now() - at < HOUR_MS);
  if (recent.length === 0) voiceFailures.delete(profileId);
  else voiceFailures.set(profileId, recent);
  return recent.length < VOICE_FAILURES_PER_HOUR;
}

export function noteVoiceFailure(profileId: string): void {
  voiceFailures.set(profileId, [...(voiceFailures.get(profileId) ?? []), Date.now()]);
}

let lastPrune = Date.now();

/** Drops entries that can no longer block anyone, at most once an hour, so the maps don't grow forever. */
function pruneStale(): void {
  const now = Date.now();
  if (now - lastPrune < HOUR_MS) return;
  lastPrune = now;
  for (const [id, at] of warnedAt) if (now - at >= DAY_MS) warnedAt.delete(id);
  for (const [id, times] of voiceFailures) if (times.every((at) => now - at >= HOUR_MS)) voiceFailures.delete(id);
}
