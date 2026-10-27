import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { attachment, richlink, type Message, type Space } from "spectrum-ts";
import { background } from "spectrum-ts/providers/imessage";
import { generateReply, LINKS_NOTE } from "../agent/claude.ts";
import { recordShown, recsNamedIn, type ShownRec } from "../db/picks.ts";
import { listSaves } from "../db/saves.ts";
import { claimMessage } from "../db/handled.ts";
import { markBackgroundCleared, upsertProfile } from "../db/profiles.ts";
import type { Profile } from "../db/types.ts";
import { flushTracing } from "../observability.ts";
import { listTaste } from "../db/taste.ts";
import { appendExchange, getHistory } from "../memory/history.ts";
import { checkRateLimit, noteVoiceFailure, shouldWarn, voiceAllowed } from "./rateLimit.ts";
import { prepareImage, type ImageInput } from "../utils/image.ts";
import { extractText, formatError, sanitizeOutgoingText } from "../utils/text.ts";
import { transcribe } from "../voice/deepgram.ts";

const FALLBACK_REPLY = "ugh my bad, something glitched\ntry me again?";
const RATE_LIMIT_REPLY = "ok i need a breather, hit me back in a bit";
const VOICE_FALLBACK_REPLY = "couldn't catch that voice note\ntext it to me instead?";
const PHOTO_FALLBACK_REPLY = "couldn't open that pic\ncan you screenshot it and send that?";
/** What a photo is in the chat history. Claude sees the image itself only on the turn it arrives. */
const PHOTO_TURN = "(sent a photo)";
// Phone photos run 2-6 MB; anything far past that isn't a flyer.
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
// A few minutes of voice note is well under this.
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const AUDIO_READ_TIMEOUT_MS = 10_000;
// A reply line that is nothing but a link, sent as a rich link card.
const BARE_URL = /^https?:\/\/\S+$/i;
const RICHLINK_TIMEOUT_MS = 6_000;
/** How long the texts wait on a rec's site lookup (Exa + Jev, ~1s, usually started during the reply). A late one just goes out without a card. */
const REC_SITE_WAIT_MS = 2_500;

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

/** A photo or screenshot, like an event flyer. */
function photoOf(content: Message["content"]): Audio | undefined {
  if (content.type === "attachment" && content.mimeType.startsWith("image/")) return content;
  return undefined;
}

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

