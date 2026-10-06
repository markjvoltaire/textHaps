import "dotenv/config";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { handleMessage } from "./handlers/message.ts";
import { startIngestLoop } from "./ingest/schedule.ts";
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

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [PROVIDER === "terminal" ? terminal.config() : imessage.config()],
});

console.log(`Agent online. provider=${PROVIDER}`);
startIngestLoop();

for await (const [space, message] of app.messages) {
  try {
    await space.responding(async () => {
      await handleMessage(space, message);
    });
  } catch (err) {
    console.error(`[loop] error in space ${space.id}:`, formatError(err));
  }
}
