import { getRecs, matchRecs, type RecRow } from "../db/recs.ts";
import { embedQuery } from "./embed.ts";

/** The embedding model needs more memory than the 512 MB worker has, so recs search is off unless RECS_SEARCH=on. */
export const RECS_SEARCH_ON = process.env.RECS_SEARCH === "on";

/** Metros with an approved recs list. Search there comes from the recs, not the live web. */
export const RECS_METROS = new Set(RECS_SEARCH_ON ? ["miami", "la"] : []);

/** Recs that are nights out, for search_events. Everything else is a place for web_search. */
export const NIGHT_CATEGORIES = ["party", "club", "gay club", "live music", "listening bar", "lounge"];

export type RecResult = Pick<
  RecRow,
  "name" | "category" | "neighborhood" | "address" | "url" | "why" | "best_for" | "vibe" | "music" | "crowd" | "price" | "schedule"
>;

/** The approved recs closest in meaning to the ask, nearest first. */
export async function searchRecs(
  query: string,
  metro: string,
  options: { categories?: string[]; limit?: number } = {},
): Promise<RecResult[]> {
  const matches = await matchRecs(await embedQuery(query), { metro, categories: options.categories, limit: options.limit ?? 8 });
  const rows = new Map((await getRecs(matches.map((match) => match.id))).map((row) => [row.id, row]));
  return matches.flatMap((match) => {
    const row = rows.get(match.id);
    if (!row) return [];
    const { name, category, neighborhood, address, url, why, best_for, vibe, music, crowd, price, schedule } = row;
    return [{ name, category, neighborhood, address, url, why, best_for, vibe, music, crowd, price, schedule }];
  });
}