export async function handleMessage(space: Space, message: Message): Promise<void> {
  const receivedAt = Date.now();
  if (message.direction === "outbound") return;
  if (message.content.type === "read") return;
  const audio = audioOf(message.content);
  const photo = photoOf(message.content);
  if (message.content.type !== "text" && !audio && !photo) {
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
  if (!text && !audio && !photo) return;

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

  let image: ImageInput | undefined;
  if (photo) {
    try {
      const buf = await withTimeout(photo.read(), AUDIO_READ_TIMEOUT_MS, "photo download");
      if (buf.length > MAX_PHOTO_BYTES) throw new Error(`photo too large: ${buf.length} bytes`);
      image = (await prepareImage(buf, photo.mimeType)) ?? undefined;
      if (!image) throw new Error(`can't open ${photo.mimeType}`);
    } catch (err) {
      console.warn(`[photo] failed for sender=${senderId}:`, formatError(err));
      await space.send(PHOTO_FALLBACK_REPLY);
      return;
    }
    text = text || PHOTO_TURN;
  }

  console.log(`[in] space=${space.id} sender=${senderId} text=${JSON.stringify(text)}${image ? ` photo=${photo!.mimeType}` : ""}`);

  // One Langfuse trace per reply: the text in, what was actually sent out, and the
  // Claude calls and tools in between (no-op when Langfuse keys aren't set).
  await startActiveObservation("imessage-reply", async (span) => {
    span.update({ input: text, metadata: { voice: Boolean(audio) } });
    let reply: string;
    let placeLink: string | null = null;
    let eventLinks: { title: string; url: string }[] = [];
    let recsOffered: ShownRec[] = [];
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
    try {
      const [taste, saves, history] = await Promise.all([
        listTaste(profile.id),
        listSaves(profile.id),
        getHistory(profile.id),
      ]);
      const generated = await propagateAttributes({ userId: profile.id, sessionId: profile.id }, () =>
        generateReply({ profile, taste, saves, history, userMessage: text, images: image ? [image] : undefined, spaceId: space.id, onWebSearch }),
      );
      // Typing must start before the answer lands, or the dots can linger after it.
      await searchingNotice;
      placeLink = generated.placeLink;
      eventLinks = generated.eventLinks;
      recsOffered = generated.recsOffered;
      reply = sanitizeOutgoingText(generated.text);
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
    // Keep only what the user actually sees: the lead plus up to 2 more bubbles, and a closing
    // question (which rec they're going with) after them. A line that is
    // only a link goes out as a rich link card instead, so it doesn't take a text slot.
    // The links note is only for history; if Claude copies one into a reply, it never goes out.
    const lines = reply
      .split(/\n+/)
      .map((part) => part.trim())
      .filter((part) => part && !part.toLowerCase().startsWith(LINKS_NOTE));
    // Haps's own link line wins; otherwise the one place's site picked from the search results.
    const link = lines.find((line) => BARE_URL.test(line)) ?? placeLink ?? undefined;
    const texts = lines.filter((line) => !BARE_URL.test(line));
    const closing = texts.length > 3 && texts.at(-1)!.endsWith("?") ? [texts.at(-1)!] : [];
    const bubbles = [...texts.slice(0, 3), ...closing];
    // Recs the reply names that have no site saved: finish looking them up (Exa, checked by Jev),
    // so they get a card too. Found sites are saved to the recs table for next time.
    const missingSites = recsNamedIn(bubbles.join("\n"), recsOffered).filter((rec) => !rec.url && rec.site);
    if (missingSites.length) {
      await withTimeout(
        Promise.all(missingSites.map(async (rec) => void (rec.url = await rec.site!()))),
        REC_SITE_WAIT_MS,
        "rec sites",
      ).catch((err: unknown) => console.warn(`[reclink] gave up waiting for sender=${senderId}:`, formatError(err)));
    }
    // What goes out, in order. One place: its card first. Several recs: each rec's card right
    // before the text about it, so every pick that has a page gets one.
    const plan: { card?: string; text?: string }[] = [];
    if (link) plan.push({ card: link });
    const carded = new Set(link ? [link] : []);
    for (const bubble of bubbles) {
      for (const rec of recsNamedIn(bubble, recsOffered)) {
        if (rec.url && !carded.has(rec.url)) {
          carded.add(rec.url);
          plan.push({ card: rec.url });
        }
      }
      plan.push({ text: bubble });
    }
    const sent = plan.map((item) => item.card ?? item.text).join("\n");
    span.update({ output: sent, metadata: { platform, richlinks: carded.size } });
    // Event pages the reply named but didn't send, so a follow-up ("can you rsvp") can still send the link.
    const unsent = eventLinks.filter((item) => !carded.has(item.url));
    const remembered = unsent.length
      ? `${sent}\n${LINKS_NOTE} ${unsent.map((item) => `${item.title} ${item.url}`).join(" · ")})`
      : sent;
    // Only what went out counts as shown, so a rec cut by the bubble limit isn't logged.
    recordShown(profile.id, recsNamedIn(sent, recsOffered)).catch((err: unknown) =>
      console.error(`[picks] logging shown recs failed for sender=${senderId}:`, formatError(err)),
    );
    await appendExchange(profile.id, senderId, text, remembered).catch((err: unknown) => {
      console.error(`[history] save failed for sender=${senderId}:`, formatError(err));
    });

    console.log(`[out] space=${space.id} sender=${senderId} reply=${JSON.stringify(reply)}`);
    // No pauses between sends: each already takes a couple of seconds to confirm. Photon builds a
    // card's preview before confirming, which once took 30s and then failed, so each card is
    // capped to keep it from holding up the texts; it's not retried, since it may still land.
    let firstText = true;
    for (const item of plan) {
      if (item.card) {
        const card = item.card;
        await withTimeout(traced("rich link", () => space.send(richlink(card))), RICHLINK_TIMEOUT_MS, "rich link").catch(
          (err: unknown) => console.warn(`[richlink] send failed for sender=${senderId}:`, formatError(err)),
        );
      } else if (item.text) {
        const text = item.text;
        await traced(firstText ? "lead" : "bubble", () => space.send(text));
        // What the user actually waited for, from the message arriving to the first text they see.
        if (firstText) span.update({ metadata: { firstBubbleMs: Date.now() - receivedAt } });
        firstText = false;
      }
    }
  });
  await flushTracing();
}
