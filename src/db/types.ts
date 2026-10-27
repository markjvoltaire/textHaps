export type TasteKind = "like" | "dislike" | "constraint";
/** Said outright, read between the lines, or shown by what they did (saved, passed on). */
export type TasteSource = "explicit" | "inferred" | "behavior";
export const TASTE_CATEGORIES = ["activity", "music", "food", "scene", "vibe", "social", "timing", "place", "goal", "other"] as const;
export type TasteCategory = (typeof TASTE_CATEGORIES)[number];

export type OnboardingField = "found_us" | "taste" | "city";

export type Profile = {
  id: string;
  platform: string;
  platform_user_id: string;
  name: string | null;
  date_of_birth: string | null;
  city: string | null;
  /** The part of town they live in or usually head out from, e.g. "north miami". */
  area: string | null;
  /** How they found out about Haps, in their words, e.g. "my friend jay" or "tiktok". */
  found_us: string | null;
  /** Neighborhoods they like going out in, in their words. */
  neighborhoods: string | null;
  /** How far they'll go, e.g. "stays close" or "will travel for something worth it". */
  travel: string | null;
  /** A normal night out, e.g. "$40-80 per person, more for something special". */
  budget: string | null;
  /** When they go out and how they plan, e.g. "fridays late, decides day of". */
  going_out: string | null;
  /** Who they usually go out with, e.g. "the crew, sometimes date nights". */
  social: string | null;
  /** What they want Haps to make better, e.g. "hidden gems". */
  discovery_goal: string | null;
  /** Their taste as one vector, as pgvector text ("[0.1,...]"); null until they've shared a taste. */
  taste_embedding: string | null;
  email: string | null;
  /** First and last name for RSVPs; name stays what they go by. */
  full_name: string | null;
  background_set_at: string | null;
  contact_card_sent_at: string | null;
  created_at: string;
};

export type TasteSignal = {
  id: string;
  profile_id: string;
  kind: TasteKind;
  label: string;
  weight: number;
  source: TasteSource;
  category: TasteCategory | null;
  /** How sure Haps is, 0-1. Said outright is 1; a guess from one thing they said is lower. */
  confidence: number;
  /** What it's based on, for inferred and behavior signals. */
  evidence: string | null;
  created_at: string;
};

export type SaveRow = {
  id: string;
  profile_id: string;
  url: string | null;
  title: string | null;
  note: string | null;
  /** When it starts, once the time is known. */
  starts_at: string | null;
  /** The day in the venue's time zone, known even when the start time isn't. */
  event_date: string | null;
  venue: string | null;
  /** They said yes to Haps texting them before it. */
  remind: boolean;
  created_at: string;
  /** Haps's RSVP runs for it, newest first, when the query asked for them. */
  rsvps?: { status: string; created_at: string }[];
};
