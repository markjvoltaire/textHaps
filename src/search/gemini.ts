import { startObservation } from "@langfuse/tracing";
import { formatError } from "../utils/text.ts";

const API = "https://generativelanguage.googleapis.com";
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
// A 70s reel took 13s. The person is waiting on the reply, so a stuck call gives up well before they would.
const GENERATE_TIMEOUT_MS = 40_000;
const UPLOAD_TIMEOUT_MS = 30_000;
// Inline media has to fit a 20 MB request once it's base64, which grows it by a third.
const MAX_INLINE_BYTES = 14_000_000;

export type Media = { bytes: Buffer; mimeType: string };

type Part = { text: string } | { inline_data: { mime_type: string; data: string } } | { file_data: { mime_type: string; file_uri: string } };

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY missing");
  return key;
}

/** Big media goes up through the Files API and is used once it's processed. Small media goes inline. */
async function mediaPart(media: Media): Promise<Part> {
  if (media.bytes.length <= MAX_INLINE_BYTES) {
    return { inline_data: { mime_type: media.mimeType, data: media.bytes.toString("base64") } };
  }
  const key = apiKey();
  const signal = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
  const start = await fetch(`${API}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(media.bytes.length),
      "X-Goog-Upload-Header-Content-Type": media.mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "haps-media" } }),
    signal,
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!start.ok || !uploadUrl) throw new Error(`gemini upload start ${start.status}`);
  const uploaded = await fetch(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0" },
    body: media.bytes,
    signal,
  });
  if (!uploaded.ok) throw new Error(`gemini upload ${uploaded.status}`);
  let file = ((await uploaded.json()) as { file?: { name: string; uri: string; state: string } }).file;
  while (file && file.state !== "ACTIVE") {
    if (file.state === "FAILED") throw new Error("gemini file processing failed");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const response = await fetch(`${API}/v1beta/${file.name}`, { headers: { "x-goog-api-key": key }, signal });
    file = (await response.json()) as { name: string; uri: string; state: string };
  }
  if (!file) throw new Error("gemini upload returned no file");
  return { file_data: { mime_type: media.mimeType, file_uri: file.uri } };
}

/**
 * Gemini's JSON answer about a video or a few images (a slideshow), with the prompt after the media
 * as Google recommends. Gemini watches a video at 1 frame a second and hears its audio, which a few
 * frames can't do.
 */
export async function geminiJson(name: string, media: Media[], prompt: string, schema: unknown): Promise<unknown> {
  const generation = startObservation(
    name,
    { model: MODEL, input: { prompt, media: media.map((item) => item.mimeType), bytes: media.reduce((sum, item) => sum + item.bytes.length, 0) } },
    { asType: "generation" },
  );
  try {
    const response = await fetch(`${API}/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey(), "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [...(await Promise.all(media.map(mediaPart))), { text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema },
      }),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });
    const body = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      error?: { message?: string };
    };
    if (!response.ok) throw new Error(`gemini ${response.status}: ${body.error?.message ?? "error"}`);
    const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    generation
      .update({ output: text, usageDetails: { input: body.usageMetadata?.promptTokenCount ?? 0, output: body.usageMetadata?.candidatesTokenCount ?? 0 } })
      .end();
    return JSON.parse(text || "{}");
  } catch (err) {
    generation.update({ level: "ERROR", statusMessage: formatError(err) }).end();
    throw err;
  }
}
