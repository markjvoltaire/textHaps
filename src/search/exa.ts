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

/** Ranked web results for places (bars, restaurants). */
export async function searchWeb(query: string): Promise<WebResult[]> {
  return exaSearch({ query, numResults: 5 });
}

// Where nights get listed.
export const EVENT_DOMAINS = ["dice.fm", "partiful.com", "eventbrite.com", "ra.co", "shotgun.live", "lu.ma"];

/** Live event pages from ticketing sites, for search_events. `since` drops pages published before it (old nights). */
export async function searchEventPages(query: string, since?: Date): Promise<WebResult[]> {
  return exaSearch({
    query,
    numResults: 8,
    includeDomains: EVENT_DOMAINS,
    ...(since && { startPublishedDate: since.toISOString() }),
  });
}

/** Ranked pages with their text, for reading editorial lists ("best bars in Miami") in full. */
export async function searchPagesWithText(query: string, numResults = 10, maxCharacters = 6000): Promise<PageContent[]> {
  const token = process.env.EXA_API_KEY;
  if (!token) throw new Error("EXA_API_KEY missing");

  const response = await fetch(EXA_URL, {
    method: "POST",
    headers: {
      "x-api-key": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, numResults, userLocation: "US", contents: { text: { maxCharacters } } }),
    // Offline drafting, not a waiting user, so full text is worth the wait.
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`exa ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as ExaContentsResponse;
  return (payload.results ?? [])
    .filter((result) => typeof result.url === "string" && typeof result.text === "string" && result.text.trim())
    .map((result) => ({ url: result.url!, title: result.title ?? "", text: result.text!.trim() }));
}

async function exaSearch(options: {
  query: string;
  numResults: number;
  includeDomains?: string[];
  startPublishedDate?: string;
}): Promise<WebResult[]> {
  const token = process.env.EXA_API_KEY;
  if (!token) throw new Error("EXA_API_KEY missing");

  const response = await fetch(EXA_URL, {
    method: "POST",
    headers: {
      "x-api-key": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...options,
      // lite is Exa's fastest mode (~450ms); highlights are the parts of each page that match the query.
      type: "lite",
      userLocation: "US",
      contents: { highlights: true },
    }),
    // The user is already waiting on the typing dots, so give up rather than hang.
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

export type PageImages = {
  url: string;
  /** The page's share image (og:image), then other images on it. */
  images: string[];
};

/** Pages about the query with the images on each, for finding a rec's picture. Offline, so no rush. */
export async function searchPageImages(query: string, includeDomains?: string[]): Promise<PageImages[]> {
  const token = process.env.EXA_API_KEY;
  if (!token) throw new Error("EXA_API_KEY missing");

  const request = () =>
    fetch(EXA_URL, {
      method: "POST",
      headers: {
        "x-api-key": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        numResults: 6,
        userLocation: "US",
        ...(includeDomains ? { includeDomains } : {}),
        contents: { extras: { imageLinks: 4 } },
      }),
      signal: AbortSignal.timeout(30000),
    });
  let response = await request();
  // A backfill runs several recs at once and can go over Exa's 10 requests a second.
  for (let attempt = 1; response.status === 429 && attempt <= 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    response = await request();
  }
  if (!response.ok) {
    throw new Error(`exa ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as { results?: { url: string; image?: string; extras?: { imageLinks?: string[] } }[] };
  return (payload.results ?? []).map((result) => ({
    url: result.url,
    images: [result.image, ...(result.extras?.imageLinks ?? [])].filter((image): image is string => !!image && /^https?:\/\//.test(image)),
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
