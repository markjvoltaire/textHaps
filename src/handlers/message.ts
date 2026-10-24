import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { attachment, contact, group, richlink, type Message, type Space } from "spectrum-ts";
import { background, nativeContactCard } from "spectrum-ts/providers/imessage";
import { generateReply, LINKS_NOTE } from "../agent/claude.ts";
import { formatCatalogOverview } from "../db/events.ts";
import { listSaves, saveEvent } from "../db/saves.ts";
import { claimMessage } from "../db/handled.ts";
import { markBackgroundCleared, markContactCardSent, upsertProfile } from "../db/profiles.ts";
import type { Profile } from "../db/types.ts";
import { flushTracing } from "../observability.ts";
import { listTaste } from "../db/taste.ts";
import { appendExchange, getHistory } from "../memory/history.ts";
import { checkRateLimit, noteVoiceFailure, shouldWarn, voiceAllowed } from "./rateLimit.ts";
import { extractText, formatError, sanitizeOutgoingText } from "../utils/text.ts";
import { transcribe } from "../voice/deepgram.ts";
import { rsvpEventbrite } from "../rsvp/eventbrite.ts";

const FALLBACK_REPLY = "ugh my bad, something glitched\ntry me again?";
const RATE_LIMIT_REPLY = "ok i need a breather, hit me back in a bit";
const VOICE_FALLBACK_REPLY = "couldn't catch that voice note\ntext it to me instead?";
// A few minutes of voice note is well under this.
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const AUDIO_READ_TIMEOUT_MS = 10_000;
// A reply line that is nothing but a link, sent as a rich link card.
const BARE_URL = /^https?:\/\/\S+$/i;
const RICHLINK_TIMEOUT_MS = 6_000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** One Langfuse span per Photon send, so a trace shows which send was slow. */
function traced<T>(what: string, send: () => Promise<T>): Promise<T> {
  return startActiveObservation(`send ${what}`, () => send());
}

type Audio = { mimeType: string; read: () => Promise<Buffer> };

/** A voice note, or an audio file sent as an attachment. */
function audioOf(content: Message["content"]): Audio | undefined {
  if (content.type === "voice") return content;
  if (content.type === "attachment" && content.mimeType.startsWith("audio/")) return content;
  return undefined;
}
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const ICON_PATH = join(ASSETS_DIR, "haps-icon.jpg");

/** Clears the Haps chat background from threads that got one earlier. A failure never blocks the reply. */
async function clearBackground(space: Space, profile: Profile): Promise<void> {
  if (profile.platform !== "imessage" || !profile.background_set_at) return;
  try {
    await traced("clear background", () => space.send(background("clear")));
    await markBackgroundCleared(profile.id);
    console.log(`[background] cleared for sender=${profile.platform_user_id}`);
  } catch (err) {
    console.warn(`[background] clear failed for sender=${profile.platform_user_id}:`, formatError(err));
  }
}

/**
 * Once per person: shares Haps's iMessage name and photo (set on the Photon project
 * profile), which shows "Maybe: Haps" and an Add banner, then sends a Haps contact
 * card with the icon when HAPS_PHONE_NUMBER is set. A failure never blocks the reply.
 */
async function ensureContactCard(space: Space, profile: Profile): Promise<void> {
  if (profile.platform !== "imessage" || profile.contact_card_sent_at) return;
  try {
    await traced("native contact card", () => space.send(nativeContactCard()));
    // Marked now so a failing card send below can't re-send the native card on every reply.
    await markContactCardSent(profile.id);
    const phone = process.env.HAPS_PHONE_NUMBER;
    if (phone) {
      await traced("contact card", () =>
        space.send(
          contact({
            name: { first: "Haps" },
            phones: [{ value: phone, type: "mobile" }],
            photo: { mimeType: "image/jpeg", read: () => readFile(ICON_PATH) },
          }),
        ),
      );
    }
    console.log(`[contact] shared with sender=${profile.platform_user_id} card=${Boolean(phone)}`);
  } catch (err) {
    console.warn(`[contact] failed for sender=${profile.platform_user_id}:`, formatError(err));
  }
}

