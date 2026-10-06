import type { ListingDraft } from "../db/listings.ts";

export function normalizeItems(source: string, city: string, items: unknown[]): ListingDraft[] {
  return items
    .map((item) => normalizeItem(source, city, item))
    .filter((draft): draft is ListingDraft => Boolean(draft));
}

function normalizeItem(source: string, city: string, item: unknown): ListingDraft | null {
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
      description: asText(event.description) ?? "",
      city: asText(geo?.city) ?? city,
      venue: asText(geo?.full_address) ?? asText(geo?.short_address),
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
      url: asText(row.url) ?? asText(row.link),
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
      source_id: asText(row.url),
      url: asText(row.url),
      title,
      description: asText(row.description) ?? "",
      city: asText(row.city) ?? city,
      venue: asText(row.place) ?? asText(row.location),
      starts_at:
        asText(row.doorsOpenDate) ?? unixToIso(row.date_unix) ?? parseDiceDatetime(asText(row.datetime)),
      image_url: asText(row.image),
      tags: asText(row.tags) ? [asText(row.tags)!] : [],
      raw: row,
    };
  }

  return null;
}

function unixToIso(value: unknown): string | undefined {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined;
}

function parseDiceDatetime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
