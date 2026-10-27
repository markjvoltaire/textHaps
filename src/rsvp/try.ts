import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { RSVP_SKIP, type RsvpReason, type RsvpRow, type RsvpStatus } from "../db/rsvps.ts";
import type { Profile, SaveRow } from "../db/types.ts";
import { flushTracing, startTracing } from "../observability.ts";
import { runRsvp, type RsvpStore } from "./run.ts";

/**
 * Dev tool: run one RSVP against a real event page without the chat or the rsvps table. Texts print
 * here, and answers to what it asks (a login code, a phone) are typed here.
 *
 *   npm run rsvp -- <event url> "<full name>" <email> [phone] [title]
 */
const [url, fullName, email, phone, title] = process.argv.slice(2);
if (!url || !fullName || !email) {
  console.error('usage: npm run rsvp -- <event url> "<full name>" <email> [phone] [title]');
  process.exit(1);
}
if (!process.env.BROWSERBASE_API_KEY) {
  console.error("BROWSERBASE_API_KEY isn't set in .env");
  process.exit(1);
}

startTracing();
const now = new Date().toISOString();
const profile = { id: "dry-run", platform: "terminal", platform_user_id: phone ?? "dry-run", full_name: fullName, email } as Profile;
const save = { id: "dry-run", profile_id: "dry-run", url, title: title ?? null } as SaveRow;
const rsvp: RsvpRow = {
  id: "dry-run",
  profile_id: "dry-run",
  save_id: "dry-run",
  url,
  platform: "terminal",
  space_id: "dry-run",
  status: "running",
  reason: null,
  asking: null,
  answer: null,
  heartbeat_at: now,
  created_at: now,
  finished_at: null,
};

const terminal = createInterface({ input: process.stdin, output: process.stdout });
let state: { status: RsvpStatus; reason: RsvpReason | null; answer: string | null } = { status: "running", reason: null, answer: null };
const store: RsvpStore = {
  heartbeat: async () => {},
  setStatus: async (_id, status, reason = null) => {
    if (["done", "needs_user", "failed"].includes(state.status)) return false;
    state = { ...state, status, reason };
    console.log(`[status] ${status}${reason ? ` (${reason})` : ""}`);
    return true;
  },
  // Asked them something: read the answer from the terminal the way the chat would take it. "skip" skips.
  askFor: async (_id, asking) => {
    state = { ...state, status: "needs_input", answer: null };
    void terminal.question(`${asking}> `).then((answer) => {
      state.answer = answer.trim().toLowerCase() === "skip" ? RSVP_SKIP : answer.trim();
    });
  },
  takeAnswer: async () => {
    const { answer } = state;
    if (answer) state = { ...state, answer: null, status: "running" };
    return answer;
  },
};

const outcome = await runRsvp({ rsvp, profile, save }, { notify: async (text) => console.log(`\n[text]\n${text}\n`), store });
console.log(`[done] ${outcome}`);
terminal.close();
await flushTracing();
