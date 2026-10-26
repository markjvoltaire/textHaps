import { getRecs, matchRecs, type RecRow } from "../db/recs.ts";
import { embedQuery } from "./embed.ts";
import { withTaste } from "./taste.ts";

/** The embedding model takes ~400 MB, more than a 512 MB worker has room for. RECS_SEARCH=off turns it and recs search off. */
export const RECS_SEARCH_ON = process.env.RECS_SEARCH !== "off";

/** Metros with an approved recs list. Search there comes from the recs, not the live web. */
export const RECS_METROS = new Set(RECS_SEARCH_ON ? ["miami", "la"] : []);

/** Recs that are nights out, for search_events. Everything else is a place for web_search. */
export const NIGHT_CATEGORIES = ["party", "club", "gay club", "live music", "listening bar", "lounge"];

export type RecResult = Pick<
  RecRow,
  "name" | "category" | "neighborhood" | "address" | "url" | "why" | "best_for" | "vibe" | "music" | "crowd" | "price" | "schedule"
>;

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
    const { name, category, neighborhood, address, url, why, best_for, vibe, music, crowd, price, schedule } = row;
    return [{ name, category, neighborhood, address, url, why, best_for, vibe, music, crowd, price, schedule }];
  });
}
