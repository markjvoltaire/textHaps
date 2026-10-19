import "dotenv/config";
import { datedListingUrls, upsertListing, type ListingRow } from "../db/listings.ts";
import { runActor } from "./apify.ts";
import { fetchDiceDetails } from "./dice.ts";
import { normalizeItems } from "./normalize.ts";
import { scoreListings } from "./organize.ts";

const MAX_ITEMS = 15;

type Source = "luma" | "posh" | "dice";

export async function runIngest(cities = ingestCities()): Promise<void> {
  console.log(`[ingest] start cities=${cities.join(",")}`);
  const saved: ListingRow[] = [];
  const enriched = new Set<string>();

  for (const city of cities) {
    for (const source of ingestSources()) {
      try {
        const items = await scrapeSource(source, city);
        const drafts = normalizeItems(source, city, items);
        console.log(`[ingest] ${source} ${city} items=${drafts.length}`);
        const known = source === "dice" ? await datedListingUrls("dice") : new Set<string>();
        for (const draft of drafts) {
          if (!draft.url) continue;
          if (source === "dice" && !draft.starts_at && !known.has(draft.url)) {
            Object.assign(draft, definedOnly(await fetchDiceDetails(draft.url)));
            if (draft.starts_at) enriched.add(draft.url);
          }
          const row = await upsertListing(draft);
          if (row) saved.push(row);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[ingest] ${source} ${city} failed: ${msg}`);
      }
    }
  }

  const rescoreAll = process.env.INGEST_RESCORE === "1";
  const unscored = saved.filter(
    (row) => rescoreAll || row.keep_score == null || (row.url !== null && enriched.has(row.url)),
  );
  await scoreListings(unscored);
  console.log(`[ingest] done saved=${saved.length} scored=${unscored.length}`);
}

function definedOnly<T extends object>(value: T | null): Partial<T> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function ingestCities(): string[] {
  const raw = process.env.INGEST_CITIES ?? "Miami";
  return raw.split(",").map((part) => part.trim()).filter(Boolean);
}

function ingestSources(): Source[] {
  const raw = (process.env.INGEST_SOURCES ?? "luma,posh,dice").toLowerCase();
  return raw.split(",").filter((part): part is Source => part === "luma" || part === "posh" || part === "dice");
}

async function scrapeSource(source: Source, city: string): Promise<unknown[]> {
  if (source === "luma") {
    return runActor("aitorsm/luma-events", {
      searchType: "city",
      city: lumaCity(city),
      period: "future",
      maxItems: MAX_ITEMS,
      enrichEventDetails: true,
    });
  }
  if (source === "posh") {
    return runActor("aitorsm/posh-events", {
      searchType: "city",
      city: poshCity(city),
      when: "This Week",
      sort: "Trending",
      maxItems: MAX_ITEMS,
      enrichOrganizers: false,
    });
  }
  return runActor("aitorsm/dice-events", {
    city: diceCity(city),
    maxItems: MAX_ITEMS,
  });
}

function lumaCity(city: string): string {
  const slug = city.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (slug === "nyc" || slug.includes("newyork")) return "nyc";
  if (slug === "miami") return "miami";
  return city.toLowerCase();
}

function poshCity(city: string): string {
  const slug = city.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (slug === "nyc" || slug.includes("newyork")) return "New York City";
  if (slug === "miami") return "Miami";
  return city;
}

function diceCity(city: string): string {
  const slug = city.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (slug === "nyc" || slug.includes("newyork")) return "New York";
  return city;
}

const isMain = process.argv[1]?.includes("ingest/run");
if (isMain) {
  // Runs as a Render cron job, so exit explicitly once done instead of waiting on open sockets.
  try {
    await runIngest();
    process.exit(0);
  } catch (err) {
    console.error(`[ingest] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
