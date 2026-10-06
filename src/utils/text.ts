/** Pull plain text out of a Spectrum `Content` value without narrowing on every variant. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractText).join("");
  if (content && typeof content === "object" && "text" in content) {
    return String((content as { text: unknown }).text ?? "");
  }
  return "";
}

/** iMessage renders Markdown literally, so strip emphasis markers the model may emit. */
export function sanitizeOutgoingText(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\*/g, "")
    .replace(/`{1,3}/g, "")
    .replace(/\s*[—–]\s*/g, ". ")
    .replace(/[ \t]+\./g, ".")
    .replace(/\.\s*\./g, ".")
    .trim();
}

export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}") return json;
  } catch {
    // fall through
  }
  return String(err);
}
