import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { getSupabase } from "../db/client.ts";
import { listAllRecs, matchRecs, recText, setRecEmbedding } from "../db/recs.ts";
import { embedDocument, embedQuery } from "./embed.ts";

/**
 * Dev tool: searches the recs by meaning.
 * Usage: npm run vectors -- "chill rooftop with live music" ["another search" ...]
 *        npm run vectors -- --export   (writes vectors.tsv and metadata.tsv for projector.tensorflow.org)
 *        npm run vectors -- --reembed  (re-embeds every rec, after changing the model)
 */

const args = process.argv.slice(2);

// After a model change every old vector is in the wrong space, so all of them are redone.
if (args.includes("--reembed")) {
  const recs = await listAllRecs();
  console.log(`[vectors] re-embedding ${recs.length} recs…`);
  for (const rec of recs) await setRecEmbedding(rec.id, await embedDocument(recText(rec), rec.name));
  console.log("[vectors] done");
}

for (const search of args.filter((arg) => !arg.startsWith("--"))) {
  const matches = await matchRecs(await embedQuery(search), { limit: 5 });
  console.log(`\n"${search}"`);
  for (const match of matches) {
    console.log(`  ${match.distance.toFixed(3)}  ${match.name}  (${match.category}${match.neighborhood ? `, ${match.neighborhood}` : ""})`);
  }
}

if (args.includes("--export")) {
  const { data, error } = await getSupabase().from("recs").select("name, metro, category, embedding").not("embedding", "is", null);
  if (error) throw error;
  const rows = data as { name: string; metro: string; category: string; embedding: string }[];
  const clean = (value: string | null) => (value ?? "").replace(/\s+/g, " ").trim();
  await mkdir("vectors", { recursive: true });
  await writeFile("vectors/vectors.tsv", rows.map((row) => (JSON.parse(row.embedding) as number[]).join("\t")).join("\n") + "\n");
  await writeFile(
    "vectors/metadata.tsv",
    ["name\tmetro\tcategory", ...rows.map((row) => [clean(row.name), clean(row.metro), clean(row.category)].join("\t"))].join("\n") + "\n",
  );
  console.log(`\n[vectors] wrote vectors/vectors.tsv and vectors/metadata.tsv (${rows.length} recs)`);
}
