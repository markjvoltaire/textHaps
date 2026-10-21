import "dotenv/config";
import { getSupabase } from "./db/client.ts";

/** Tails chat_turns in the terminal: prints each new message as it lands. */
const POLL_MS = 2000;

type Row = { handle: string | null; role: string; content: string; created_at: string };

let since = new Date().toISOString();
console.log("[watch] waiting for new messages… (ctrl+c to stop)");

async function poll(): Promise<void> {
  const { data, error } = await getSupabase()
    .from("chat_turns")
    .select("handle, role, content, created_at")
    .gt("created_at", since)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[watch] query failed:", error.message);
    return;
  }

  for (const row of (data ?? []) as Row[]) {
    const time = new Date(row.created_at).toLocaleTimeString();
    const who = row.role === "user" ? row.handle ?? "unknown" : "bot";
    console.log(`${time}  ${who.padEnd(16)}  ${row.content}`);
    since = row.created_at;
  }
}

setInterval(() => void poll(), POLL_MS);
