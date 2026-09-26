// Multiplexed article discovery — Tier A fix for "all websites blocked".
//
// Google News RSS is the only discovery source in V1. That's a single point
// of failure: when a keyword's articles all live on heavily-protected sites
// (Cloudflare, paywalls), the capture pipeline starves. This module widens
// discovery across FIVE independent, keyless, $0 sources:
//
//   1. Google News RSS  (existing, kept for compatibility — redirect URLs)
//   2. Bing News RSS    (direct publisher URLs, XML feed)
//   3. GDELT DOC 2.0    (global news index, JSON API, no key — surfaces
//                        small/regional outlets that rarely run bot walls)
//   4. Wikipedia        (entity keywords — guaranteed unblocked, keyword-rich)
//   5. Hacker News      (Algolia API, tech keywords)
//   6. Reddit           (external link posts only — used purely as discovery
//                        for the linked article, never the thread itself)
//
// Design constraints:
//   - Every source is individually try/catch'd — one dead source never fails
//     discovery. The pipeline's graceful degradation (partial-articles
//     feature) handles whatever survives.
//   - All requests are plain fetch() with short timeouts (10-15s) — no
//     browser needed at discovery time.
//   - Dedupe by normalized URL across all sources.
//   - No source-specific logic leaks into the capture pipeline: candidates
//     are plain URLs; the capture fallback ladder (routes.ts) decides HOW to
//     render each one at capture time.

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 12_000;
// Per-source candidate caps — keep the union manageable (DB + capture time).
const CAP_PER_SOURCE = 20;
const CAP_WIKIPEDIA = 3;

export type DiscoverySource =
  | "bing_news"
  | "gdelt"
  | "wikipedia"
  | "hn"
  | "reddit";

export interface DiscoveredCandidate {
  url: string;
  title: string | null;
  source: DiscoverySource;
  publisherDomain: string | null;
  pubDate: string | null;
}

export interface MultiplexResult {
  candidates: DiscoveredCandidate[]; // deduped, in source priority order
  sourceCounts: Record<string, number>;
  sourceErrors: Partial<Record<DiscoverySource, string>>;
}

/**
 * Run all non-Google-News sources in parallel. Google News RSS keeps its own
 * module (rss.ts) because the search route stores its candidates first.
 * Each source fails independently — errors are collected, never thrown.
 */
