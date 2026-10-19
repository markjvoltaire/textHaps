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
  const last = warnedAt.get(profileId);
  if (last && Date.now() - last < (window === "day" ? DAY_MS : HOUR_MS)) return false;
  warnedAt.set(profileId, Date.now());
  return true;
}
