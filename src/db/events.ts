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

let lastSearch: EventRow[] = [];

export function getLastSearchEvents(): EventRow[] {
  return lastSearch;
}

/** Rank ingested nights, then the test catalog, against the user's ask and taste. */
export async function searchEvents(input: EventSearch): Promise<EventRow[]> {
  const ingested = await listKeptListings(input.city);
  if (ingested.length > 0) {
    lastSearch = ingested;
    try {
      const ranked = await rankNights(ingested, input);
      if (ranked.length > 0) lastSearch = ranked;
      console.log(`[search] listings ${lastSearch.length}/${ingested.length} for ${input.city}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[jev] listing rank failed: ${msg}`);
    }
    return lastSearch;
  }

  const catalog = await listCatalogEvents();
  lastSearch = catalog;
  try {
    const ranked = await rankNights(catalog, input);
    if (ranked.length > 0) lastSearch = ranked;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[jev] rank failed: ${msg}`);
  }
  return lastSearch;
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

export function formatCatalogOverview(events: EventRow[]): string {
  const lines = events.map((event) => {
    const where = [event.venue, event.city].filter(Boolean).join(", ");
    const hook =
      event.vibe ||
      [event.music, event.crowd].filter(Boolean).join(", ") ||
      event.tags.slice(0, 3).join(", ");
    return where ? `${event.title}. ${hook}. ${where}.` : `${event.title}. ${hook}.`;
  });
  return `Here's what I found.\n\n${lines.join("\n")}`;
}

export async function listEventFlyers(): Promise<string[]> {
  const source = lastSearch.length > 0 ? lastSearch : await listCatalogEvents();
  return source
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
