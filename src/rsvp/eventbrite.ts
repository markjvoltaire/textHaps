import { browserbase, Stagehand, type ModelConfig } from "@browserbasehq/stagehand";
import { z } from "zod";

export type Attendee = { firstName: string; lastName: string; email: string };

export type RsvpResult = {
  status: "confirmed" | "ready" | "paid" | "unavailable" | "failed";
  /** What happened, in a line Haps can pass on. */
  detail: string;
  /** The Browserbase recording, for seeing where a run broke. */
  replayUrl: string | null;
};

const EVENT_SCHEMA = z.object({
  title: z.string(),
  when: z.string().describe("Date and time as shown on the page"),
  free: z.boolean().describe("True only if the ticket to pick costs $0 (Free, RSVP, or $0.00)"),
  available: z.boolean().describe("False if sold out, sales ended, or registration closed"),
});

const DONE_SCHEMA = z.object({
  confirmed: z.boolean().describe("True if the page says the order or registration went through"),
  message: z.string().describe("The confirmation or error text shown"),
});

// Sonnet is steadier than the gateway's cheapest pick on Eventbrite's checkout modal.
const MODEL = (process.env.STAGEHAND_MODEL ?? "anthropic/claude-sonnet-5") as ModelConfig["modelName"];
const ACT_TIMEOUT_MS = 30000;

/**
 * Free Eventbrite RSVP in a Browserbase browser. The attendee's name and email go in as Stagehand
 * variables, so the model sees %email% and never the address itself. With `submit` false it fills
 * everything and stops before the final click, so a run can be checked without registering anyone.
 */
export async function rsvpEventbrite(url: string, attendee: Attendee, submit: boolean): Promise<RsvpResult> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) throw new Error("BROWSERBASE_API_KEY missing");
  if (!/^https:\/\/(www\.)?eventbrite\.[a-z.]+\/e\//i.test(url)) {
    return { status: "failed", detail: "not an eventbrite event page", replayUrl: null };
  }

  const browser = await browserbase.launch({
    apiKey,
    region: "us-east-1",
    browserSettings: { solveCaptchas: true, recordSession: true, blockAds: true },
  });
  const replayUrl = browser.sessionId ? `https://www.browserbase.com/sessions/${browser.sessionId}` : null;
  const model: ModelConfig = { modelName: MODEL, apiKey: process.env.ANTHROPIC_API_KEY };
  const stagehand = await Stagehand.create({ browser, model });
  // Each step logs what it did; a required one that didn't happen stops the run, so "ready" means the form is really filled.
  const act = async (instruction: string, required = true) => {
    const { data } = await stagehand.act(instruction, {
      timeout: ACT_TIMEOUT_MS,
      variables: { firstName: attendee.firstName, lastName: attendee.lastName, email: attendee.email },
    });
    console.log(`[rsvp] ${data.success ? "ok" : "no"} · ${instruction} → ${data.actionDescription || data.message}`);
    if (required && !data.success) throw new Error(`step didn't work: ${instruction} (${data.message})`);
  };

  try {
    const [page] = await browser.context.pages();
    if (!page) throw new Error("browserbase opened no page");
    await page.goto(url);

    const { data: event } = await stagehand.extract("The event and its cheapest ticket", EVENT_SCHEMA);
    if (!event.available) return { status: "unavailable", detail: `${event.title} isn't taking rsvps`, replayUrl };
    // Paid tickets need the user's card and a separate yes, which version one doesn't do.
    if (!event.free) return { status: "paid", detail: `${event.title} costs money, so i won't buy it`, replayUrl };

    await act("Click the button that starts registration: Reserve a spot, Register, RSVP, or Get tickets");
    // The checkout opens as a modal with a quantity picker, then the contact form.
    await act("If there is a ticket quantity picker, set the free ticket to 1, then click Register, Checkout, or Continue", false);
    await act("Type %firstName% into the first name field");
    await act("Type %lastName% into the last name field");
    await act("Type %email% into the email field");
    // Eventbrite often asks for the email twice.
    await act("If there is a confirm email field, type %email% into it", false);

    if (!submit) {
      return { status: "ready", detail: `filled the rsvp for ${event.title} (${event.when}), stopped before registering`, replayUrl };
    }
    await act("Click the final button that completes the order: Register, Place order, or Complete registration");
    const { data: done } = await stagehand.extract("Whether the registration went through", DONE_SCHEMA);
    return done.confirmed
      ? { status: "confirmed", detail: `you're on the list for ${event.title} (${event.when})`, replayUrl }
      : { status: "failed", detail: done.message || "the order didn't go through", replayUrl };
  } catch (err) {
    return { status: "failed", detail: err instanceof Error ? err.message : String(err), replayUrl };
  } finally {
    await stagehand.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
