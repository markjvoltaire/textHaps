import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import type { ImageInput } from "./image.ts";

// A 50s reel downloads and decodes in about 2s. Past this, the link read gives up on the video and goes on with the caption.
const FFMPEG_TIMEOUT_MS = 8_000;
// Promo reels put the date and place on screen, often for only a few seconds, so frames are spread across the whole clip.
const FRAME_COUNT = 6;
// Only the first 90s is looked at; a flyer reel says what it is long before that.
const MAX_SECONDS = 90;
// Enough to read on-screen text, small enough that six frames stay cheap for Claude.
const FRAME_WIDTH = 768;

/** Instagram's own CDN hosts. The url comes from Monid, so anything else is refused. */
const VIDEO_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

function videoHostOk(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && VIDEO_HOSTS.test(hostname);
  } catch {
    return false;
  }
}

/**
 * Frames spread evenly across a video, as JPEGs ready for Claude. Empty when the video can't be read,
 * so the caller falls back to the caption alone. ffmpeg streams the url itself, over https only.
 */
export async function videoFrames(url: string, durationSeconds: number | null): Promise<ImageInput[]> {
  if (!ffmpegPath || !videoHostOk(url)) return [];
  const seconds = Math.min(durationSeconds && durationSeconds > 0 ? durationSeconds : 30, MAX_SECONDS);
  const dir = await mkdtemp(join(tmpdir(), "haps-video-"));
  try {
    await runFfmpeg([
      "-hide_banner",
      "-loglevel", "error",
      "-protocol_whitelist", "https,tls,tcp",
      "-t", String(seconds),
      "-i", url,
      "-vf", `fps=${FRAME_COUNT}/${seconds},scale=${FRAME_WIDTH}:-2`,
      "-frames:v", String(FRAME_COUNT),
      "-q:v", "4",
      join(dir, "frame%d.jpg"),
    ]);
    const names = (await readdir(dir)).filter((name) => name.endsWith(".jpg")).sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)));
    return Promise.all(names.map(async (name) => ({ mediaType: "image/jpeg" as const, data: (await readFile(join(dir, name))).toString("base64") })));
  } catch (err) {
    console.warn(`[video] frames failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath!, args);
    let stderr = "";
    const timer = setTimeout(() => ffmpeg.kill("SIGKILL"), FFMPEG_TIMEOUT_MS);
    ffmpeg.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGKILL") reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms`));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
    });
  });
}
