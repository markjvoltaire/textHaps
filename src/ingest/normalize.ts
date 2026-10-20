import type { ListingDraft } from "../db/listings.ts";
import { metroFor } from "../utils/metro.ts";

/** `city` is the city we scraped for. It sets the metro, whatever neighborhood the source reports. */
export function normalizeItems(source: string, city: string, items: unknown[]): ListingDraft[] {
  const metro = metroFor(city);
  return items
    .map((item) => normalizeItem(source, city, item))
    .filter((draft): draft is Omit<ListingDraft, "metro"> => Boolean(draft))
    .map((draft) => ({ ...draft, metro }));
}

function normalizeItem(source: string, city: string, item: unknown): Omit<ListingDraft, "metro"> | null {
  if (!item || typeof item !== "object") return null;
  const row = item as Record<string, unknown>;

  if (source === "luma") {
    const event = asRecord(row.event) ?? row;
    const geo = asRecord(event.geo_address_info);
    const title = asText(event.name);
    if (!title) return null;
    return {
      source,
      source_id: asText(event.api_id) ?? asText(event.id),
      url: asText(event.url) ?? asText(row.url),
      title,
      description: asText(event.description) ?? asText(row.description) ?? "",
      city: asText(geo?.city) ?? city,
      // `address` is the place name ("Magic 13 Brewing Co."); full_address is the street address.
      venue: asText(geo?.address),
      starts_at: asText(event.start_at),
      ends_at: asText(event.end_at),
      image_url: asText(event.cover_url),
      raw: row,
    };
  }

  if (source === "posh") {
    const title = asText(row.name);
    if (!title) return null;
    const venue = asRecord(row.venue);
    return {
      source,
      source_id: asText(row._id) ?? asText(row.id),
      url: poshUrl(row),
      title,
      description: asText(row.shortDescription) ?? asText(row.description) ?? "",
      city: asText(row.city) ?? city,
      venue: asText(venue?.name) ?? asText(row.venueName),
      starts_at: asText(row.startUtc),
      ends_at: asText(row.endUtc),
      image_url: asText(row.flyer) ?? asText(row.image),
      raw: row,
    };
  }

  if (source === "dice") {
    const title = asText(row.name);
    if (!title) return null;
    return {
      source,
      source_id: asText(row.eventId) ?? asText(row.url),
      url: asText(row.url),
      title,
      description: "",
      city: asText(row.venueCity) ?? city,
      venue: asText(row.venueName),
      starts_at: asText(row.startIso) ?? unixToIso(row.startUnix),
      image_url: asText(row.imageUrl),
      tags: asText(row.eventTag) ? [asText(row.eventTag)!] : [],
      raw: row,
    };
  }

  return null;
}

function poshUrl(row: Record<string, unknown>): string | undefined {
  const full = asText(row.event_page_url);
  if (full) return full;
  const slug = asText(row.url) ?? asText(row.link);
  if (!slug) return undefined;
  return /^https?:\/\//.test(slug) ? slug : `https://posh.vip/${slug}`;
}

function unixToIso(value: unknown): string | undefined {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
