import { setListingOrganize, type ListingRow } from "../db/listings.ts";
import { jevNoulScores } from "../jev/client.ts";
import { pickVibe, VIBE_AXES } from "./vibes.ts";

const CHUNK = 4;

function listingBlurb(listing: ListingRow): string {
  return `Title: ${listing.title}. City: ${listing.city}. Venue: ${listing.venue ?? "unknown"}. When: ${listing.starts_at ?? "unknown"}. ${listing.description.slice(0, 240)}`;
}

export async function scoreListings(listings: ListingRow[]): Promise<void> {
  if (!process.env.JEV_API_KEY && !process.env.TYPESAFE_API_KEY) {
    console.warn("[ingest] JEV_API_KEY missing, skipping organize");
    return;
  }

  for (let i = 0; i < listings.length; i += CHUNK) {
    const chunk = listings.slice(i, i + CHUNK);
    const questions: Record<string, { type: "noul"; instructions: string }> = {};
    for (const listing of chunk) {
      const blurb = listingBlurb(listing);
      questions[listing.id] = {
        type: "noul",
        instructions: `Is this a real upcoming night out (party, club, concert, social) someone should get recommended? Reject movies, ads, party vendors, and vague lifestyle posts. ${blurb}`,
      };
      for (const axis of VIBE_AXES) {
        questions[`${listing.id}::${axis.key}`] = {
          type: "noul",
          instructions: `${axis.instructions} Different rooms play different music and pull different crowds. ${blurb}`,
        };
      }
    }
    try {
      const scores = await jevNoulScores(
        `Organize nightlife listings. Today is ${new Date().toISOString().slice(0, 10)}. Score keep separately from music and crowd. A night can be real and still be the wrong vibe.`,
        questions,
      );
      for (const listing of chunk) {
        const keep = scores[listing.id];
        const axisScores: Record<string, number> = {};
        for (const axis of VIBE_AXES) {
          const score = scores[`${listing.id}::${axis.key}`];
          if (typeof score === "number") axisScores[axis.key] = score;
        }
        const picked = pickVibe(axisScores, listing.tags);
        await setListingOrganize(listing.id, {
          keep_score: typeof keep === "number" ? keep : undefined,
          music: picked.music,
          crowd: picked.crowd,
          tags: picked.tags,
          vibe: picked.vibe,
          vibe_scores: axisScores,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ingest] jev chunk failed: ${msg}`);
    }
  }
}
