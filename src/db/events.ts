import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSupabase } from "./client.ts";
import type { EventRow } from "./types.ts";

const EVENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "events");

export function resolveEventImage(imagePath: string): string {
  return join(EVENTS_DIR, imagePath);
}

export type EventSearch = {
  city: string;
  query?: string;
  tags?: string[];
  from?: string;
  to?: string;
  limit?: number;
};

export async function listCatalogEvents(): Promise<EventRow[]> {
  const { data, error } = await getSupabase()
    .from("events")
    .select("*")
    .order("starts_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as EventRow[];
}

/** For now the test catalog is the whole set — ignore city, tags, and dates. */
export async function searchEvents(_input: EventSearch): Promise<EventRow[]> {
  return listCatalogEvents();
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
    const hook = event.vibe ?? event.tags.slice(0, 3).join(", ");
    return where ? `${event.title} — ${hook}. ${where}.` : `${event.title} — ${hook}.`;
  });
  return `Here's what I found.\n\n${lines.join("\n")}`;
}

export async function listEventFlyers(): Promise<string[]> {
  const { data, error } = await getSupabase()
    .from("events")
    .select("image_path")
    .not("image_path", "is", null)
    .order("starts_at", { ascending: true });

  if (error) throw error;
  return (data ?? [])
    .map((row) => (row as { image_path: string | null }).image_path)
    .filter((path): path is string => Boolean(path))
    .map(resolveEventImage);
}
