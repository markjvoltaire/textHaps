import type Anthropic from "@anthropic-ai/sdk";
import { searchEvents } from "../db/events.ts";
import { applyProfileUpdate, updateProfile } from "../db/profiles.ts";
import { listSaves, saveEvent } from "../db/saves.ts";
import { listTaste, rememberTaste } from "../db/taste.ts";
import type { EventRow, Profile, TasteKind } from "../db/types.ts";
import { searchWeb } from "../search/exa.ts";
import { hasLink, isExactLink, LINK } from "./links.ts";

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
    name: "search_events",
    description:
      "Load nights for this city. Results already passed a keep filter and a vibe check (music + crowd vs the ask). Recommend only these. Do not invent events. Do not call until you know their taste and city.",
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
      "Store a lasting preference. Use when the user likes, dislikes, or constrains something. During onboarding call it once per music style, vibe, or usual spot they mention (kind like, short label such as house, rooftop day parties, club space).",
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

/** "Fri 10pm", in the time zone the supported cities share (Miami and NYC). */
function friendlyWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const minute = get("minute") === "00" ? "" : `:${get("minute")}`;
  const time = `${get("hour")}${minute}${get("dayPeriod").toLowerCase()}`;
  // Past a week out a bare weekday is ambiguous, so say which one.
  if (date.getTime() - Date.now() > 6 * 24 * 60 * 60 * 1000) {
    const day = date.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
    return `${get("weekday")} ${day} ${time}`;
  }
  return `${get("weekday")} ${time}`;
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

function isTasteKind(value: unknown): value is TasteKind {
  return value === "like" || value === "dislike" || value === "constraint";
}

/** Per-reply state. Each reply gets its own, so one user's search never leaks into another's. */
export type ToolSession = {
  searched: EventRow[];
  webSearches: number;
  /** Links web_search returned, the only page links a reply may pass on. */
  webUrls: Set<string>;
  /** Urls from the user's saves: exact matches only, not whole hosts. */
  savedUrls: Set<string>;
  /** The user's own text this reply (chat plus current message), the only other source of links. */
  userText: string;
  /** Bare links (like "lofi.fm") from stored taste and saves, the user's own data. */
  storedText: string;
  /** Untrusted content (search results, scraped listings) was seen this reply, so links get filtered. Images set it too. */
  untrusted: boolean;
};

/** Each web search costs a tool round, so cap them to leave room for an answer. */
const MAX_WEB_SEARCHES = 3;

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
      const results = await searchWeb(query);
      for (const result of results) session.webUrls.add(result.url);
      // Page text is labeled as data so instructions planted in it aren't mistaken for the user's.
      return { count: results.length, untrusted_web_content: results };
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
      const events = await searchEvents({
        city,
        query: asString(input.query),
        tags: asStringArray(input.tags),
        from: asString(input.from),
        to: asString(input.to),
        taste,
      });
      session.searched = events;
      return {
        count: events.length,
        events: events.map((event) => ({
          id: event.id,
          title: event.title,
          when: friendlyWhen(event.starts_at),
          venue: event.venue,
          music: event.music,
          crowd: event.crowd,
          price_note: event.price_note,
        })),
      };
    }
    case "remember_taste": {
      if (!isTasteKind(input.kind) || !asString(input.label)) {
        return { error: "kind and label are required" };
      }
      if (session.untrusted && hasLink(asString(input.label)!)) {
        return { error: "link_in_label", hint: "Labels are short taste words, not links." };
      }
      const signal = await rememberTaste({
        profileId: profile.id,
        kind: input.kind,
        label: asString(input.label)!,
        weight: asNumber(input.weight),
      });
      return { saved: signal };
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
