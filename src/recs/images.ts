import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { getSupabase } from "../db/client.ts";
import { formatError } from "../utils/text.ts";
import { findRecImage, saveRecImage, type ImageRec } from "./image.ts";

/**
 * Finds and stores a picture for each approved rec that doesn't have one, for the first-rec carousel.
 * Usage: npm run rec-images -- [--limit 20] [--metro miami] [--only "Boia De"] [--redo] [--no-monid] [--dry]
 *   --dry      writes picks to rec-images-dry/ instead of the bucket and the recs table
 *   --redo     looks again at recs that already have a picture or were checked recently
 *   --no-monid skips the Google listing fallback (Monid, ~$0.03 a place)
 */

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
/** A rec with no good picture is searched again after this, in case one turned up. */
const RECHECK_MS = 30 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 3;

let query = getSupabase().from("recs").select("id, key, name, category, neighborhood, metro, url, schedule, why, image_url, image_checked_at").eq("status", "approved").order("name");
if (value("metro")) query = query.eq("metro", value("metro")!);
const { data, error } = await query;
if (error) throw error;

const only = value("only")?.toLowerCase();
const recs = ((data ?? []) as (ImageRec & { key: string; image_url: string | null; image_checked_at: string | null })[])
  .filter((rec) => !only || rec.name.toLowerCase() === only)
  .filter((rec) => flag("redo") || (!rec.image_url && (!rec.image_checked_at || Date.now() - Date.parse(rec.image_checked_at) > RECHECK_MS)))
  .slice(0, Number(value("limit") ?? Infinity));

console.log(`[recimage] ${recs.length} recs to look up${flag("dry") ? " (dry run)" : ""}`);
if (flag("dry")) await mkdir("rec-images-dry", { recursive: true });

const tally = { found: 0, missed: 0, failed: 0 };
const queue = [...recs];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let rec = queue.shift(); rec; rec = queue.shift()) {
      try {
        const found = await findRecImage(rec, { monid: !flag("no-monid") });
        if (flag("dry")) {
          if (found) await writeFile(`rec-images-dry/${rec.metro}-${rec.key.replace(/ /g, "-")}.jpg`, found.jpeg);
        } else {
          await saveRecImage(rec, found);
        }
        tally[found ? "found" : "missed"] += 1;
        console.log(`[recimage] ${found ? `tier ${found.tier}` : "none  "} ${rec.name} (${rec.category})${found ? ` ← ${found.page}` : ""}`);
      } catch (err) {
        tally.failed += 1;
        console.warn(`[recimage] failed ${rec.name}: ${formatError(err)}`);
      }
    }
  }),
);
console.log(`[recimage] done: ${tally.found} found, ${tally.missed} none, ${tally.failed} failed`);
