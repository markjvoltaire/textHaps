import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jevNoulScores } from "../jev/client.ts";
import { listKeptListings } from "./listings.ts";
import { getSupabase } from "./client.ts";
import type { EventRow, TasteSignal } from "./types.ts";

const EVENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "events");

export function resolveEventImage(imagePath: string): string {
  if (/^https?:\/\//i.test(imagePath)) return imagePath;
  return join(EVENTS_DIR, imagePath);
}

export type EventSearch = {
  city: string;
  query?: string;
  tags?: string[];
  from?: string;
  to?: string;
  limit?: number;
  taste?: TasteSignal[];
};

export async function listCatalogEvents(): Promise<EventRow[]> {
  const { data, error } = await getSupabase()
    .from("events")
    .select("*")
    .order("starts_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as EventRow[];
}

const MAX_RECS = 5;

/** One slot per night: collapse "(Friday Pass)" style series, then cap the list. */
function topPicks(events: EventRow[]): EventRow[] {
  const seen = new Set<string>();
  const picks: EventRow[] = [];
  for (const event of events) {
    const key = event.title
      .toLowerCase()
      .replace(/\(.*?\)/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push(event);
    if (picks.length >= MAX_RECS) break;
  }
  return picks;
}

const DEFAULT_WINDOW_MS = 21 * 24 * 60 * 60 * 1000;

function withinWindow(events: EventRow[], input: EventSearch): EventRow[] {
  const from = Date.parse(input.from ?? "") || Date.now();
  const to = Date.parse(input.to ?? "") || Date.now() + DEFAULT_WINDOW_MS;
  return events.filter((event) => {
    const start = Date.parse(event.starts_at);
    return Number.isNaN(start) || (start >= from && start <= to);
  });
}

/** Rank ingested nights, then the test catalog, against the user's ask and taste. */
export async function searchEvents(input: EventSearch): Promise<EventRow[]> {
  const ingested = withinWindow(await listKeptListings(input.city), input);
  if (ingested.length > 0) {
    let ordered = ingested;
    try {
      const ranked = await rankNights(ingested, input);
      if (ranked.length > 0) ordered = ranked;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[jev] listing rank failed: ${msg}`);
    }
    const picks = topPicks(ordered);
    console.log(`[search] listings ${picks.length}/${ingested.length} for ${input.city}`);
    return picks;
  }

  const catalog = await listCatalogEvents();
  let ordered = catalog;
  try {
    const ranked = await rankNights(catalog, input);
    if (ranked.length > 0) ordered = ranked;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[jev] rank failed: ${msg}`);
  }
  return topPicks(ordered);
}

export async function getEvent(id: string): Promise<EventRow | null> {
  const { data, error } = await getSupabase()
    .from("events")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return (data as EventRow | null) ?? null;
}

/** Fallback only, used when Claude returns no text. Short on purpose. */
export function formatCatalogOverview(events: EventRow[]): string {
  const lines = events.slice(0, 3).map((event) => {
    const where = event.venue ? ` at ${event.venue}` : "";
    return `${event.title}${where}`;
  });
  return `got a few for you: ${lines.join(", ")}. want me to dig into one?`;
}

/** Flyers for the nights this reply actually searched. No search, no flyers. */
export function eventFlyers(events: EventRow[]): string[] {
  return events
    .map((event) => event.image_path)
    .filter((path): path is string => Boolean(path))
    .map(resolveEventImage);
}

async function rankNights(nights: EventRow[], input: EventSearch): Promise<EventRow[]> {
  if (!process.env.JEV_API_KEY && !process.env.TYPESAFE_API_KEY) return nights;

  const ask = [input.query, input.tags?.join(", "), input.city].filter(Boolean).join(" · ");
  const taste = formatTaste(input.taste);
  const questions: Record<string, { type: "noul"; instructions: string }> = {};
  for (const event of nights) {
    const music = event.music ?? "unknown";
    const crowd = event.crowd ?? "unknown";
    questions[event.id] = {
      type: "noul",
      instructions: `Should Haps recommend this night for someone looking for: ${ask}? Music and crowd matter more than the title. Different bars play different music and pull different crowds. Do not recommend a bottle-service top-40 room for an underground house ask, or a techno warehouse for an afrobeats ask. Event: ${event.title}. Music: ${music}. Crowd: ${crowd}. ${event.vibe ?? ""}. ${event.venue ?? ""}, ${event.city}. ${event.starts_at}. Tags: ${event.tags.join(", ")}. ${taste}`,
    };
  }

  const scores = await jevNoulScores(
    `Today is ${new Date().toISOString().slice(0, 10)}. User city: ${input.city}. Ask: ${ask}. ${taste}`,
    questions,
  );

  const scored = nights
    .map((event) => ({ event, score: scores[event.id] ?? 0 }))
    .sort((a, b) => b.score - a.score);
  const matched = scored.filter((item) => item.score >= 0.55).map((item) => item.event);
  const picked = matched.length > 0 ? matched : scored.slice(0, 2).map((item) => item.event);
  console.log(`[jev] vibe-kept ${picked.length}/${nights.length} nights`);
  return picked;
}

function formatTaste(taste: TasteSignal[] | undefined): string {
  if (!taste || taste.length === 0) return "No saved taste yet.";
  const likes = taste.filter((item) => item.kind === "like").map((item) => item.label);
  const dislikes = taste.filter((item) => item.kind === "dislike").map((item) => item.label);
  const constraints = taste.filter((item) => item.kind === "constraint").map((item) => item.label);
  return `Likes: ${likes.join(", ") || "none"}. Avoid: ${dislikes.join(", ") || "none"}. Constraints: ${constraints.join(", ") || "none"}.`;
}
