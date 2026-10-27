import { getSupabase } from "./client.ts";

export type RsvpStatus = "running" | "needs_input" | "done" | "needs_user" | "failed";
/** What a run can ask them for. Haps writes the question for each, so nothing from the page reaches them. */
export const RSVP_ASKS = ["code", "full_name", "email", "phone", "address", "date_of_birth", "other"] as const;
export type RsvpAsk = (typeof RSVP_ASKS)[number];
/** The answer stored when they say to skip the question. */
export const RSVP_SKIP = "(skip)";
export const RSVP_REASONS = ["payment", "sold_out", "closed", "needs_more_info", "captcha", "blocked", "error"] as const;
export type RsvpReason = (typeof RSVP_REASONS)[number];

export type RsvpRow = {
  id: string;
  profile_id: string;
  save_id: string;
  url: string;
  platform: string;
  space_id: string;
  status: RsvpStatus;
  reason: RsvpReason | null;
  asking: RsvpAsk | null;
  answer: string | null;
  heartbeat_at: string;
  created_at: string;
  finished_at: string | null;
};

/** Postgres's unique violation: this event already has a run going. */
const ALREADY_RUNNING = "23505";

/** A new run for this save, or null when one is already going. */
export async function startRsvp(input: {
  profileId: string;
  saveId: string;
  url: string;
  platform: string;
  spaceId: string;
}): Promise<RsvpRow | null> {
  const { data, error } = await getSupabase()
    .from("rsvps")
    .insert({ profile_id: input.profileId, save_id: input.saveId, url: input.url, platform: input.platform, space_id: input.spaceId })
    .select("*")
    .single();
  if (error?.code === ALREADY_RUNNING) return null;
  if (error) throw error;
  return data as RsvpRow;
}

export async function heartbeat(id: string): Promise<void> {
  const { error } = await getSupabase().from("rsvps").update({ heartbeat_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

/** Moves a run along. A finished one is only finished once, so a late step can't overwrite the sweeper's call. */
export async function setRsvpStatus(id: string, status: RsvpStatus, reason: RsvpReason | null = null): Promise<boolean> {
  const done = status === "done" || status === "needs_user" || status === "failed";
  const { data, error } = await getSupabase()
    .from("rsvps")
    .update({ status, reason, heartbeat_at: new Date().toISOString(), ...(done ? { finished_at: new Date().toISOString(), asking: null, answer: null } : {}) })
    .eq("id", id)
    .in("status", ["running", "needs_input"])
    .select("id");
  if (error) throw error;
  return Boolean(data?.length);
}

/** The run waiting on an answer from this person, if any. */
export async function waitingForAnswer(profileId: string): Promise<RsvpRow | null> {
  const { data, error } = await getSupabase()
    .from("rsvps")
    .select("*")
    .eq("profile_id", profileId)
    .eq("status", "needs_input")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0] as RsvpRow | undefined) ?? null;
}

/** Waits on them for one thing. */
export async function askFor(id: string, asking: RsvpAsk): Promise<void> {
  const { error } = await getSupabase()
    .from("rsvps")
    .update({ status: "needs_input", asking, answer: null, heartbeat_at: new Date().toISOString() })
    .eq("id", id)
    .in("status", ["running", "needs_input"]);
  if (error) throw error;
}

export async function putAnswer(id: string, answer: string): Promise<void> {
  const { error } = await getSupabase().from("rsvps").update({ answer }).eq("id", id).eq("status", "needs_input");
  if (error) throw error;
}

/** What they sent, cleared as it's read so it's used once and doesn't sit in the table. */
export async function takeAnswer(id: string): Promise<string | null> {
  const { data, error } = await getSupabase().from("rsvps").select("answer").eq("id", id).single();
  if (error) throw error;
  const answer = (data as { answer: string | null }).answer;
  if (!answer) return null;
  const { error: clearError } = await getSupabase()
    .from("rsvps")
    .update({ answer: null, asking: null, status: "running" })
    .eq("id", id)
    .eq("status", "needs_input");
  if (clearError) throw clearError;
  return answer;
}

/** Runs whose worker stopped bumping them, so the sweeper can close them out. */
export async function staleRsvps(olderThanMs: number): Promise<RsvpRow[]> {
  const { data, error } = await getSupabase()
    .from("rsvps")
    .select("*, profiles(*), saves(*)")
    .in("status", ["running", "needs_input"])
    .lt("heartbeat_at", new Date(Date.now() - olderThanMs).toISOString())
    .limit(20);
  if (error) throw error;
  return (data ?? []) as RsvpRow[];
}
