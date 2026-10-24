import "dotenv/config";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { handleMessage } from "./handlers/message.ts";
import { startTracing } from "./observability.ts";
import { formatError } from "./utils/text.ts";

const PROVIDER = (process.env.SPECTRUM_PROVIDER ?? "imessage").toLowerCase();

for (const key of [
  "ANTHROPIC_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PROJECT_ID",
  "PROJECT_SECRET",
]) {
  const skipPhoton = PROVIDER === "terminal" && (key === "PROJECT_ID" || key === "PROJECT_SECRET");
  if (!process.env[key] && !skipPhoton) {
    throw new Error(`Missing ${key} in .env`);
  }
}

startTracing();

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [PROVIDER === "terminal" ? terminal.config() : imessage.config()],
});

console.log(`Agent online. provider=${PROVIDER}`);

// One queue per sender: their messages stay in order, but a slow reply never blocks anyone else.
const queues = new Map<string, Promise<void>>();

for await (const [space, message] of app.messages) {
  const key = message.sender?.id ?? space.id;
  // "Read" goes out the moment the message lands, not after the database claim or an earlier
  // reply still in this sender's queue. Both workers may mark it during a deploy; that's harmless.
  if (message.direction !== "outbound" && message.content.type !== "read") {
    void message.read().catch((err: unknown) => console.warn(`[read] failed space=${space.id}:`, formatError(err)));
  }
  const next = (queues.get(key) ?? Promise.resolve())
    .then(() => space.responding(() => handleMessage(space, message)))
    .catch((err: unknown) => {
      console.error(`[loop] error in space ${space.id}:`, formatError(err));
    });
  queues.set(key, next);
  void next.then(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
}
