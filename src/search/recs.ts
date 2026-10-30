import { getRecs, matchRecs, type RecRow } from "../db/recs.ts";
import { embedQuery } from "./embed.ts";
import { withTaste } from "./taste.ts";

/**
 * Whether Haps searches its own curated recs database. Off, every place and event search goes to the
 * web (Exa) and the ~400 MB embedding model is never loaded, which a 512 MB worker needs.
 * CURATED_RECS=off turns it off; RECS_SEARCH=off is the old name for the same switch.
 */
export const CURATED_RECS_ON = process.env.CURATED_RECS !== "off" && process.env.RECS_SEARCH !== "off";

/** Metros with an approved recs list. Search there comes from the recs, with the live web as the fallback. */
export const RECS_METROS = new Set(CURATED_RECS_ON ? ["miami", "la"] : []);

export type RecResult = Pick<
  RecRow,
  "id" | "metro" | "name" | "category" | "neighborhood" | "address" | "url" | "why" | "best_for" | "vibe" | "music" | "crowd" | "price" | "schedule"
> & { url_checked_at: string | null; image_url: string | null };

/** The approved recs closest in meaning to the ask, nearest first, nudged toward their taste when there is one. */
export async function searchRecs(
  query: string,
  metro: string,
  options: { categories?: string[]; limit?: number; taste?: number[] } = {},
): Promise<RecResult[]> {
  const matches = await matchRecs(withTaste(await embedQuery(query), options.taste), { metro, categories: options.categories, limit: options.limit ?? 8 });
  const rows = new Map((await getRecs(matches.map((match) => match.id))).map((row) => [row.id, row]));
  return matches.flatMap((match) => {
    const row = rows.get(match.id);
    if (!row) return [];
    const { id, metro, name, category, neighborhood, address, url, url_checked_at, why, best_for, vibe, music, crowd, price, schedule } = row;
    return [{ id, metro, name, category, neighborhood, address, url, url_checked_at, image_url: row.image_url ?? null, why, best_for, vibe, music, crowd, price, schedule }];
  });
}