export async function handleMessage(space: Space, message: Message): Promise<void> {
  const receivedAt = Date.now();
  if (message.direction === "outbound") return;
  if (message.content.type === "read") return;
  const audio = audioOf(message.content);
  if (message.content.type !== "text" && !audio) {
    console.log(`[skip] space=${space.id} unsupported content type=${message.content.type}`);
    return;
  }

  // Old and new workers overlap during a deploy and both get every message. Answer it once.
  // Terminal mode has a single process and no Photon message ids worth tracking.
  if (message.platform !== "terminal") {
    const claimed = await claimMessage(message.id).catch((err: unknown) => {
      console.warn(`[claim] failed id=${message.id}, answering anyway:`, formatError(err));
      return true;
    });
    if (!claimed) {
      console.log(`[claim] skip id=${message.id}, another worker has it`);
      return;
    }
  }

  const senderId = message.sender?.id ?? space.id;
  const platform = message.platform || "imessage";
  let text = extractText(message.content).trim();
  if (!text && !audio) return;

  // Before any voice work, so an over-limit sender can't run up the Deepgram bill.
  let profile: Profile;
  try {
    profile = await upsertProfile(platform, senderId);
    const limit = await checkRateLimit(profile.id);
    if (!limit.ok) {
      console.warn(`[limit] sender=${senderId} over ${limit.window} limit`);
      if (shouldWarn(profile.id, limit.window)) await space.send(RATE_LIMIT_REPLY);
      return;
    }
  } catch (err) {
    console.error(`[handler] profile or limit check failed for sender=${senderId}:`, formatError(err));
    await space.send(FALLBACK_REPLY);
    return;
  }

  // Voice notes become text first, then go through the same flow as a typed message.
  if (audio) {
    if (!voiceAllowed(profile.id)) {
      console.warn(`[voice] sender=${senderId} too many failed voice notes, skipping`);
      return;
    }
    try {
      // Spectrum doesn't give the size up front, so a stalled download is cut off instead.
      const buf = await withTimeout(audio.read(), AUDIO_READ_TIMEOUT_MS, "audio download");
      if (buf.length > MAX_AUDIO_BYTES) throw new Error(`audio too large: ${buf.length} bytes`);
      text = await transcribe(buf, audio.mimeType);
      console.log(`[voice] sender=${senderId} mime=${audio.mimeType} transcript=${JSON.stringify(text)}`);
    } catch (err) {
      console.warn(`[voice] transcription failed for sender=${senderId}:`, formatError(err));
    }
    if (!text) {
      noteVoiceFailure(profile.id);
      await space.send(VOICE_FALLBACK_REPLY);
      return;
    }
  }

  console.log(`[in] space=${space.id} sender=${senderId} text=${JSON.stringify(text)}`);

  // One Langfuse trace per reply: the text in, what was actually sent out, and the
  // Claude calls and tools in between (no-op when Langfuse keys aren't set).
  await startActiveObservation("imessage-reply", async (span) => {
    span.update({ input: text, metadata: { voice: Boolean(audio) } });
    let reply: string;
    let imagePaths: string[] = [];
    let placeLink: string | null = null;
    let eventLinks: { title: string; url: string }[] = [];
    // Web searches take a few seconds, so keep the typing dots going instead of texting a heads-up.
    let searchingNotice: Promise<void> | undefined;
    const onWebSearch = () => {
      if (searchingNotice) return;
      searchingNotice = space
        .startTyping()
        .catch((err: unknown) => console.warn(`[searching] typing failed for sender=${senderId}:`, formatError(err)));
    };
    // Runs while Claude works, so it doesn't hold up the reply.
    const backgroundCleared = clearBackground(space, profile);
    // An RSVP takes about a minute in a cloud browser, so it runs after the reply and texts its own result.
    let rsvp: { url: string; title: string | undefined } | undefined;
    const startRsvp = (url: string, title: string | undefined) => {
      rsvp ??= { url, title };
    };
    try {
      const [taste, saves, history] = await Promise.all([
        listTaste(profile.id),
        listSaves(profile.id),
        getHistory(profile.id),
      ]);
      const generated = await propagateAttributes({ userId: profile.id, sessionId: profile.id }, () =>
        generateReply({ profile, taste, saves, history, userMessage: text, onWebSearch, startRsvp }),
      );
      // Typing must start before the answer lands, or the dots can linger after it.
      await searchingNotice;
      imagePaths = generated.imagePaths;
      placeLink = generated.placeLink;
      eventLinks = generated.eventLinks;
      reply = sanitizeOutgoingText(generated.text);
      if (!reply && imagePaths.length > 0) {
        reply = sanitizeOutgoingText(formatCatalogOverview(generated.events));
      }
    } catch (err) {
      console.error(`[handler] failed for sender=${senderId}:`, formatError(err));
      span.update({ level: "ERROR", statusMessage: formatError(err) });
      // Let typing start first so the dots don't linger after the glitch message.
      await Promise.all([backgroundCleared, searchingNotice]);
      await space.send(FALLBACK_REPLY);
      return;
    }

    await backgroundCleared;
    if (!reply) {
      console.warn(`[claude] empty reply for sender=${senderId}`);
      // They watched the typing dots through a search, so don't leave them hanging.
      if (searchingNotice) await space.send(FALLBACK_REPLY);
      return;
    }

    // Only commit the exchange once the model actually produced something.
    // Keep only what the user actually sees: the lead plus up to 2 more bubbles. A line that is
    // only a link goes out as one rich link card after them, so it doesn't take a text slot.
    // The links note is only for history; if Claude copies one into a reply, it never goes out.
    const lines = reply
      .split(/\n+/)
      .map((part) => part.trim())
      .filter((part) => part && !part.toLowerCase().startsWith(LINKS_NOTE));
    // Haps's own link line wins; otherwise the one place's site picked from the search results.
    const link = lines.find((line) => BARE_URL.test(line)) ?? placeLink ?? undefined;
    const bubbles = lines.filter((line) => !BARE_URL.test(line)).slice(0, 3);
    const sent = [...bubbles, ...(link ? [link] : [])].join("\n");
    span.update({ output: sent, metadata: { platform, flyers: imagePaths.length, richlink: Boolean(link) } });
    // Event pages the reply named but didn't send, so a follow-up ("can you rsvp") can still send the link.
    const unsent = eventLinks.filter((item) => item.url !== link);
    const remembered = unsent.length
      ? `${sent}\n${LINKS_NOTE} ${unsent.map((item) => `${item.title} ${item.url}`).join(" · ")})`
      : sent;
    await appendExchange(profile.id, senderId, text, remembered).catch((err: unknown) => {
      console.error(`[history] save failed for sender=${senderId}:`, formatError(err));
    });

    console.log(`[out] space=${space.id} sender=${senderId} reply=${JSON.stringify(reply)} images=${imagePaths.length}`);
    // Short texts, not one block: each line goes out as its own bubble.
    const [lead, ...rest] = bubbles;
    const flyers = imagePaths.map(flyerAttachment);
    const first = flyers[0];
    const second = flyers[1];
    const photos = first && second ? group(first, second, ...flyers.slice(2)) : first;
    // No pauses between bubbles: each send already takes a couple of seconds to confirm.
    if (photos && lead) {
      await traced("lead with flyers", () => space.send(photos, lead));
    } else if (photos) {
      await traced("flyers", () => space.send(photos));
    } else if (lead) {
      await traced("lead", () => space.send(lead));
    }
    // What the user actually waited for, from the message arriving to the first thing they see.
    span.update({ metadata: { firstBubbleMs: Date.now() - receivedAt } });
    for (const bubble of rest.slice(0, 2)) {
      await traced("bubble", () => space.send(bubble));
    }
    // The place's card goes last so it never holds up the answer. Photon builds the preview
    // before confirming, which once took 30s and then failed, so it's capped; it's not retried,
    // since it may still land.
    if (link) {
      await withTimeout(traced("rich link", () => space.send(richlink(link))), RICHLINK_TIMEOUT_MS, "rich link").catch(
        (err: unknown) => console.warn(`[richlink] send failed for sender=${senderId}:`, formatError(err)),
      );
    }
    // After the first reply, not before it, so the chat opens with Haps talking.
    await ensureContactCard(space, profile);
    if (rsvp) void runRsvp(space, profile, rsvp.url, rsvp.title);
  });
  await flushTracing();
}

