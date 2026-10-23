// Bare domains (no scheme, no www) are caught only on these endings, so "u.s.", "node.js" and "lol.jk" pass.
const TLDS =
  "com|net|org|io|co|app|ly|me|gg|xyz|link|site|info|biz|us|tv|to|ai|so|page|events|club" +
  "|(?:co\\.|com\\.)?(?:uk|ca|de|fr|es|it|nl|au|br|mx|jp)" +
  "|live|fm|nyc|la|shop|store|tickets|party|bar|art|studio|world|fun|space|online|tech";

// Any other 2-24 letter ending counts too (evil.top, evil.vip), as long as the name before it
// has 3+ letters and the ending isn't code or a file type, so "st.louis", "dr.dre" and "node.js" pass.
const NOT_TLD = "js|jk|ts|py|md|txt|png|jpg|jpeg|gif|pdf|html|css|json|heic|mov|mp4|mp3";

export const LINK = new RegExp(
  `\\bhttps?://[^\\s<>"]+|\\bwww\\.[^\\s<>"]+|` +
    `(?<![\\w@./-])(?:(?:[a-z0-9-]+\\.)+(?:${TLDS})|(?:[a-z0-9-]+\\.)*[a-z0-9-]{3,}\\.(?:co\\.|com\\.)?(?!(?:${NOT_TLD})\\b)[a-z]{2,24})` +
    `(?![\\w-]|\\.\\w)(?:/[^\\s<>"]*)?`,
  "gi",
);

/** A scheme, www. or path link, as opposed to a bare name like "lofi.fm". */
function isFullLink(link: string): boolean {
  return /^(https?:|www\.)/i.test(link) || link.includes("/");
}

/** Whether `text` has a link; with `fullOnly`, bare names like "lofi.fm" don't count. */
export function hasLink(text: string, fullOnly = false): boolean {
  return (text.match(LINK) ?? []).some((link) => !fullOnly || isFullLink(link));
}

export function bareLinks(text: string): string[] {
  return (text.match(LINK) ?? []).filter((link) => !isFullLink(link));
}

const TRAILING = /[).,!?;:'"]+$/;

export function normalizeLink(link: string): string {
  return link.replace(TRAILING, "").replace(/\/+$/, "").replace(/^https?:\/\//i, "").toLowerCase();
}

function parseLink(link: string): URL | undefined {
  const clean = link.replace(TRAILING, "");
  try {
    return new URL(/^https?:\/\//i.test(clean) ? clean : `https://${clean}`);
  } catch {
    return undefined;
  }
}

/** Lowercased host without a leading "www.", or undefined if the link doesn't parse. */
function linkHost(link: string): string | undefined {
  return parseLink(link)?.hostname.toLowerCase().replace(/^www\./, "");
}

/** Just the site's front door: no path, query, hash, port, or login. */
function isHomepage(link: string): boolean {
  const url = parseLink(link);
  return !!url && url.pathname === "/" && !url.search && !url.hash && !url.port && !url.username && !url.password;
}

/** Whether `link` is exactly one of `urls` (ignoring scheme, case and a trailing slash). */
export function isExactLink(link: string, urls: Iterable<string>): boolean {
  const key = normalizeLink(link);
  for (const url of urls) if (normalizeLink(url) === key) return true;
  return false;
}

/**
 * A planted page can tell Claude to send the user a link. Links only go out when they
 * came back from a search, were already in the chat, or were saved, so a page can't add
 * its own. Claude often shortens a result to its homepage, so a bare homepage on a
 * search result's host also passes. Any other path needs an exact match, since a host
 * like instagram.com or bit.ly hosts anyone's page.
 */
export function stripUnknownLinks(text: string, searched: Set<string>, saved: Set<string>, known: string): string {
  const exact = new Set([...searched, ...saved, ...(known.match(LINK) ?? [])].map(normalizeLink));
  const hosts = new Set([...searched].map(linkHost).filter((host): host is string => !!host));
  return text
    .replace(LINK, (link) => {
      const host = linkHost(link);
      if (exact.has(normalizeLink(link)) || (host && hosts.has(host) && isHomepage(link))) return link;
      console.warn(`[links] dropped link not from search results: ${link}`);
      return "";
    })
    .replace(/[ \t]{2,}/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
}
