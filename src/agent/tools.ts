import type Anthropic from "@anthropic-ai/sdk";
import { searchEvents } from "../db/events.ts";
import { applyProfileUpdate, updateProfile } from "../db/profiles.ts";
import { listSaves, saveEvent } from "../db/saves.ts";
import { listTaste, rememberTaste } from "../db/taste.ts";
import type { EventRow, Profile, TasteKind } from "../db/types.ts";

export const HAPS_TOOLS: Anthropic.Tool[] = [
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
};

export async function runTool(
  profile: Profile,
  name: string,
  input: ToolInput,
  session: ToolSession,
): Promise<unknown> {
  switch (name) {
    case "search_events": {
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
      const signal = await rememberTaste({
        profileId: profile.id,
        kind: input.kind,
        label: asString(input.label)!,
        weight: asNumber(input.weight),
      });
      return { saved: signal };
    }
    case "save_event": {
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
