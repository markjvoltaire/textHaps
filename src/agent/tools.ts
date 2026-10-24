import type Anthropic from "@anthropic-ai/sdk";
import { applyProfileUpdate, updateProfile } from "../db/profiles.ts";
import { listSaves, saveEvent } from "../db/saves.ts";
import { forgetTaste, listTaste, rememberTaste } from "../db/taste.ts";
import type { EventRow, Profile, TasteKind } from "../db/types.ts";
import { searchEventPages, searchWeb, type WebResult } from "../search/exa.ts";
import { describeWhen, eventLinksIn, readEventPage, type EventDetails } from "./eventLink.ts";
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
      },
      required: ["query"],
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
      "Search ticketing sites (DICE, Posh, Partiful, Eventbrite, RA, Shotgun, Luma) live for nights in this city. Recommend only events these pages back up, with the date the page shows. Do not invent events. Do not call until you know their taste and city.",
    input_schema: {
      type: "object",
      properties: {
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
      "Store a lasting preference. Use when the user likes, dislikes, or constrains something, not for a one-off ask like what they want tonight. During onboarding call it once per music style, vibe, or usual spot they mention (kind like, short label such as house, rooftop day parties, club space).",
    input_schema: {
      type: "object",
      required: ["kind", "label"],
      properties: {
        kind: { type: "string", enum: ["like", "dislike", "constraint"] },
        label: { type: "string", description: "Short taste label, e.g. natural wine or no techno" },
        weight: { type: "number", description: "Optional strength, default 1" },
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
    description: "Save an event from search_events or a URL the user sent so Haps can remember it later.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Event id from search_events" },
        url: { type: "string", description: "A link the user shared that is not in the catalog" },
        title: { type: "string" },
        note: { type: "string" },
      },
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
      "Save their city (and name, if they offer it). Call this whenever they mention where they live or go out.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Their first name or what they go by" },
        city: { type: "string", description: "City they are in, e.g. NYC" },
      },
      additionalProperties: false,
    },
  },
];

type ToolInput = Record<string, unknown>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The asked window as words a search engine matches on event pages, e.g. "October 24 or October 25 2026". */
function windowWords(from: string | undefined, to: string | undefined): string {
  const start = Date.parse(from ?? "") || Date.now();
  const end = Date.parse(to ?? "");
  // Pages say the date in words, so a long or open window just asks for what's coming up.
  if (!end || end < start || end - start > 7 * DAY_MS) return "upcoming";
  const days: string[] = [];
  for (let day = start; day <= end; day += DAY_MS) {
    days.push(new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric" }).format(day));
  }
  const year = new Date(start).getUTCFullYear();
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

/** Per-reply state. Each reply gets its own, so one user's search never leaks into another's. */
export type ToolSession = {
  searched: EventRow[];
  webSearches: number;
  /** Links web_search returned, the only page links a reply may pass on. */
  webUrls: Set<string>;
  /** web_search results this reply, so the handler can attach the one place's own site as a card. */
  webResults: WebResult[];
  /** Urls from the user's saves: exact matches only, not whole hosts. */
  savedUrls: Set<string>;
  /** The user's own text this reply (chat plus current message), the only other source of links. */
  userText: string;
  /** Just the message being answered, the only place read_event_link accepts a link from. */
  userMessage: string;
  /** Event pages read this reply, by normalized url, so the same link is read once and reads stay capped. */
  eventReads: Map<string, Promise<EventDetails | null>>;
  /** Text of the event fields read_event_link returned this reply; empty until a page is read. */
  pageText: string;
  /** Bare links (like "lofi.fm") from stored taste and saves, the user's own data. */
  storedText: string;
  /** Untrusted content (search results, scraped listings) was seen this reply, so links get filtered. Images set it too. */
  untrusted: boolean;
};

function isExaPage(url: string): boolean {
  try {
    return /(^|\.)exa\.ai$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

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
      if (session.webSearches >= MAX_WEB_SEARCHES) {
        return { error: "search_limit", hint: "No more searches this reply. Answer with what you already found." };
      }
      session.webSearches += 1;
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
        hint: when.timeKnown
          ? "Offer to save it with save_event, using the url they sent. Mention the age limit if there is one."
          : "The page had no start time. Ask what time it starts, and offer to save it with save_event using the url they sent.",
      };
    }
    case "search_events": {
      // Titles and venues are scraped from organizers, so they can carry links too.
      session.untrusted = true;
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
      // Live from ticketing sites for now, not the ingested listings table, which went stale.
      const vibe = [asString(input.query), ...(asStringArray(input.tags) ?? [])].filter(Boolean).join(" ") || "party";
      const pages = await searchEventPages(`${vibe} events in ${city} ${windowWords(asString(input.from), asString(input.to))}`);
      // Event pages can be sent as links or saved, so they count as found by a search.
      for (const page of pages) session.webUrls.add(page.url);
      return {
        count: pages.length,
        untrusted_event_pages: pages,
        hint: "Each is an event's web page. Only recommend ones whose page shows a date inside the window they asked about and a place in or near their city, and give the day and time as the page shows it. Skip any without a clear date. For one event, end with its page url alone on the last line.",
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
        weight: asNumber(input.weight),
      });
      return { saved: signal };
    }
    case "forget_taste": {
      const label = asString(input.label);
      if (!label) return { error: "label is required" };
      if (plantedByPage(label, session)) {
        return { error: "not_from_user", hint: "That came from the event page. Only the user can drop a taste." };
      }
      const removed = await forgetTaste(profile.id, label);
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
      const saved = await saveEvent({
        profileId: profile.id,
        listingId: asString(input.event_id),
        url: asString(input.url),
        title: asString(input.title),
        note: asString(input.note),
      });
      return { saved };
    }
    case "list_saves": {
      const saves = await listSaves(profile.id);
      // Saved listings are scraped, but a user asking for their saved link should get it.
      session.untrusted = true;
      for (const save of saves) for (const url of [save.url, save.listing?.url]) if (url) session.savedUrls.add(url);
      return { count: saves.length, saves };
    }
    case "update_profile": {
      const name = asString(input.name);
      const city = asString(input.city);
      if (!name && !city) {
        return { error: "nothing_to_update" };
      }
      if ([name, city].some((value) => value && plantedByPage(value, session))) {
        return { error: "not_from_user", hint: "That came from the event page. Only use a name or city the user said themselves." };
      }
      const updated = await updateProfile(profile.id, {
        ...(name ? { name } : {}),
        ...(city ? { city } : {}),
      });
      applyProfileUpdate(profile, updated);
      return { name: updated.name, city: updated.city };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}
