import sharp from "sharp";

export type ImageInput = {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;
  /** What OCR read off the photo, shown to Claude next to it. */
  ocr?: string;
};

/** The types Claude reads as-is. Anything else (like HEIC) is converted, or refused if sharp can't open it. */
const CLAUDE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
// Claude scales anything bigger down to this anyway, so sending more only costs time and tokens.
const MAX_EDGE = 1568;
// Claude's limit is 5 MB base64; this leaves room for the base64 growth.
const MAX_BYTES = 3_500_000;

const HEIC = /^image\/hei[cf]/i;

// A 48 MP decode holds ~600 MB and blocks the event loop for ~700 ms, so anything past this is refused.
// 25 MP, not 24, so the default iPhone 15-17 photo (5712x4284 = 24.5 MP) still goes through.
const MAX_HEIC_PIXELS = 25_000_000;

const HEIC_TIMEOUT_MS = 10_000;

/** Tail of the HEIC decode queue; each decode waits for the one before it. */
let heicQueue: Promise<unknown> = Promise.resolve();

type HeifHandle = {
  get_width(): number;
  get_height(): number;
  is_primary?(): boolean;
  display(target: { data: Uint8ClampedArray; width: number; height: number }, done: (out: unknown) => void): void;
  free(): void;
};
type HeifDecoder = { decode(buf: Buffer): HeifHandle[] };
// One decoder for the whole process: the queue serializes use, and its decode() frees the previous context.
// heic-decode makes a new one per call and never frees it, which leaked ~19 MB of WASM heap per photo.
let heifDecoder: Promise<HeifDecoder> | undefined;
function getDecoder(): Promise<HeifDecoder> {
  heifDecoder ??= (async () => {
    const libheif = (await import("libheif-js/wasm-bundle")).default;
    await libheif.ready;
    return new libheif.HeifDecoder() as HeifDecoder;
  })();
  // A failed load (say, out of memory compiling the WASM) must not stick: the next photo tries again.
  heifDecoder.catch(() => {
    heifDecoder = undefined;
  });
  return heifDecoder;
}

/**
 * iPhone camera photos are HEIC, and sharp's prebuilt libvips can't decode HEVC. libheif-js is libheif
 * built to WebAssembly, so it runs anywhere; loaded only when one comes in, since a 12 MP decode holds ~400 MB.
 * Decodes run one at a time, and the resize to JPEG happens inside the queue so the raw pixels are gone before
 * the next photo starts. The size is read before any pixels are decoded so a huge photo is refused (null)
 * instead of freezing every other chat. Throws if the file isn't a HEIC libheif can open.
 */
function decodeHeic(buf: Buffer): Promise<Buffer | null> {
  const run = async () => {
    const decoder = await getDecoder();
    const images = decoder.decode(buf);
    try {
      const first = images.find((i) => i.is_primary?.()) ?? images[0];
      if (!first) throw new Error("HEIF image not found");
      const width = first.get_width();
      const height = first.get_height();
      if (width * height > MAX_HEIC_PIXELS) return null;
      const data = new Uint8ClampedArray(width * height * 4);
      // display() runs in a timer callback; if it throws there it never calls back, which would stall the queue.
      let timer: NodeJS.Timeout | undefined;
      const shown = await Promise.race([
        new Promise((resolve) => first.display({ data, width, height }, resolve)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("HEIF decode timed out")), HEIC_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      if (!shown) throw new Error("HEIF processing error");
      return await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } })
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } finally {
      for (const image of images) image.free();
    }
  };
  const result = heicQueue.then(run, run);
  heicQueue = result.catch(() => {});
  return result;
}

/** A photo ready for Claude: small ones as they are, big or odd ones shrunk to a JPEG. Null if it can't be opened. */
export async function prepareImage(buf: Buffer, mimeType: string): Promise<ImageInput | null> {
  try {
    if (HEIC.test(mimeType)) {
      try {
        const out = await decodeHeic(buf);
        if (!out) return null;
        return { mediaType: "image/jpeg", data: out.toString("base64") };
      } catch {
        // Mislabeled (a PNG or JPEG sent as image/heic): let sharp try it below.
      }
    }
    const image = sharp(buf, { animated: false });
    const { width = 0, height = 0 } = await image.metadata();
    if (CLAUDE_TYPES.has(mimeType) && width <= MAX_EDGE && height <= MAX_EDGE && buf.length <= MAX_BYTES) {
      return { mediaType: mimeType as ImageInput["mediaType"], data: buf.toString("base64") };
    }
    const out = await image
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { mediaType: "image/jpeg", data: out.toString("base64") };
  } catch {
    return null;
  }
}
