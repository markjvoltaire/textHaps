const EXA_URL = "https://api.exa.ai/search";
const EXA_CONTENTS_URL = "https://api.exa.ai/contents";

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

export type PageContent = {
  url: string;
  title: string;
  text: string;
};

type ExaContentsResponse = {
  results?: { url?: string; title?: string | null; text?: string | null }[];
  // Per-url outcome. A page Exa couldn't crawl can come back as a 200 with an error status here.
  statuses?: { id?: string; status?: string }[];
};

/** Page text for links the user sent (event pages). Pages Exa couldn't read are left out. */
export async function fetchPages(urls: string[], maxCharacters = 6000): Promise<PageContent[]> {
  const token = process.env.EXA_API_KEY;
  if (!token) throw new Error("EXA_API_KEY missing");

  const response = await fetch(EXA_CONTENTS_URL, {
    method: "POST",
    headers: {
      "x-api-key": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ urls, text: { maxCharacters } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(`exa ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as ExaContentsResponse;
  const failed = new Set((payload.statuses ?? []).filter((item) => item.status === "error").map((item) => item.id));
  return (payload.results ?? [])
    .filter((result) => typeof result.url === "string" && !failed.has(result.url))
    .map((result) => ({
      url: result.url!,
      title: typeof result.title === "string" ? result.title : "",
      text: typeof result.text === "string" ? result.text.trim() : "",
    }));
}
