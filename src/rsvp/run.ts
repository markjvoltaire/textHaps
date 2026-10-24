import "dotenv/config";
import { rsvpEventbrite } from "./eventbrite.ts";

/**
 * Dev tool: RSVP to a free Eventbrite event in a Browserbase browser.
 * Fills the form and stops before registering unless --submit is passed.
 * Usage: npm run rsvp -- <eventbrite url> --first Mark --last V --email you@example.com [--submit]
 */

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const url = args.find((arg) => arg.startsWith("http"));
const [firstName, lastName, email] = [flag("first"), flag("last"), flag("email")];
const submit = args.includes("--submit");

if (!url || !firstName || !lastName || !email) {
  console.error("usage: npm run rsvp -- <eventbrite url> --first <name> --last <name> --email <email> [--submit]");
  process.exit(1);
}
const missing = ["BROWSERBASE_API_KEY", "ANTHROPIC_API_KEY"].filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`[rsvp] missing ${missing.join(", ")} in .env`);
  process.exit(1);
}

const started = Date.now();
const result = await rsvpEventbrite(url, { firstName, lastName, email }, submit);
console.log(`[rsvp] ${result.status}: ${result.detail}`);
if (result.replayUrl) console.log(`[rsvp] replay: ${result.replayUrl}`);
console.log(`[rsvp] ${submit ? "submitted" : "dry run"} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(result.status === "failed" ? 1 : 0);
