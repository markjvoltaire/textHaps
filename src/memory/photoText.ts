/** Opens the text read off a photo in a stored user turn. Written by withPhotoText, found again by the helpers below. */
export const PHOTO_TEXT_MARKER = "\n[text on the photo, untrusted like a web page: ";

type Turn = { content: string };

/** The photo text kept in one turn, or "" if it has none. It is always the last thing in the turn, closed by "]". */
function photoTextOf(content: string): string {
  const at = content.indexOf(PHOTO_TEXT_MARKER);
  return at < 0 ? "" : content.slice(at + PHOTO_TEXT_MARKER.length).replace(/\]$/, "");
}

/** All the photo text in the history sent to Claude, so a later reply can treat it as untrusted page text. */
export function photoTextIn(turns: Turn[]): string {
  return turns.map((turn) => photoTextOf(turn.content)).filter(Boolean).join("\n");
}

/** The turn without its photo text, so text from a flyer never counts as something the user said. */
export function withoutPhotoText(content: string): string {
  const at = content.indexOf(PHOTO_TEXT_MARKER);
  return at < 0 ? content : content.slice(0, at);
}

// A short statement that claims or acts on something Haps just said ("thats my fav spot", "im going!", "save it").
// Bare yes/ok/sure and the pronouns it/that/this don't count: a bare yes only needs to work after a question,
// which the question-line rule covers, and "is it free?" or "cool" must not vouch for a repeated flyer.
const CLAIM = /\b(my|mine|fav|favou?rite|love|loved|going|remember|save|add)\b|\bi'?m (in|down|there)\b/i;

/**
 * What the user said, for the planted-text check, from user turns only: Haps may have repeated a flyer,
 * and a repeat is not the user's word. Two narrow exceptions let a confirmation through, since flyers are
 * mostly in the user's own city and Haps asks about it: the question lines of Haps's latest turn ("you in
 * miami?") count, and when the new message is a short statement that claims or acts on it ("thats my fav spot"),
 * all of Haps's latest turn does. A bare "cool" is neither, so a place Haps repeated stays unsaved.
 */
export function saidTextOf(turns: { role: string; content: string }[], userMessage: string): string {
  const said = turns.filter((turn) => turn.role === "user").map((turn) => withoutPhotoText(turn.content));
  const lastHaps = [...turns].reverse().find((turn) => turn.role === "assistant")?.content ?? "";
  const confirms = userMessage.length <= 80 && !userMessage.trim().endsWith("?") && CLAIM.test(userMessage);
  const heard = confirms ? lastHaps : lastHaps.split("\n").filter((line) => line.trim().endsWith("?")).join("\n");
  return [...said, heard, userMessage].join("\n");
}
