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

/** A photo ready for Claude: small ones as they are, big or odd ones shrunk to a JPEG. Null if it can't be opened. */
export async function prepareImage(buf: Buffer, mimeType: string): Promise<ImageInput | null> {
  try {
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
