import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";

// keyterm nudges Deepgram toward hearing the name "Haps".
const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&keyterm=Haps";

const FFMPEG_TIMEOUT_MS = 10_000;

type DeepgramResponse = {
  results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
};

/**
 * iPhone voice notes are CAF, which Deepgram rejects. Re-encode to Ogg Opus (well
 * under a second for a voice note). CAF needs seeking, so it goes through a temp
 * file rather than a pipe.
 */
async function cafToOgg(audio: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "haps-voice-"));
  const input = join(dir, "note.caf");
  try {
    await writeFile(input, audio);
    return await runFfmpeg(["-i", input, "-vn", "-ac", "1", "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", "pipe:1"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runFfmpeg(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg binary missing"));
    const ffmpeg = spawn(ffmpegPath, args);
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => ffmpeg.kill("SIGKILL"), FFMPEG_TIMEOUT_MS);
    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGKILL") reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms`));
      else if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
    });
  });
}

/** Turns a voice note into text. Returns "" when nothing was said. */
export async function transcribe(audio: Buffer, mimeType: string): Promise<string> {
  const token = process.env.DEEPGRAM_API_KEY;
  if (!token) throw new Error("DEEPGRAM_API_KEY missing");

  const isCaf = /caf/i.test(mimeType);
  const response = await fetch(DEEPGRAM_URL, {
    method: "POST",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": isCaf ? "audio/ogg" : mimeType,
    },
    body: new Uint8Array(isCaf ? await cafToOgg(audio) : audio),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`deepgram ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as DeepgramResponse;
  return payload.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
}
