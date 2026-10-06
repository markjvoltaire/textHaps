export type DiceDetails = {
  starts_at?: string;
  ends_at?: string;
  description?: string;
};

// The Dice list view has no dates, but each event page carries schema.org JSON-LD.
export async function fetchDiceDetails(url: string): Promise<DiceDetails | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const html = await response.text();
    for (const match of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
      const event = findEvent(parseJson(match[1]));
      if (!event) continue;
      return {
        starts_at: toIso(event.startDate),
        ends_at: toIso(event.endDate),
        description: typeof event.description === "string" ? event.description.trim().slice(0, 1500) : undefined,
      };
    }
  } catch {
    // Details are best-effort; the listing is still saved without them.
  }
  return null;
}

function parseJson(raw: string | undefined): unknown {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function findEvent(node: unknown): Record<string, unknown> | null {
  const nodes = Array.isArray(node) ? node : [node];
  for (const item of nodes) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const type = record["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((t) => typeof t === "string" && t.endsWith("Event"))) return record;
  }
  return null;
}

function toIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}