// One RSVP per person at a time, so a double "yes" can't register them twice.
const rsvping = new Set<string>();

/** Runs the RSVP and texts how it went. A confirmed one is saved, so Haps knows they're going. */
async function runRsvp(space: Space, profile: Profile, url: string, title: string | undefined): Promise<void> {
  if (rsvping.has(profile.id) || !profile.email || !profile.full_name) return;
  rsvping.add(profile.id);
  const [firstName, ...rest] = profile.full_name.trim().split(/\s+/);
  try {
    // RSVP_DRY_RUN=1 fills the form without registering, for testing on a real event.
    const submit = process.env.RSVP_DRY_RUN !== "1";
    const result = await rsvpEventbrite(url, { firstName: firstName!, lastName: rest.join(" "), email: profile.email }, submit);
    console.log(`[rsvp] sender=${profile.platform_user_id} ${result.status}: ${result.detail} replay=${result.replayUrl}`);
    const reply =
      result.status === "confirmed"
        ? `you're on the list for ${title ?? "it"}, confirmation's in your email`
        : result.status === "ready"
          ? `test run: filled the rsvp for ${title ?? "it"} but didn't submit`
          : result.status === "paid"
            ? `that one costs money so i didn't buy it, here's the page`
            : `couldn't rsvp you for ${title ?? "that"}, here's the page so you can do it`;
    await space.send(reply);
    if (result.status === "paid" || result.status === "failed" || result.status === "unavailable") {
      await space.send(richlink(url)).catch(() => space.send(url));
    }
    if (result.status === "confirmed") {
      await saveEvent({ profileId: profile.id, url, title, note: "rsvp confirmed" }).catch((err: unknown) =>
        console.error(`[rsvp] save failed for sender=${profile.platform_user_id}:`, formatError(err)),
      );
    }
  } catch (err) {
    console.error(`[rsvp] failed for sender=${profile.platform_user_id}:`, formatError(err));
    await space.send("couldn't rsvp you for that one, here's the page").catch(() => {});
    await space.send(url).catch(() => {});
  } finally {
    rsvping.delete(profile.id);
  }
}

function flyerAttachment(ref: string) {
  if (/^https?:\/\//i.test(ref)) {
    return attachment(new URL(ref), { mimeType: "image/jpeg", name: "flyer.jpg" });
  }
  return attachment(ref);
}
