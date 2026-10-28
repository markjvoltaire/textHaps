import type Anthropic from "@anthropic-ai/sdk";
import { applyProfileUpdate, PROFILE_FIELDS, updateProfile, type ProfilePatch } from "../db/profiles.ts";
import { recordPick, type ShownRec } from "../db/picks.ts";
import { listSaves, removeSave, saveEvent } from "../db/saves.ts";
import { scheduleReminders, zoneFor } from "../reminders/schedule.ts";
import { saveSharedRec } from "../recs/shared.ts";
import { findFlyerPage, verifyFlyerEvent } from "../recs/verify.ts";
import { RSVP_ON } from "../rsvp/run.ts";
import { beginRsvp } from "../rsvp/start.ts";
import { lovedBySimilar, recordFeedback, VERDICTS } from "../db/feedback.ts";
import { PROVIDER } from "../utils/provider.ts";
import { formatError } from "../utils/text.ts";
import { forgetTaste, listTaste, rememberTaste } from "../db/taste.ts";
import { TASTE_CATEGORIES, type Profile, type TasteCategory, type TasteKind, type TasteSource } from "../db/types.ts";
import { searchEventPages, searchWeb, type WebResult } from "../search/exa.ts";
import { ensureRecSite } from "../recs/link.ts";
import { searchTikTokVideos } from "../search/monid.ts";
import { NIGHT_CATEGORIES, RECS_METROS, searchRecs, type RecResult } from "../search/recs.ts";
import { refreshTasteEmbedding, tasteVector } from "../search/taste.ts";
import { knownMetro, metroFor } from "../utils/metro.ts";
import { cleanStart, describeWhen, eventLinksIn, readEventPage, type EventDetails } from "./eventLink.ts";
import { hasLink, isExactLink, LINK, normalizeLink } from "./links.ts";

