import "dotenv/config";
import { getSupabase } from "../db/client.ts";
import { embedDocument } from "../search/embed.ts";
import { formatError } from "../utils/text.ts";
import { exchangeText } from "./recall.ts";

/**
 * Embeds every exchange that hasn't been yet (old turns, and any the worker missed), for long
 * memory. Run it here, not on the worker: the model needs ~400 MB.
 * Usage: npm run embed-turns -- [--redo]
 */

const redo = process.argv.includes("--redo");
const PAGE = 500;
const supabase = getSupabase();

type Turn = { id: string; profile_id: string; role: string; content: string; created_at: string; embedded_at: string | null };
const turns: Turn[] = [];
for (let from = 0; ; from += PAGE) {
  const { data, error } = await supabase
    .from("chat_turns")
    .select("id, profile_id, role, content, created_at, embedded_at")
    .order("profile_id")
    .order("created_at")
    .range(from, from + PAGE - 1);
  if (error) throw error;
  turns.push(...((data ?? []) as Turn[]));
  if (!data || data.length < PAGE) break;
}

let embedded = 0;
let skipped = 0;
let failed = 0;
for (const [i, turn] of turns.entries()) {
  if (turn.role !== "user" || (turn.embedded_at && !redo)) continue;
  // The reply is the next Haps turn in the same thread.
  const next = turns[i + 1];
  const reply = next && next.profile_id === turn.profile_id && next.role === "assistant" ? next.content : "";
  const text = exchangeText(turn.content, reply);
  try {
    const embedding = text ? await embedDocument(text) : null;
    const { error } = await supabase
      .from("chat_turns")
      .update({ embedding: embedding ? JSON.stringify(embedding) : null, embedded_at: new Date().toISOString() })
      .eq("id", turn.id);
    if (error) throw error;
    if (embedding) embedded += 1;
    else skipped += 1;
  } catch (err) {
    failed += 1;
    console.warn(`[embed-turns] failed ${turn.id}: ${formatError(err)}`);
  }
}
console.log(`[embed-turns] ${embedded} embedded, ${skipped} too short, ${failed} failed`);
