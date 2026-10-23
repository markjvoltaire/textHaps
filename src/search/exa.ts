const EXA_URL = "https://api.exa.ai/search";

export type WebResult = {
  title: string;
  url: string;
  published: string | null;
  highlights: string[];
};

type ExaResponse = {
  results?: { title?: string; url: string; publishedDate?: string; highlights?: string[] }[];
};

/** Ranked web results for places (bars, restaurants). Parties stay on search_events. */
export async function searchWeb(query: string): Promise<WebResult[]> {
  const token = process.env.EXA_API_KEY;
  if (!token) throw new Error("EXA_API_KEY missing");

  const response = await fetch(EXA_URL, {
    method: "POST",
    headers: {
      "x-api-key": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      // lite is Exa's fastest mode (~450ms); highlights are the parts of each page that match the query.
      type: "lite",
      numResults: 5,
      userLocation: "US",
      contents: { highlights: true },
    }),
    // The user is already waiting after "let me check", so give up rather than hang.
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(`exa ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as ExaResponse;
  return (payload.results ?? []).map((result) => ({
    title: result.title ?? "",
    url: result.url,
    published: result.publishedDate ?? null,
    highlights: result.highlights ?? [],
  }));
}
