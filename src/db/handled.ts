import { getSupabase } from "./client.ts";

/**
 * Claims an inbound message for this worker. False means another worker
 * (e.g. the old one still running during a deploy) already took it.
 */
export async function claimMessage(messageId: string): Promise<boolean> {
  const { error } = await getSupabase().from("handled_messages").insert({ id: messageId });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw error;
}
