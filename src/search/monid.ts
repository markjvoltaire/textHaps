const MONID_URL = "https://api.monid.ai/v1";

export type TikTokVideo = {
  url: string;
  author: string;
  posted: string;
  caption: string;
  likes: number;
  comments: number;
  views: number;
};

export type TikTokProfile = {
  handle: string;
  bio: string;
  followers: number;
  likes: number;
  videos: number;
  since: string;
  link: string | null;
};

export type TikTokComment = {
  text: string;
  likes: number;
};

type MonidRun = {
  runId: string;
  status: string;
  providerResponse?: { httpStatus?: number; error?: unknown };
  output?: { data?: unknown } | null;
};

type RawVideo = {
  url?: string;
  author?: string;
  createdUtc?: number;
  caption?: string | null;
  likes?: number;
  comments?: number;
  views?: number;
};

type RawProfile = {
  handle?: string;
  bio?: string | null;
  followers?: number;
  likes?: number;
  videos?: number;
  createdUtc?: number;
  externalUrl?: string | null;
};

// Flyers go up a few weeks ahead, so a month back still catches this weekend's nights.
const DATE_POSTED_DAYS = 30;
const MAX_CAPTION = 500;
const MAX_VIDEOS = 8;

/** Recent TikTok videos matching the query (flyers, promo clips), most relevant first. */
export async function searchTikTokVideos(
  query: string,
  deadlineMs = 8000,
  options: { days?: number; limit?: number } = {},
): Promise<TikTokVideo[]> {
  // bison is the cheapest route and the fastest one that stays up (~1.4s median).
  const data = await runMonid<{ videos?: RawVideo[] }>(
    "/tiktok.search_keyword",
    { query, datePosted: options.days ?? DATE_POSTED_DAYS, sortBy: "relevance", route: "bison" },
    deadlineMs,
  );
  return (data?.videos ?? [])
    .flatMap((video) => {
      const caption = video.caption?.trim() ?? "";
      // A clip with no caption has nothing to read the date or place from.
      if (!video.url || !caption) return [];
      return [
        {
          url: video.url,
          author: video.author ?? "",
          posted: new Date((video.createdUtc ?? 0) * 1000).toISOString(),
          caption: caption.length > MAX_CAPTION ? `${caption.slice(0, MAX_CAPTION)}…` : caption,
          likes: video.likes ?? 0,
          comments: video.comments ?? 0,
          views: video.views ?? 0,
        },
      ];
    })
    .slice(0, options.limit ?? MAX_VIDEOS);
}

export type InstagramPost = {
  url: string;
  author: string;
  posted: string;
  caption: string;
  likes: number;
  comments: number;
  location: string | null;
};

type RawInstagramPost = {
  url?: string;
  username?: string;
  createdUtc?: number;
  caption?: string | null;
  likes?: number;
  comments?: number;
  locationName?: string | null;
  isAd?: boolean;
};

/**
 * Instagram posts under a hashtag from the last month. Keyword search came back empty, and the live hashtag feed was
 * mostly ads, so this reads the indexed search, which can filter by date. Good for places (#miamibars), thin for niche nights.
 */
export async function searchInstagramHashtag(hashtag: string, deadlineMs = 20000): Promise<InstagramPost[]> {
  const data = await runMonid<{ posts?: RawInstagramPost[] }>(
    "/instagram.search_hashtag",
    { hashtag, datePosted: "last-month" },
    deadlineMs,
  );
  return (data?.posts ?? []).flatMap((post) => {
    const caption = post.caption?.trim() ?? "";
    if (!post.url || !caption || post.isAd) return [];
    return [
      {
        url: post.url,
        author: post.username ?? "",
        posted: new Date((post.createdUtc ?? 0) * 1000).toISOString(),
        caption: caption.length > MAX_CAPTION ? `${caption.slice(0, MAX_CAPTION)}…` : caption,
        likes: post.likes ?? 0,
        comments: post.comments ?? 0,
        location: post.locationName ?? null,
      },
    ];
  });
}

export type InstagramPostPage = {
  author: string;
  /** The account's display name, often the party's own name. */
  name: string;
  posted: string;
  caption: string;
  location: string | null;
};

/** An Instagram post or reel link, the kind instagram.post can read. Profile links name no post. */
export const INSTAGRAM_POST = /^https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?(?:[?#].*)?$/i;

/** One Instagram post by its link, or null when it has no caption to read. Instagram walls off the page itself. */
export async function instagramPost(url: string, deadlineMs = 8000): Promise<InstagramPostPage | null> {
  // chameleon is the fastest route that stays up (~1.3s median).
  const data = await runMonid<RawInstagramPost & { owner?: string; displayName?: string | null }>("/instagram.post", { url, route: "chameleon" }, deadlineMs);
  const caption = data?.caption?.trim() ?? "";
  if (!caption) return null;
  return {
    author: data?.owner ?? "",
    name: data?.displayName?.trim() ?? "",
    posted: new Date((data?.createdUtc ?? 0) * 1000).toISOString().slice(0, 10),
    caption,
    location: data?.locationName ?? null,
  };
}

/** A TikTok account's public profile, or null when the handle doesn't exist. */
export async function tiktokProfile(handle: string, deadlineMs = 8000): Promise<TikTokProfile | null> {
  const data = await runMonid<RawProfile>("/tiktok.profile", { handle, route: "bison" }, deadlineMs);
  if (!data?.handle) return null;
  return {
    handle: data.handle,
    bio: data.bio?.trim() ?? "",
    followers: data.followers ?? 0,
    likes: data.likes ?? 0,
    videos: data.videos ?? 0,
    since: new Date((data.createdUtc ?? 0) * 1000).toISOString().slice(0, 10),
    link: data.externalUrl ?? null,
  };
}

/** The first page of comments on a TikTok video. */
export async function tiktokComments(url: string, deadlineMs = 8000): Promise<TikTokComment[]> {
  const data = await runMonid<{ comments?: { text?: string; likes?: number }[] }>(
    "/tiktok.video_comments",
    { url, route: "bison" },
    deadlineMs,
  );
  return (data?.comments ?? [])
    .map((comment) => ({ text: comment.text?.trim() ?? "", likes: comment.likes ?? 0 }))
    .filter((comment) => comment.text);
}

/** Run an AnyAPI endpoint through Monid and return its data, polling if the run goes async. */
async function runMonid<T>(endpoint: string, body: Record<string, unknown>, deadlineMs: number): Promise<T | undefined> {
  const token = process.env.MONID_API_KEY;
  if (!token) throw new Error("MONID_API_KEY missing");

  const deadline = Date.now() + deadlineMs;
  let run = await monid<MonidRun>(token, "/run", deadline, { provider: "anyapi", endpoint, input: { body } });
  // Async providers answer 202 and finish in the background, so poll until done or out of time.
  while (run.status === "READY" || run.status === "RUNNING") {
    await new Promise((resolve) => setTimeout(resolve, 700));
    run = await monid<MonidRun>(token, `/runs/${run.runId}`, deadline);
  }
  const httpStatus = run.providerResponse?.httpStatus ?? 0;
  if (run.status !== "COMPLETED" || httpStatus < 200 || httpStatus >= 300) {
    throw new Error(`monid ${endpoint} ${run.status} ${httpStatus}`);
  }
  return run.output?.data as T | undefined;
}

async function monid<T>(token: string, path: string, deadline: number, body?: unknown): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("monid timeout");
  const response = await fetch(`${MONID_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    // The user is already waiting on the typing dots, so give up rather than hang.
    signal: AbortSignal.timeout(remaining),
  });
  if (!response.ok) {
    throw new Error(`monid ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}