export async function discoverFromAllSources(
  keyword: string
): Promise<MultiplexResult> {
  const [bing, gdelt, wikipedia, hn, reddit] = await Promise.allSettled([
    searchBingNewsRss(keyword),
    searchGdelt(keyword),
    searchWikipedia(keyword),
    searchHackerNews(keyword),
    searchRedditLinks(keyword),
  ]);

  const candidates: DiscoveredCandidate[] = [];
  const sourceCounts: Record<string, number> = {};
  const sourceErrors: Partial<Record<DiscoverySource, string>> = {};

  const push = (
    source: DiscoverySource,
    result: PromiseSettledResult<DiscoveredCandidate[]>
  ) => {
    if (result.status === "fulfilled") {
      const list = result.value;
      sourceCounts[source] = list.length;
      candidates.push(...list);
    } else {
      const err = result.reason;
      sourceErrors[source] =
        err instanceof Error ? err.message : String(err ?? "unknown error");
      sourceCounts[source] = 0;
    }
  };

  push("bing_news", bing);
  push("gdelt", gdelt);
  push("wikipedia", wikipedia);
  push("hn", hn);
  push("reddit", reddit);

  // Cross-source dedupe by normalized URL (first occurrence wins — sources
  // are pushed in priority order: bing_news, gdelt, wikipedia, hn, reddit).
  const seen = new Set<string>();
  const deduped: DiscoveredCandidate[] = [];
  for (const c of candidates) {
    const key = normalizeUrl(c.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }

  return { candidates: deduped, sourceCounts, sourceErrors };
}

// ---------------------------------------------------------------------------
// 1. Bing News RSS — direct publisher URLs
// ---------------------------------------------------------------------------

/**
 * Bing News RSS returns <item> entries whose <link> is usually the direct
 * publisher URL. Some items wrap the real URL in an apiclick redirect with a
 * `url=` query parameter — we decode that too.
 */
export async function searchBingNewsRss(
  keyword: string
): Promise<DiscoveredCandidate[]> {
  const url =
    "https://www.bing.com/news/search?q=" +
    encodeURIComponent(keyword) +
    "&format=RSS&setmkt=en-US";

  const xml = await fetchText(url);
  if (!xml.includes("<item")) return [];

  // Minimal regex-based item parsing — avoids pulling the XML parser
  // dependency shape (fast-xml-parser IS available, used by rss.ts; but
  // Bing's feed is flat enough that regex is robust and dependency-free).
  const items = xml.split(/<item>/i).slice(1);
  const out: DiscoveredCandidate[] = [];

  for (const raw of items) {
    if (out.length >= CAP_PER_SOURCE) break;
    const link = extractTag(raw, "link");
    const title = extractTag(raw, "title");
    const pubDate = extractTag(raw, "pubDate");
    if (!link) continue;

    let articleUrl = decodeXmlEntities(link.trim());
    // Unwrap Bing apiclick redirects: ...apiclick.aspx?...&url=<encoded>
    if (/bing\.com\/news\/apiclick\.aspx/i.test(articleUrl)) {
      try {
        const u = new URL(articleUrl);
        const inner = u.searchParams.get("url");
        if (inner && /^https?:\/\//i.test(inner)) articleUrl = inner;
      } catch {
        // keep original
      }
    }
    if (!/^https?:\/\//i.test(articleUrl)) continue;
    if (/bing\.com/i.test(articleUrl)) continue; // skip non-article bing links

    out.push({
      url: articleUrl,
      title: title ? stripCdata(decodeXmlEntities(title.trim())) : null,
      source: "bing_news",
      publisherDomain: domainFromUrlStr(articleUrl),
      pubDate: pubDate ? tryIsoDate(pubDate) : null,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// 2. GDELT DOC 2.0 API — global news index, keyless
// ---------------------------------------------------------------------------

/**
 * GDELT monitors news in 100+ languages. We request an exact-phrase query and
 * keep English-language results only (the highlight pipeline is
 * English-keyword based — a foreign-language article can never match).
 * GDELT surfaces thousands of small outlets that have zero bot protection.
 */
export async function searchGdelt(
  keyword: string
): Promise<DiscoveredCandidate[]> {
  const url =
    "https://api.gdeltproject.org/api/v2/doc/doc?query=" +
    encodeURIComponent(`"${keyword}" sourcelang:english`) +
    "&mode=artlist&maxrecords=40&format=json&sort=hybridrel&timespan=1y";

  const body = await fetchText(url);
  if (!body.trim().startsWith("{")) {
    // GDELT returns plain-text warnings for rate limits / empty sets.
    return [];
  }

  let parsed: {
    articles?: Array<{
      url?: string;
      title?: string;
      domain?: string;
      seendate?: string;
      language?: string;
    }>;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }

  const out: DiscoveredCandidate[] = [];
  for (const a of parsed.articles ?? []) {
    if (out.length >= CAP_PER_SOURCE) break;
    if (!a.url || !/^https?:\/\//i.test(a.url)) continue;
    if (a.language && !/english|eng/i.test(a.language)) continue;
    out.push({
      url: a.url,
      title: a.title?.trim() ?? null,
      source: "gdelt",
      publisherDomain: a.domain ?? domainFromUrlStr(a.url),
      pubDate: parseGdeltDate(a.seendate),
    });
  }
  return out;
}

function parseGdeltDate(s?: string): string | null {
  if (!s) return null;
  // Format: 20260914T083000Z
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(
    Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  );
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------------------
// 3. Wikipedia — guaranteed-unblocked fallback for entity keywords
// ---------------------------------------------------------------------------

/**
 * For entity keywords ("Blue Origin", "Elon Musk") the Wikipedia article
 * contains the keyword dozens of times and NEVER blocks. Added as capture
 * candidates directly (the capture ladder renders them via the direct route).
 */
export async function searchWikipedia(
  keyword: string
): Promise<DiscoveredCandidate[]> {
  const url =
    "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=" +
    encodeURIComponent(keyword) +
    "&format=json&srlimit=" +
    CAP_WIKIPEDIA;

  const body = await fetchText(url);
  let parsed: {
    query?: { search?: Array<{ title?: string; timestamp?: string }> };
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }

  const out: DiscoveredCandidate[] = [];
  for (const hit of parsed.query?.search ?? []) {
    if (!hit.title) continue;
    out.push({
      url:
        "https://en.wikipedia.org/wiki/" +
        encodeURIComponent(hit.title.replace(/ /g, "_")),
      title: hit.title,
      source: "wikipedia",
      publisherDomain: "en.wikipedia.org",
      pubDate: hit.timestamp ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Hacker News (Algolia) — tech-adjacent keywords
// ---------------------------------------------------------------------------

export async function searchHackerNews(
  keyword: string
): Promise<DiscoveredCandidate[]> {
  const url =
    "https://hn.algolia.com/api/v1/search?query=" +
    encodeURIComponent(keyword) +
    "&tags=story&hitsPerPage=15";

  const body = await fetchText(url);
  let parsed: {
    hits?: Array<{ url?: string | null; title?: string | null }>;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }

  const out: DiscoveredCandidate[] = [];
  for (const hit of parsed.hits ?? []) {
    if (out.length >= CAP_PER_SOURCE) break;
    // Only external article links — HN item URLs (news.ycombinator.com/item)
    // are discussion threads, not articles.
    if (!hit.url || !/^https?:\/\//i.test(hit.url)) continue;
    if (/news\.ycombinator\.com/i.test(hit.url)) continue;
    out.push({
      url: hit.url,
      title: hit.title ?? null,
      source: "hn",
      publisherDomain: domainFromUrlStr(hit.url),
      pubDate: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. Reddit — external link posts only
// ---------------------------------------------------------------------------

/**
 * Reddit itself is never captured; only the EXTERNAL article a post links to
 * is used as a candidate. Self-posts and text threads are ignored.
 */
export async function searchRedditLinks(
  keyword: string
): Promise<DiscoveredCandidate[]> {
  const url =
    "https://www.reddit.com/search.json?q=" +
    encodeURIComponent(keyword) +
    "&limit=25&sort=relevance&t=year";

  const body = await fetchText(url, {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  });
  let parsed: {
    data?: {
      children?: Array<{
        data?: {
          url?: string;
          url_overridden_by_dest?: string;
          title?: string;
          created_utc?: number;
          domain?: string;
          is_self?: boolean;
          post_hint?: string;
        };
      }>;
    };
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }

  const out: DiscoveredCandidate[] = [];
  for (const child of parsed.data?.children ?? []) {
    if (out.length >= CAP_PER_SOURCE) break;
    const d = child.data;
    if (!d || d.is_self) continue;
    const target = d.url_overridden_by_dest || d.url;
    if (!target || !/^https?:\/\//i.test(target)) continue;
    if (/reddit\.com|redd\.it/i.test(target)) continue; // skip internal links
    out.push({
      url: target,
      title: d.title ?? null,
      source: "reddit",
      publisherDomain: d.domain ?? domainFromUrlStr(target),
      pubDate:
        typeof d.created_utc === "number"
          ? new Date(d.created_utc * 1000).toISOString()
          : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function fetchText(
  url: string,
  headers: Record<string, string> = {}
): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      ...headers,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
}

/** Normalize a candidate URL for dedupe: strip hash, trailing slash, utm params. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const p of Array.from(u.searchParams.keys())) {
      if (/^utm_/i.test(p) || p === "fbclid" || p === "gclid") {
        u.searchParams.delete(p);
      }
    }
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/** Extract hostname without www. — null on parse failure. */
export function domainFromUrlStr(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./i, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

function extractTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(block);
  return m ? m[1] : null;
}

function stripCdata(s: string): string {
  return s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function tryIsoDate(s: string): string | null {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