export const HAPS_TOOLS: Anthropic.Tool[] = [
  {
    name: "web_search",
    description:
      "Search the web for places that aren't parties: wine bars, bars, restaurants, cafes, brunch, run clubs. Never use it for parties or club nights. Recommend only places the results back up, and don't make up hours or details.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, with the city and neighborhood, e.g. natural wine bar brooklyn" },
        purpose: {
          type: "string",
          enum: ["recommend", "look_up"],
          description: "recommend: finding places for them to go. look_up: facts about a place they named (hours, menu, is it open)",
        },
        spot_vibe: {
          type: "string",
          description:
            "For recommend: the kind of spot they want for this ask, from what they told you, e.g. classy sit-down, low-key, lively, date night. A vibe they gave for a night out or a different ask doesn't count",
        },
        craving: {
          type: "string",
          description: "For recommend when it's food: what they're in the mood to eat, e.g. tacos, sushi, anything good",
        },
        live: {
          type: "boolean",
          description: "Search the live web instead of Haps's recs. Only after the recs came back with nothing near them or in their budget.",
        },
      },
      required: ["query", "purpose"],
      additionalProperties: false,
    },
  },
  {
    name: "read_event_link",
    description:
      "Read an event page the user just sent (Posh, Partiful, Eventbrite, DICE, RA, Instagram, etc.) and get its title, time, and place. Only works on a link in their current message. If it comes back unreadable, ask them for the day, time, and place.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The event link, exactly as the user sent it" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "search_events",
    description:
      "Search ticketing sites (DICE, Posh, Partiful, Eventbrite, RA, Shotgun, Luma) and recent TikTok promo videos live for nights in this city. Recommend only events these pages back up, with the date the page shows. Do not invent events. Do not call until you know their city, the vibe they want, and their budget: ask first if you don't.",
    input_schema: {
      type: "object",
      required: ["vibe", "budget"],
      properties: {
        vibe: {
          type: "string",
          description:
            "How they want the night to feel, from what they told you for this ask, e.g. low-key with good music, packed and rowdy, upscale. Saved taste doesn't count, and broad likes like parties or good music aren't a vibe",
        },
        budget: {
          type: "string",
          description: "Their budget, from this ask or their saved normal night out, e.g. around $50, cheap, doesn't matter",
        },
        city: { type: "string", description: "City to search, e.g. NYC" },
        query: { type: "string", description: "Free-text match on title, description, or vibe" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Music or crowd tags such as house, techno, afro, hip-hop, latin, live, bottle service",
        },
        from: { type: "string", description: "ISO start of the window. Defaults to now. Set it when they ask about a specific day or weekend." },
        to: { type: "string", description: "ISO end of the window. Defaults to 21 days out. For 'this weekend' use the coming Sunday night." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "remember_taste",
    description:
      "Store a lasting preference, one per call: a kind of night, music, food, scene, vibe, favorite place, dealbreaker, or what they want more of. Not for a one-off ask like what they want tonight. Call it for each one in a message, e.g. three calls for afrobeats, rnb, and cuban food.",
    input_schema: {
      type: "object",
      required: ["kind", "label", "category"],
      properties: {
        kind: { type: "string", enum: ["like", "dislike", "constraint"], description: "dislike or constraint for dealbreakers" },
        label: {
          type: "string",
          description: "Short taste label in their words, e.g. natural wine, no techno, lagniappe for the backyard",
        },
        category: {
          type: "string",
          enum: [...TASTE_CATEGORIES],
          description:
            "activity (parties, comedy, live music), music, food, scene, vibe (intimate, high-energy, hidden gems), social (crew, dates, solo), timing (late nights, sundays), place (a favorite spot, with what they love about it), goal (what they want more of)",
        },
        source: {
          type: "string",
          enum: ["explicit", "inferred", "behavior"],
          description:
            "explicit if they said it outright (default). inferred if you're reading between the lines. behavior if it's from what they did, like saving or passing on a rec",
        },
        confidence: {
          type: "number",
          description: "0-1. Leave out when they said it outright. A guess from one thing they said is about 0.5",
        },
        evidence: { type: "string", description: "For inferred or behavior: what it's based on, e.g. passed on two packed clubs" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "forget_taste",
    description:
      "Remove a saved taste the user has moved on from, e.g. they're over techno or don't care about wine bars anymore. Use the label as it appears under Known taste. If they name something new instead, also call remember_taste for it.",
    input_schema: {
      type: "object",
      required: ["label"],
      properties: {
        label: { type: "string", description: "The saved taste label to remove, e.g. techno" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "save_event",
    description:
      "Save an event so Haps remembers it. With remind: true, Haps also texts them before it: a check-in a couple of days out and a heads-up the day of. Pass its page url from search_events, or a link the user sent. Call it again with the same url to fill in the time or turn reminders on or off.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The event's page url from search_events, or a link the user sent. Leave it out for a flyer photo with no link" },
        title: { type: "string", description: "The event's name. Required when there's no url" },
        starts_at: {
          type: "string",
          description:
            "When it starts, in the venue's local time with its UTC offset, e.g. 2026-11-14T22:00:00-05:00. Just the date (2026-11-14) when the time isn't known yet",
        },
        venue: { type: "string", description: "Where it is, e.g. Tomorrowland Miami" },
        remind: {
          type: "boolean",
          description: "true once they say yes to you texting them before it, false if they say no. Leave it out otherwise",
        },
        note: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "remove_save",
    description:
      "Drop an event they saved, and the texts Haps would send about it. Use when they say they're not going anymore or want it gone.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The saved event's title, as listed under their saves" },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "record_feedback",
    description:
      "Log whether they went to an event and how it was, when they tell you (often answering your \"did you go?\" text). Once per event. This is how Haps learns what people like them actually loved.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The event, as listed under their saves or as they named it" },
        went: { type: "boolean" },
        verdict: {
          type: "string",
          enum: ["loved", "liked", "meh", "bad"],
          description: "How it was for them, from what they said. Leave it out if they didn't go or didn't say",
        },
        feedback: { type: "string", description: "What they said about it, short and in their words, e.g. \"dj was crazy, way too packed by 1\"" },
      },
      required: ["title", "went"],
      additionalProperties: false,
    },
  },
  {
    name: "list_saves",
    description: "List this user's saved events and links.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "update_profile",
    description:
      "Save facts about them: name, city, area, where they like going out, how far they'll go, budget, when they go out, who with, what they want more of, or how they found Haps. Save each one as soon as they say it, in their words. Only save an email after you repeated it back and they said it's right.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Their first name or what they go by" },
        full_name: { type: "string", description: "Their first and last name" },
        city: { type: "string", description: "City they are in, e.g. NYC" },
        area: {
          type: "string",
          description: "The part of town they live in or usually head out from, e.g. north miami or brickell. Not where they happen to be for one night.",
        },
        email: { type: "string", description: "Their email, only once they confirmed it" },
        found_us: {
          type: "string",
          description: "How they found out about Haps, in their words, e.g. my friend jay, tiktok, a flyer at the shrine",
        },
        neighborhoods: { type: "string", description: "Neighborhoods they like going out in, e.g. wynwood, little havana" },
        travel: {
          type: "string",
          description: "How far they'll go, e.g. stays close, will drive 30 min for something worth it",
        },
        budget: {
          type: "string",
          description: "A normal night out, e.g. $40-80 per person, more for something special. Not tonight's budget",
        },
        going_out: {
          type: "string",
          description: "When they usually go out and how they plan, e.g. fridays late, decides day of. Not when they're free this week",
        },
        social: { type: "string", description: "Who they usually go out with, e.g. the crew, date nights, solo" },
        discovery_goal: {
          type: "string",
          description: "What they want Haps to make better, e.g. hidden gems, meeting people, better date spots",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "record_pick",
    description:
      "Log which rec they're going with, or one they turned down. Call it when they say they're going to, picking, or leaning toward a place or event you sent (picked), or clearly say no to one (passed). One call per place.",
    input_schema: {
      type: "object",
      required: ["name", "outcome"],
      properties: {
        name: { type: "string", description: "The place or event as you named it, e.g. the shrine" },
        outcome: { type: "string", enum: ["picked", "passed"] },
        note: { type: "string", description: "Anything they said about it, e.g. going saturday with the girls, too far" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "rsvp",
    description:
      "RSVP them to a free event on its site: Haps opens the page in a browser and fills the form with their name and email, then texts them how it went. Only after your last message asked to rsvp them with their full name, email, and the event's name, and they said yes. The event has to be saved first, unless it's a link that couldn't be read: then pass the link as url and the name they call it as title. It runs in the background, so reply that you're on it.",
    input_schema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", description: "The saved event's title, as listed under their saves" },
        url: {
          type: "string",
          description:
            "The event's page: a link they sent or one from search_events or web_search. Pass it when the save has no link (a flyer), or when there's no save because the link couldn't be read; the rsvp saves it",
        },
      },
      additionalProperties: false,
    },
  },
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

type ToolInput = Record<string, unknown>;

const DAY_MS = 24 * 60 * 60 * 1000;

// Same zone as the prompt's date, so a Friday 8pm start isn't searched as Saturday.
const LOCAL_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "long", day: "numeric" });
const LOCAL_YEAR = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" });

/** The asked window as words a search engine matches on event pages, e.g. "October 24 or October 25 2026". */
function windowWords(from: string | undefined, to: string | undefined): string {
  const start = Date.parse(from ?? "") || Date.now();
  const end = Date.parse(to ?? "");
  // Pages say the date in words, so a long or open window just asks for what's coming up.
  if (!end || end < start || end - start > 7 * DAY_MS) return "upcoming";
  const lastDay = LOCAL_DAY.format(end);
  const days: string[] = [];
  for (let day = start; days.length <= 8; day += DAY_MS) {
    days.push(LOCAL_DAY.format(day));
    if (days.at(-1) === lastDay) break;
  }
  const year = LOCAL_YEAR.format(start);
  return days.length === 1 ? `on ${days[0]} ${year}` : `on ${days.slice(0, -1).join(", ")} or ${days.at(-1)} ${year}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return tags.length > 0 ? tags : undefined;
}

const plain = (text: string) => ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/** Whether the event page says `value` and the user never did, so a page can't pick their city, name, or taste. */
function plantedByPage(value: string, session: ToolSession): boolean {
  if (!session.pageText) return false;
  const wanted = plain(value);
  return plain(session.pageText).includes(wanted) && !plain(session.userText).includes(wanted);
}

function isTasteKind(value: unknown): value is TasteKind {
  return value === "like" || value === "dislike" || value === "constraint";
}

function isTasteCategory(value: unknown): value is TasteCategory {
  return TASTE_CATEGORIES.includes(value as TasteCategory);
}

function isTasteSource(value: unknown): value is TasteSource {
  return value === "explicit" || value === "inferred" || value === "behavior";
}

/** Per-reply state. Each reply gets its own, so one user's search never leaks into another's. */
export type ToolSession = {
  webSearches: number;
  /** Links web_search returned, the only page links a reply may pass on. */
  webUrls: Set<string>;
  /** web_search results this reply, so the handler can attach the one place's own site as a card. */
  webResults: WebResult[];
  /** Event pages search_events found this reply, so the ones the reply names keep their links for follow-ups. */
  eventPages: { title: string; url: string }[];
  /** Urls from the user's saves: exact matches only, not whole hosts. */
  savedUrls: Set<string>;
  /** The user's own text this reply (chat plus current message), the only other source of links. */
  userText: string;
  /** The thread before this message. An email must show up here first, so it was repeated back and confirmed. */
  earlierText: string;
  /** Just the message being answered, the only place read_event_link accepts a link from. */
  userMessage: string;
  /** Event pages read this reply, by normalized url, so the same link is read once and reads stay capped. */
  eventReads: Map<string, Promise<EventDetails | null>>;
  /** Text of the event fields read_event_link returned this reply; empty until a page is read. */
  pageText: string;
  /** Bare links (like "lofi.fm") from stored taste and saves, the user's own data. */
  storedText: string;
  /** Untrusted content (search results, event pages) was seen this reply, so links get filtered. Images set it too. */
  untrusted: boolean;
  /** Their taste or the profile facts it's built from changed, so the taste vector is stale. */
  tasteChanged: boolean;
  /** Recs searches returned this reply, by id, so the ones the reply names get logged as shown. */
  recsOffered: Map<string, ShownRec>;
  /** The conversation this reply goes to, where reminders for a save get texted. */
  spaceId: string;
  /** Haps's last message before this one, where an rsvp has to have been asked for and confirmed. */
  lastReply: string;
};

/**
 * What people with taste like theirs went to and loved, for search_events. A loved one-off that's
 * over can't be sent, but a recurring night (it has a schedule) or the same promoter's next one can.
 * Other people's words are untrusted, and no one's name goes in.
 */
async function similarFor(profile: Profile, session: ToolSession, metro: string): Promise<{ loved_by_people_like_them?: unknown[]; similar_hint?: string }> {
  const taste = await currentTaste(profile, session);
  if (!taste) return {};
  const loved = await lovedBySimilar(taste, profile.id, metro).catch((err: unknown) => {
    console.warn(`[similar] lookup failed: ${formatError(err)}`);
    return [];
  });
  if (!loved.length) return {};
  session.untrusted = true;
  for (const item of loved) if (item.url) session.webUrls.add(item.url);
  return {
    loved_by_people_like_them: loved.map((item) => ({
      event: item.rec_name ?? item.title,
      venue: item.venue,
      date: item.event_date,
      schedule: item.schedule,
      verdict: item.verdict,
      untrusted_what_they_said: item.feedback?.slice(0, 160) ?? null,
      url: item.url,
    })),
    similar_hint:
      "Events people with taste like theirs went to and loved. Use them to pick: a recurring night here that fits beats a random listing, and you can say people with their taste loved it. Only send one when it's on again when they want to go (a schedule, or a listing above shows the date). Never name who said it.",
  };
}

/** Their taste vector for a search, rebuilt first if this reply changed what it's made from. */
async function currentTaste(profile: Profile, session: ToolSession): Promise<number[] | undefined> {
  await refreshTasteIfChanged(profile, session);
  return tasteVector(profile);
}

/** Rebuilds the taste vector once per change, not once per saved taste. */
export async function refreshTasteIfChanged(profile: Profile, session: ToolSession): Promise<void> {
  if (!session.tasteChanged) return;
  session.tasteChanged = false;
  await refreshTasteEmbedding(profile, await listTaste(profile.id));
}

function isExaPage(url: string): boolean {
  try {
    return /(^|\.)exa\.ai$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** What Claude sees of the recs: everything but the id and bookkeeping. */
function forClaude(recs: RecResult[]): Omit<RecResult, "id" | "metro" | "url_checked_at">[] {
  return recs.map(({ id: _id, metro: _metro, url_checked_at: _checked, ...rec }) => rec);
}

/**
 * Recs without a site that get looked up as soon as a search returns them, nearest first. The
 * lookup (~1s) runs while Claude writes the reply, so the card is usually ready by send time.
 * Ones further down are only looked up if the reply names them.
 */
const PREFETCH_SITES = 4;

/** A rec's own site can be sent and becomes the place card, like a web result's. */
function keepRecLinks(recs: RecResult[], session: ToolSession): void {
  recs.forEach((rec, i) => {
    let lookup: Promise<string | null> | undefined;
    const site = () => (lookup ??= ensureRecSite(rec));
    session.recsOffered.set(rec.id, { id: rec.id, name: rec.name, url: rec.url, site });
    if (!rec.url && i < PREFETCH_SITES) void site();
  });
  for (const rec of recs) {
    if (!rec.url) continue;
    session.webUrls.add(rec.url);
    session.webResults.push({ title: rec.name, url: rec.url, published: null, highlights: [] });
  }
}

/** Asks about eating, which also need what they're craving before a search. */
const FOOD_ASK = /\b(eat|eats|food|hungry|dinner|lunch|brunch|breakfast|restaurant|restaurants|bite|snack|cuisine)\b/i;

/** Each web search costs a tool round, so cap them to leave room for an answer. */
const MAX_WEB_SEARCHES = 3;
/** Links read per reply. The message is already capped at 2 links, this holds even if the model retries. */
const MAX_EVENT_READS = 2;

export async function runTool(
  profile: Profile,
  name: string,
  input: ToolInput,
  session: ToolSession,
): Promise<unknown> {
  switch (name) {
    case "web_search": {
      const query = asString(input.query);
      if (!query) return { error: "query is required" };
      // A place rec is only as good as its fit, so the kind of spot (and for food, what they're
      // craving) has to come from them first, like vibe and budget do for search_events.
      if (input.purpose !== "look_up") {
        const food = FOOD_ASK.test(`${query} ${session.userMessage}`);
        const missing = [!asString(input.spot_vibe) && "the kind of spot they want", food && !asString(input.craving) && "what they're craving"].filter(Boolean);
        if (missing.length) {
          return {
            error: "ask_first",
            hint: `Don't search yet. Ask them ${missing.join(" and ")} in one short question first, e.g. "what you craving, and you thinking classy sit-down or a low-key spot?"`,
          };
        }
      }
      if (session.webSearches >= MAX_WEB_SEARCHES) {
        return { error: "search_limit", hint: "No more searches this reply. Answer with what you already found." };
      }
      session.webSearches += 1;
      // A city with a recs list is searched from it. A search naming another city still goes to the web.
      const metro = knownMetro(query) ?? (profile.city ? metroFor(profile.city) : null);
      if (metro && RECS_METROS.has(metro) && input.live !== true) {
        const recs = await searchRecs(query, metro, { taste: await currentTaste(profile, session) });
        keepRecLinks(recs, session);
        return {
          count: recs.length,
          haps_recs: forClaude(recs),
          hint: "These are Haps's own vetted recs, closest match first. Recommend only the ones that fit what they asked, and only with the details listed here. If none is near where they are or in their budget, call web_search again with live: true instead of sending one that's far. If your answer is about one place that has a url, end with that url alone on the last line.",
        };
      }
      session.untrusted = true;
      // Exa's own place pages (exa.ai/library/...) are its index, not the venue's site, so they're never sent.
      const results = (await searchWeb(query)).map((result) => (isExaPage(result.url) ? { ...result, url: "" } : result));
      for (const result of results) if (result.url) session.webUrls.add(result.url);
      session.webResults.push(...results.filter((result) => result.url));
      // Page text is labeled as data so instructions planted in it aren't mistaken for the user's.
      // The prompt alone was skipped (a "barcelona in wynwood" reply came back with no link), so it's repeated next to the results.
      return {
        count: results.length,
        untrusted_web_content: results,
        hint: "If your answer is about one specific place, even to steer them away from it, end with that place's own website url from these results alone on the last line. Skip it if none of these is the place's own site.",
      };
    }
    case "read_event_link": {
      const url = asString(input.url);
      if (!url) return { error: "url is required" };
      // Only links the user sent right now, so a link from a page or old chat can't make Haps fetch it.
      // The user's own spelling is what gets fetched, not whatever the model passed.
      const sent = eventLinksIn(session.userMessage).find((link) => isExactLink(url, [link]));
      if (!sent) {
        return { error: "url_not_in_message", hint: "Only read a link the user sent in their latest message." };
      }
      // The page is read as untrusted text; its fields never join webUrls or savedUrls.
      session.untrusted = true;
      const key = normalizeLink(sent);
      let read = session.eventReads.get(key);
      if (!read) {
        if (session.eventReads.size >= MAX_EVENT_READS) {
          return { error: "read_limit", hint: "No more links this reply. Ask them for the day, time, and place." };
        }
        read = readEventPage(sent);
        session.eventReads.set(key, read);
      }
      const event = await read;
      if (!event?.starts_at) {
        return { error: "unreadable", hint: "Ask them for the day, time, and place." };
      }
      session.pageText += `\n${[event.title, event.venue, event.address, event.price_note].filter(Boolean).join("\n")}`;
      const when = describeWhen(event.starts_at, event.ends_at);
      // Every event someone sends becomes a rec draft, credited to them. Not awaited: it's not part of the reply.
      if (!when.past) void saveSharedRec(profile, sent, event);
      if (when.past) {
        return {
          error: "past_event",
          when: when.when,
          hint: "That date already passed. Say it looks like it already happened and ask if they meant a different one.",
        };
      }
      return {
        untrusted_page_content: {
          title: event.title,
          when: when.when,
          time_known: when.timeKnown,
          starts_at: event.starts_at,
          ends_at: event.ends_at,
          venue: event.venue,
          address: event.address,
          price_note: event.price_note,
          age: event.age,
        },
        hint: `In this same reply: tell them what it is, when, and where, call save_event (the url they sent, title, venue, starts_at ${event.starts_at}), and ask if they want you to remind them before it.${when.timeKnown ? " Mention the age limit if there is one." : " The page had no start time, so ask what time it starts too. When they say, save it again with the full time."}`,
      };
    }
    case "search_events": {
      // A great night that's the wrong vibe or over budget is a bad rec, so both have to be known first.
      const missing = [!asString(input.vibe) && "vibe", !asString(input.budget) && "budget"].filter(Boolean);
      if (missing.length) {
        return {
          error: "ask_first",
          hint: `Don't search yet. Ask them about their ${missing.join(" and ")} in one short question first.`,
        };
      }
      const taste = await listTaste(profile.id);
      if (!taste.some((signal) => signal.kind === "like")) {
        return {
          error: "taste_required",
          hint: "Ask about their vibe, music, and usual spots first. Save each with remember_taste.",
        };
      }
      const city = asString(input.city) ?? profile.city;
      if (!city) {
        return { error: "city_required", hint: "Ask the user what city they are in, then call update_profile." };
      }
      if (session.webSearches >= MAX_WEB_SEARCHES) {
        return { error: "search_limit", hint: "No more searches this reply. Answer with what you already found." };
      }
      session.webSearches += 1;
      const tags = asStringArray(input.tags);
      const vibe = [asString(input.query), asString(input.vibe), ...(tags ?? [])].filter(Boolean).join(" ") || "party";
      const metro = metroFor(city);
      if (RECS_METROS.has(metro)) {
        const recs = await searchRecs(vibe, metro, { categories: NIGHT_CATEGORIES, taste: await currentTaste(profile, session) });
        keepRecLinks(recs, session);
        session.eventPages.push(...recs.flatMap((rec) => (rec.url ? [{ title: rec.name, url: rec.url }] : [])));
        const similar = await similarFor(profile, session, metro);
        return {
          count: recs.length,
          haps_recs: forClaude(recs),
          ...similar,
          hint: "These are recurring nights and venues from Haps's own vetted list, closest match first, not dated listings. Recommend only the ones that fit, and give when as the schedule says it (e.g. saturdays). Never make up a date, a lineup, or say it's on tonight unless the schedule shows that day. If there's no schedule, say it's a spot to check, not that something is on. For one rec that has a url, end with that url alone on the last line.",
        };
      }
      // Titles and venues are scraped from organizers, so they can carry links too.
      session.untrusted = true;
      // Live from ticketing sites outside the recs metros.
      // TikTok is extra: if Monid is down or slow, answer from the ticketing pages alone.
      const [pages, videos] = await Promise.all([
        searchEventPages(`${vibe} events in ${city} ${windowWords(asString(input.from), asString(input.to))}`),
        searchTikTokVideos(`${vibe} ${city}`).catch((err: unknown) => {
          console.warn(`[tiktok] search failed: ${err instanceof Error ? err.message : String(err)}`);
          return [];
        }),
      ]);
      // Event pages and videos can be sent as links or saved, so they count as found by a search.
      for (const page of pages) session.webUrls.add(page.url);
      for (const video of videos) session.webUrls.add(video.url);
      session.eventPages.push(...pages.map((page) => ({ title: page.title, url: page.url })));
      const similar = await similarFor(profile, session, metro);
      return {
        count: pages.length + videos.length,
        untrusted_event_pages: pages,
        untrusted_tiktok_videos: videos,
        ...similar,
        hint: "Event pages are ticketing listings. TikTok videos are recent promo clips and weekend guides, and many are for other cities, past nights, or not nights out at all, so skip those. Only recommend ones that show a date inside the window they asked about and a place in or near their city, and give the day and time as shown. Skip any without a clear date. For one event, end with its page or video url alone on the last line.",
      };
    }
    case "remember_taste": {
      if (!isTasteKind(input.kind) || !asString(input.label)) {
        return { error: "kind and label are required" };
      }
      if (session.untrusted && hasLink(asString(input.label)!)) {
        return { error: "link_in_label", hint: "Labels are short taste words, not links." };
      }
      if (plantedByPage(asString(input.label)!, session)) {
        return { error: "not_from_user", hint: "That came from the event page. Only save tastes the user said themselves." };
      }
      const signal = await rememberTaste({
        profileId: profile.id,
        kind: input.kind,
        label: asString(input.label)!,
        category: isTasteCategory(input.category) ? input.category : "other",
        source: isTasteSource(input.source) ? input.source : "explicit",
        confidence: asNumber(input.confidence),
        evidence: asString(input.evidence),
      });
      session.tasteChanged = true;
      return { saved: { kind: signal.kind, label: signal.label, category: signal.category, source: signal.source, confidence: signal.confidence } };
    }
    case "forget_taste": {
      const label = asString(input.label);
      if (!label) return { error: "label is required" };
      if (plantedByPage(label, session)) {
        return { error: "not_from_user", hint: "That came from the event page. Only the user can drop a taste." };
      }
      const removed = await forgetTaste(profile.id, label);
      if (removed.length > 0) session.tasteChanged = true;
      if (removed.length === 0) return { removed: [], hint: "No saved taste matched. Use a label from Known taste." };
      return { removed: removed.map((signal) => `${signal.kind}: ${signal.label}`) };
    }
    case "save_event": {
      // Saved urls come back in later replies as trusted, so a planted one can't be saved.
      const url = asString(input.url);
      if (session.untrusted && (hasLink(asString(input.title) ?? "") || hasLink(asString(input.note) ?? ""))) {
        return { error: "link_in_title_or_note", hint: "Keep links out of titles and notes. Put the link in url." };
      }
      if (
        session.untrusted &&
        url &&
        !isExactLink(url, [...session.webUrls, ...session.savedUrls, ...(session.userText.match(LINK) ?? [])])
      ) {
        return { error: "url_not_from_user_or_search", hint: "Only save links the user sent or a search returned." };
      }
      if (session.untrusted && hasLink(asString(input.venue) ?? "")) {
        return { error: "link_in_title_or_note", hint: "Keep links out of the venue. Put the link in url." };
      }
      const startsAt = asString(input.starts_at);
      const start = startsAt ? cleanStart(startsAt) : null;
      if (startsAt && !start) {
        return { error: "bad_starts_at", hint: "starts_at must look like 2026-11-14T22:00:00-05:00, or 2026-11-14 when the time isn't known." };
      }
      const saved = await saveEvent({
        profileId: profile.id,
        url: asString(input.url),
        title: asString(input.title),
        note: asString(input.note),
        startsAt: start,
        venue: asString(input.venue),
        remind: typeof input.remind === "boolean" ? input.remind : undefined,
      });
      // A flyer has no link: Exa and Jev look for the event online in the background, and only a
      // verified match gets a link and goes into recs. Run once, when the details first come in.
      if (!url && !saved.url && start) void verifyFlyerEvent(profile, saved);
      // A reminder that can't be scheduled shouldn't lose the save itself.
      const reminders = await scheduleReminders(saved, { platform: PROVIDER, spaceId: session.spaceId, zone: zoneFor(profile.city) }).catch(
        (err: unknown) => {
          console.error(`[remind] scheduling failed save=${saved.id}: ${formatError(err)}`);
          return null;
        },
      );
      const texts = Object.keys(reminders ?? {});
      // Errors only when a promised reminder can't happen, so a reply already written beside this call gets fixed.
      if (saved.remind && !saved.event_date) {
        return { error: "no_date", hint: "Haps can't remind them without a date. Ask what day it is, then save it again with starts_at." };
      }
      if (saved.remind && !texts.length) {
        return { error: "too_soon", hint: "It's too soon for a reminder to be worth it. Tell them it's coming right up, without promising a text." };
      }
      return {
        saved: { title: saved.title, event_date: saved.event_date, starts_at: saved.starts_at, venue: saved.venue },
        texts_planned: texts,
      };
    }
    case "record_feedback": {
      const title = asString(input.title);
      if (!title || typeof input.went !== "boolean") return { error: "title and went are required" };
      if (plantedByPage(title, session) || plantedByPage(asString(input.feedback) ?? "", session)) {
        return { error: "not_from_user", hint: "Only log what the user said themselves." };
      }
      const saves = await listSaves(profile.id);
      const lower = title.toLowerCase();
      const matches = saves.filter((save) => {
        const name = (save.title ?? "").toLowerCase();
        return name && (name.includes(lower) || lower.includes(name));
      });
      const verdict = VERDICTS.find((item) => item === input.verdict) ?? null;
      const logged = await recordFeedback({
        profileId: profile.id,
        metro: profile.city ? metroFor(profile.city) : null,
        title,
        save: matches.length === 1 ? matches[0]! : null,
        went: input.went,
        verdict,
        feedback: asString(input.feedback)?.slice(0, 500) ?? null,
      });
      return { logged: { title, went: input.went, verdict }, counts_toward_rec: Boolean(logged.rec_id) };
    }
    case "remove_save": {
      const title = asString(input.title)?.toLowerCase();
      if (!title) return { error: "title is required" };
      const saves = await listSaves(profile.id);
      const matches = saves.filter((save) => {
        const name = (save.title ?? save.url ?? "").toLowerCase();
        return name && (name.includes(title) || title.includes(name));
      });
      if (matches.length !== 1) {
        return {
          error: matches.length ? "more_than_one" : "not_found",
          hint: "Ask which one they mean.",
          saves: saves.map((save) => save.title ?? save.url),
        };
      }
      await removeSave(profile.id, matches[0]!.id);
      return { removed: matches[0]!.title ?? matches[0]!.url };
    }
    case "list_saves": {
      const saves = await listSaves(profile.id);
      // Saved links can come from scraped pages, but a user asking for their saved link should get it.
      session.untrusted = true;
      for (const save of saves) if (save.url) session.savedUrls.add(save.url);
      return { count: saves.length, saves };
    }
    case "update_profile": {
      const patch: ProfilePatch = {};
      for (const field of PROFILE_FIELDS) {
        const value = asString(input[field])?.replace(/\s+/g, " ");
        if (value) patch[field] = field === "area" || field === "email" ? value.toLowerCase() : value;
      }
      if (Object.keys(patch).length === 0) {
        return { error: "nothing_to_update" };
      }
      if (patch.full_name && patch.full_name.split(" ").length < 2) {
        return { error: "need_last_name", hint: "That's one name. Ask for their first and last name." };
      }
      if (Object.values(patch).some((value) => plantedByPage(value, session))) {
        return { error: "not_from_user", hint: "That came from the event page. Only use what the user said themselves." };
      }
      const { email } = patch;
      if (email) {
        if (!EMAIL.test(email)) return { error: "invalid_email", hint: "That doesn't look like an email. Ask them for it again." };
        // It has to be in the thread already, so they saw it repeated back before this yes, and it can't come from a page.
        if (!session.earlierText.toLowerCase().includes(email) || !session.userText.toLowerCase().includes(email)) {
          return { error: "email_not_confirmed", hint: `Repeat it back ("${email}, that right?") and save it once they say yes.` };
        }
      }
      const updated = await updateProfile(profile.id, patch);
      applyProfileUpdate(profile, updated);
      // Who they go with and what they want more of are part of their taste vector.
      if (patch.social || patch.discovery_goal) session.tasteChanged = true;
      return { saved: patch };
    }
    case "record_pick": {
      const pickName = asString(input.name);
      const outcome = input.outcome === "picked" || input.outcome === "passed" ? input.outcome : undefined;
      if (!pickName || !outcome) return { error: "name and outcome are required" };
      if (plantedByPage(pickName, session)) {
        return { error: "not_from_user", hint: "Only log what the user said they're picking." };
      }
      const logged = await recordPick({ profileId: profile.id, name: pickName, outcome, note: asString(input.note) });
      return { logged: { name: logged.name, outcome } };
    }
    case "rsvp": {
      if (!RSVP_ON) return { error: "rsvp_off", hint: "Haps can't rsvp right now. Send them the event's link so they can do it in a tap." };
      const title = asString(input.title)?.toLowerCase();
      if (!title) return { error: "title is required" };
      if (!profile.full_name || !profile.email) {
        return { error: "missing_details", hint: "Haps needs their first and last name and their email to rsvp. Ask for whichever is missing." };
      }
      const linkGiven = asString(input.url);
      if (linkGiven && !isExactLink(linkGiven, [...session.webUrls, ...session.savedUrls, ...(session.userText.match(LINK) ?? [])])) {
        return { error: "url_not_from_user_or_search", hint: "Only use the save's link, one they sent, or one a search returned." };
      }
      const saves = await listSaves(profile.id);
      // The save for the link they sent is the one, even when other saves share its name (an
      // Instagram post and the DICE page for the same night).
      const linked = linkGiven ? saves.filter((save) => save.url && isExactLink(save.url, [linkGiven])) : [];
      const matches = linked.length
        ? linked.slice(0, 1)
        : saves.filter((save) => {
            const saved = (save.title ?? save.url ?? "").toLowerCase();
            return saved && (saved.includes(title) || title.includes(saved));
          });
      // A link nobody could read (Posh, Partiful pages that only render in a browser) never got saved.
      // The rsvp's browser can open it, so save it now under the name they confirmed.
      if (linkGiven && !linked.length) {
        matches.length = 0;
        matches.push(await saveEvent({ profileId: profile.id, url: linkGiven, title: asString(input.title) }));
      }
      if (matches.length !== 1) {
        return {
          error: matches.length ? "more_than_one" : "not_saved",
          hint: matches.length ? "More than one save has that name. Call rsvp again with the event's link as url." : "Save the event with save_event first, then rsvp.",
          saves: saves.map((save) => save.title ?? save.url),
        };
      }
      const save = matches[0]!;
      // They have to have seen exactly who Haps would sign up, and for what, right before saying yes.
      const asked = session.lastReply.toLowerCase();
      const named = (save.title ?? "").toLowerCase().split(/\s+/).filter((word) => word.length >= 3);
      if (!asked.includes(profile.email) || (named.length && !named.some((word) => asked.includes(word)))) {
        return {
          error: "not_confirmed",
          hint: `Ask first, in one line: rsvp you as ${profile.full_name}, ${profile.email}, for ${save.title ?? "it"}? Call rsvp once they say yes.`,
        };
      }
      // A flyer has no link: look for its page the same way a flyer save is verified, so the rsvp doesn't hang on Claude finding it.
      const url =
        save.url ??
        linkGiven ??
        (await findFlyerPage(profile, save).catch((err: unknown) => {
          console.warn(`[rsvp] page search failed for save=${save.id}: ${formatError(err)}`);
          return null;
        }));
      if (!url) {
        return {
          error: "no_link",
          hint: "Haps searched and couldn't find this event's page, so nothing is running. Tell them you couldn't find where to rsvp, and ask if they have the link.",
        };
      }
      const started = await beginRsvp({ profile, save, url, platform: PROVIDER, spaceId: session.spaceId });
      if (!started) return { error: "already_running", hint: "Haps is already rsvping them for this. Tell them it's in progress." };
      return { started: true, event: save.title, as: { name: profile.full_name, email: profile.email } };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}
