import type Anthropic from "@anthropic-ai/sdk";
import { searchEvents } from "../db/events.ts";
import { applyProfileUpdate, isOnboarded, updateProfile } from "../db/profiles.ts";
import { listSaves, saveEvent } from "../db/saves.ts";
import { rememberTaste } from "../db/taste.ts";
import type { Profile, TasteKind } from "../db/types.ts";

export const HAPS_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_events",
    description:
      "Load the current Haps test catalog. Always returns these events. Use this before recommending. Do not invent events. Do not call until onboarding is complete.",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City to search, e.g. NYC" },
        query: { type: "string", description: "Free-text match on title, description, or vibe" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Catalog tags such as run, dj, wine, pottery, literary, film, art",
        },
        from: { type: "string", description: "ISO start of the window. Defaults to now." },
        to: { type: "string", description: "ISO end of the window. Defaults to 21 days out." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "remember_taste",
    description:
      "Store a lasting preference. Use when the user likes, dislikes, or constrains something.",
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
    description: "Save a catalog event or a URL the user sent so Haps can remember it later.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Catalog event UUID from search_events" },
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
      "Save onboarding fields as the user gives them: name and city. Call this whenever they provide either.",
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

export async function runTool(
  profile: Profile,
  name: string,
  input: ToolInput,
): Promise<unknown> {
  switch (name) {
    case "search_events": {
      if (!isOnboarded(profile)) {
        return {
          error: "onboarding_incomplete",
          hint: "Ask for name, then city. Save them with update_profile first.",
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
      });
      return { count: events.length, events };
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
        eventId: asString(input.event_id),
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
      return {
        name: updated.name,
        city: updated.city,
        onboarded: isOnboarded(profile),
      };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}
