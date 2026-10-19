import { getSupabase } from "../db/client.ts";

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

/** Conversation memory lives in Supabase, so deploys and restarts keep every thread. */
const MAX_TURNS = 20;

export async function getHistory(profileId: string): Promise<ChatTurn[]> {
  const { data, error } = await getSupabase()
    .from("chat_turns")
    .select("role, content")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: false })
    .limit(MAX_TURNS);

  if (error) throw error;
  const turns = ((data ?? []) as ChatTurn[]).reverse();
  // Claude wants the thread to open on a user turn.
  while (turns[0]?.role === "assistant") turns.shift();
  return turns;
}

/** Writes both sides of an exchange together, user turn first, so history never ends mid-pair. */
export async function appendExchange(profileId: string, user: string, assistant: string): Promise<void> {
  const now = Date.now();
  const { error } = await getSupabase()
    .from("chat_turns")
    .insert([
      { profile_id: profileId, role: "user", content: user, created_at: new Date(now).toISOString() },
      { profile_id: profileId, role: "assistant", content: assistant, created_at: new Date(now + 1).toISOString() },
    ]);

  if (error) throw error;
}

/** How many messages this profile has sent since `since`. Backs the per-number rate limit. */
export async function countUserTurnsSince(profileId: string, since: Date): Promise<number> {
  const { count, error } = await getSupabase()
    .from("chat_turns")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", profileId)
    .eq("role", "user")
    .gte("created_at", since.toISOString());

  if (error) throw error;
  return count ?? 0;
}
