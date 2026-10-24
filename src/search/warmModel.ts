import { embedQuery } from "./embed.ts";

/**
 * Downloads the embedding model into node_modules during the Render build, so a deploy ships
 * with it and the first search never waits on a 200 MB download.
 * Usage: npm run warm-model
 */
await embedQuery("warm up");
console.log("[embed] model cached");
