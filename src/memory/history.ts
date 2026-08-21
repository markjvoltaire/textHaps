export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

/** Conversation memory lives in process only — restarting the agent clears every thread. */
const histories = new Map<string, ChatTurn[]>();

const MAX_TURNS = 20;

export function getHistory(senderId: string): ChatTurn[] {
  return histories.get(senderId) ?? [];
}

export function appendTurn(senderId: string, turn: ChatTurn): void {
  const next = [...getHistory(senderId), turn];
  histories.set(senderId, next.slice(-MAX_TURNS));
}
