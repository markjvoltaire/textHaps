import "dotenv/config";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { handleMessage } from "./handlers/message.ts";

const PROVIDER = (process.env.SPECTRUM_PROVIDER ?? "imessage").toLowerCase();

for (const key of ["ANTHROPIC_API_KEY", "PROJECT_ID", "PROJECT_SECRET"]) {
  if (!process.env[key] && !(PROVIDER === "terminal" && key !== "ANTHROPIC_API_KEY")) {
    throw new Error(`Missing ${key} in .env`);
  }
}

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [PROVIDER === "terminal" ? terminal.config() : imessage.config()],
});

console.log(`Agent online. provider=${PROVIDER}`);

for await (const [space, message] of app.messages) {
  try {
    await space.responding(async () => {
      await handleMessage(space, message);
    });
  } catch (err) {
    console.error(
      `[loop] error in space ${space.id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
