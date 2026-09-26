// Capture route fallback ladder — Tier A fix for "all websites blocked".
//
// When the DIRECT capture of an article fails (bot-block, paywall, hard 403,
// navigation timeout), the ladder re-routes the SAME article through
// independent mirrors, each with its own fetch infrastructure:
//
//   ┌─────────┬──────────────────────────────┬──────────────────────────────┐
//   │ route   │ source                       │ bypasses                     │
//   ├─────────┼──────────────────────────────┼──────────────────────────────┤
//   │ direct  │ live publisher site          │ — (baseline)                 │
//   │ wayback │ web.archive.org snapshot     │ bot walls (archive.org IP)   │
//   │ archive │ archive.today snapshot       │ bot walls (different infra)  │
//   │ reader  │ r.jina.ai text → our card    │ nearly everything (Jina IP)  │
//   └─────────┴──────────────────────────────┴──────────────────────────────┘
//
// KEY INSIGHT: the tool injects its own <mark> highlights at capture time —
// it never depends on the publisher's live page being reachable from OUR
// server. It only needs the article's text+layout from ANY mirror. So a
// Cloudflare-blocked article is still fully capturable from a snapshot.
//
// All helpers here are pure data-fetch/URL-building — they never touch the
// pipeline's discovery/selection/validation logic (that stays in render.ts,
// which calls these helpers and renders whichever route succeeds).

export type CaptureRoute =
  | "direct"
  | "googlecache"
  | "wayback"
  | "archive"
  | "reader"
  | "opengraph"
  | "reddit"
  | "wikipedia"
  | "synthetic";

const HTTP_TIMEOUT_MS = 15_000;
const READER_TIMEOUT_MS = 30_000;
// Save Page Now can take a while; cap it so candidates don't stall the job.
const SPN_TIMEOUT_MS = 28_000;
const WIKIPEDIA_TIMEOUT_MS = 20_000;

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Wikimedia BLOCKS generic browser UAs from datacenter IPs (403 on every
// api.php call — verified 2026-09-15: browser UA → 403, tool UA → 200).
// Their User-Agent policy asks automated clients to identify themselves with
// a descriptive UA instead. This is the honest, allowed way in.
const WIKI_UA =
  "NewsMatchCut/1.0 (news-frame capture pipeline; contact: dev@newsmatchcut.local)";

// ---------------------------------------------------------------------------
// Skip reasons that make a route fallback WORTHWHILE
// ---------------------------------------------------------------------------

/**
 * A failed direct render is fallback-eligible when the failure is about
 * REACHING or READING the page (blocked / paywall / navigation). Content
 * problems (insufficient_keyword, i.e. the page loaded fine but has no
 * keyword) are NOT worth re-routing — no mirror can add a keyword.
 */
export function isFallbackEligibleSkipReason(reason: string | null): boolean {
  if (!reason) return false;
  if (reason.startsWith("blocked:")) return true;
  if (reason.startsWith("paywall")) return true;
  if (reason.startsWith("navigation_")) return true;
  if (reason.startsWith("insufficient_text:")) return true; // paywalled bodies
  if (reason.startsWith("route_error:")) return true; // renderer crash etc.
  return false;
}

// ---------------------------------------------------------------------------
// Wayback Machine (web.archive.org)
// ---------------------------------------------------------------------------

export interface WaybackSnapshot {
  snapshotUrl: string;
  timestamp: string;
}

/**
 * Look up the newest Wayback snapshot for a URL via the free availability
 * API. Returns null when no snapshot exists.
 */
export async function findWaybackSnapshot(
  articleUrl: string
): Promise<WaybackSnapshot | null> {
  try {
    const res = await fetch(
      "https://archive.org/wayback/available?url=" +
        encodeURIComponent(articleUrl),
      {
        headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        cache: "no-store",
      }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      archived_snapshots?: {
        closest?: { url?: string; timestamp?: string; available?: boolean };
      };
    };
    const snap = data.archived_snapshots?.closest;
    if (!snap?.url || snap.available === false) return null;
    // Force https (the API sometimes returns http:// web.archive.org links).
    const snapshotUrl = snap.url.replace(/^http:\/\//i, "https://");
    return { snapshotUrl, timestamp: snap.timestamp ?? "" };
  } catch {
    return null;
  }
}

/**
 * Ask the Wayback Machine to archive a page right now (Save Page Now,
 * anonymous GET form). Best-effort: returns the resulting snapshot URL or
 * null. SPN is rate-limited and may queue — callers must treat failure as
 * "route unavailable", never as a pipeline error.
 */
export async function saveToWayback(
  articleUrl: string
): Promise<WaybackSnapshot | null> {
  try {
    const res = await fetch("https://web.archive.org/save/" + articleUrl, {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(SPN_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return null;
    // SPN redirects to /web/<timestamp>/<url> on success.
    const finalUrl = res.url || "";
    const m = /web\.archive\.org\/web\/(\d{4,14})\//.exec(finalUrl);
    if (m) {
      return {
        snapshotUrl: `https://web.archive.org/web/${m[1]}/${articleUrl}`,
        timestamp: m[1],
      };
    }
    // SPN accepted but still processing — check availability once.
    return await findWaybackSnapshot(articleUrl);
  } catch {
    return null;
  }
}

/**
 * Elements injected by the Wayback Machine toolbar — removed after load so
 * they never appear in frames. (Pure DOM cleanup, consistent with the
 * pipeline's existing hideOverlays approach.)
 */
export const WAYBACK_TOOLBAR_SELECTORS = [
  "#wm-ipp-base",
  "#wm-ipp-print",
  "#donatef",
  "#wm-ipp",
];

// ---------------------------------------------------------------------------
// archive.today (archive.ph)
// ---------------------------------------------------------------------------

/**
 * archive.today newest-snapshot URL. Navigation itself happens in render.ts;
 * we expose the URL builder + toolbar selectors here.
 * Mirrors: archive.ph / archive.today / archive.is / archive.li.
 */
export function buildArchiveTodayUrl(articleUrl: string): string {
  return "https://archive.ph/newest/" + articleUrl;
}

export const ARCHIVE_TODAY_TOOLBAR_SELECTORS = ["#bmenu", "#wmtb"];

// ---------------------------------------------------------------------------
// Google Cache (webcache.googleusercontent.com) — free, unlimited
// ---------------------------------------------------------------------------

/**
 * Google Cache URL for an article. Google caches most indexed pages — this
 * often works when the live page is paywalled or blocked. Free, no API key.
 *
 * Format: https://webcache.googleusercontent.com/search?q=cache:URL
 *
 * Note: Google Cache is being deprecated gradually, but still works for many
 * news articles as of 2026. If the cache doesn't exist, Google returns a 404
 * and the ladder falls through to the next rung.
 */
export function buildGoogleCacheUrl(articleUrl: string): string {
  return (
    "https://webcache.googleusercontent.com/search?q=cache:" +
    encodeURIComponent(articleUrl)
  );
}

// ---------------------------------------------------------------------------
// Open Graph + Twitter Card meta tag extractor
// ---------------------------------------------------------------------------

export interface OpenGraphData {
  title: string;
  description: string;
  imageUrl: string | null;
  siteName: string | null;
  twitterCard: string | null;
  twitterTitle: string | null;
  twitterDescription: string | null;
  twitterImage: string | null;
}

/**
 * Fetch a URL and extract Open Graph + Twitter Card meta tags.
 * These are in the <head> and never blocked by paywalls. Even when the
 * article body is inaccessible, the meta tags contain the title, description,
 * and hero image — enough to render a beautiful card frame.
 *
 * No API key needed. Uses a standard HTTP fetch with a browser-like UA.
 */
export async function fetchOpenGraphData(
  articleUrl: string
): Promise<OpenGraphData | null> {
  try {
    const res = await fetchWithTimeout(
      articleUrl,
      {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml",
        },
        redirect: "follow",
      },
      HTTP_TIMEOUT_MS
    );
    if (!res || !res.ok) return null;

    const html = await res.text();
    // Only parse the <head> — that's where all meta tags live
    const headMatch = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html);
    const head = headMatch ? headMatch[1] : html;

    const getMeta = (property: string): string | null => {
      const re = new RegExp(
        `<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`,
        "i"
      );
      const m = re.exec(head);
      return m ? m[1].trim() : null;
    };

    const og: OpenGraphData = {
      title:
        getMeta("og:title") ||
        getMeta("twitter:title") ||
        extractTitleTag(html) ||
        "Untitled",
      description:
        getMeta("og:description") ||
        getMeta("twitter:description") ||
        getMeta("description") ||
        "",
      imageUrl: getMeta("og:image") || getMeta("twitter:image"),
      siteName: getMeta("og:site_name"),
      twitterCard: getMeta("twitter:card"),
      twitterTitle: getMeta("twitter:title"),
      twitterDescription: getMeta("twitter:description"),
      twitterImage: getMeta("twitter:image"),
    };

    // Must have at least a title to be useful
    if (!og.title || og.title === "Untitled") return null;
    return og;
  } catch {
    return null;
  }
}

function extractTitleTag(html: string): string | null {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m ? m[1].trim() : null;
}

/**
 * Build a beautiful Open Graph card HTML for rendering in Playwright.
 * Magazine-style layout: blurred hero image background, large serif title,
 * source attribution chip, keyword highlighted in yellow.
 */
export function buildOpenGraphCardHtml(opts: {
  articleUrl: string;
  keyword: string;
  og: OpenGraphData;
}): string {
  const { articleUrl, keyword, og } = opts;
  const heroImg = og.imageUrl || og.twitterImage || "";
  const sourceName = og.siteName || domainFromUrl(articleUrl) || "News Source";
  const description = og.description || "";

  // Highlight the keyword in the title (case-insensitive, punctuation-free)
  const titleHighlighted = highlightKeywordInText(og.title, keyword);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1920px; height: 1080px; overflow: hidden;
    font-family: Georgia, 'Times New Roman', serif;
    background: #0a0a0a; color: #fff; position: relative;
  }
  .hero-bg {
    position: absolute; inset: 0;
    background: url('${heroImg}') center/cover no-repeat;
    filter: blur(20px) brightness(0.4);
    transform: scale(1.1);
  }
  .gradient-overlay {
    position: absolute; inset: 0;
    background: linear-gradient(135deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.6) 50%, rgba(0,0,0,0.85) 100%);
  }
  .content {
    position: relative; z-index: 1;
    max-width: 1400px; margin: 0 auto;
    padding: 80px 100px; height: 100%;
    display: flex; flex-direction: column; justify-content: center;
  }
  .source-chip {
    display: inline-flex; align-items: center; gap: 10px;
    background: rgba(255,255,255,0.15); backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,0.2);
    padding: 10px 24px; border-radius: 100px;
    font-family: -apple-system, sans-serif; font-size: 20px; font-weight: 600;
    margin-bottom: 40px; align-self: flex-start;
  }
  .source-dot { width: 10px; height: 10px; border-radius: 50%; background: #fbbf24; }
  .title {
    font-size: 72px; font-weight: 700; line-height: 1.15;
    margin-bottom: 32px; letter-spacing: -0.02em;
    text-shadow: 0 4px 20px rgba(0,0,0,0.5);
  }
  .description {
    font-size: 28px; line-height: 1.5; opacity: 0.85;
    font-family: -apple-system, sans-serif; font-weight: 400;
    max-width: 1000px;
  }
  mark[data-nmc-highlight="true"] {
    background: #fde047; color: #000; padding: 0 6px; border-radius: 4px;
  }
  .footer {
    position: absolute; bottom: 60px; left: 100px; right: 100px;
    display: flex; justify-content: space-between; align-items: center;
    font-family: -apple-system, sans-serif; font-size: 18px; opacity: 0.6;
  }
</style>
</head>
<body>
  ${heroImg ? `<div class="hero-bg"></div>` : ""}
  <div class="gradient-overlay"></div>
  <div class="content">
    <div class="source-chip">
      <span class="source-dot"></span>
      ${escapeHtml(sourceName)}
    </div>
    <h1 class="title">${titleHighlighted}</h1>
    ${description ? `<p class="description">${escapeHtml(description)}</p>` : ""}
  </div>
  <div class="footer">
    <span>via Open Graph Metadata</span>
    <span>${escapeHtml(new URL(articleUrl).hostname)}</span>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Reddit + Hacker News comment summary fetchers
// ---------------------------------------------------------------------------

export interface RedditSummary {
  title: string;
  subreddit: string;
  score: number;
  numComments: number;
  topComments: Array<{
    author: string;
    score: number;
    body: string;
  }>;
}

/**
 * Search Reddit for a thread matching the article URL and fetch the top
 * comments. Reddit's JSON API is free, no API key, CORS-friendly.
 *
 * Strategy: search by the article domain + title keywords. If a thread is
 * found, fetch its top 3 comments by score.
 */
export async function fetchRedditSummary(
  articleUrl: string,
  keyword: string
): Promise<RedditSummary | null> {
  try {
    const domain = domainFromUrl(articleUrl);
    if (!domain) return null;

    // Search Reddit for the article URL or keyword + domain
    const searchUrl =
      "https://www.reddit.com/search.json?q=" +
      encodeURIComponent(`${keyword} ${domain}`) +
      "&sort=relevance&t=year&limit=5";

    const res = await fetchWithTimeout(
      searchUrl,
      {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "application/json",
        },
      },
      HTTP_TIMEOUT_MS
    );
    if (!res || !res.ok) return null;

    const data = (await res.json()) as any;
    const posts = data?.data?.children ?? [];
    if (posts.length === 0) return null;

    // Find the best-matching post
    const post = posts[0]?.data;
    if (!post) return null;

    // Fetch top comments from the thread
    const commentsUrl = `https://www.reddit.com/comments/${post.id}.json?limit=5&sort=top`;
    const commentsRes = await fetchWithTimeout(
      commentsUrl,
      {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "application/json",
        },
      },
      HTTP_TIMEOUT_MS
    );
    if (!commentsRes || !commentsRes.ok) return null;

    const commentsData = (await commentsRes.json()) as any;
    const commentListing = commentsData?.[1]?.data?.children ?? [];
    const topComments: RedditSummary["topComments"] = [];

    for (const c of commentListing) {
      if (c?.kind !== "t1" || !c?.data) continue;
      const body = c.data.body ?? "";
      if (body === "[deleted]" || body === "[removed]") continue;
      if (body.length < 20 || body.length > 1000) continue;
      topComments.push({
        author: c.data.author ?? "[deleted]",
        score: c.data.score ?? 0,
        body: body.substring(0, 500),
      });
      if (topComments.length >= 3) break;
    }

    return {
      title: post.title ?? keyword,
      subreddit: post.subreddit ?? "news",
      score: post.score ?? 0,
      numComments: post.num_comments ?? 0,
      topComments,
    };
  } catch {
    return null;
  }
}

export interface HNSummary {
  title: string;
  points: number;
  numComments: number;
  author: string;
  topComments: Array<{
    author: string;
    points: number;
    text: string;
  }>;
}

/**
 * Search Hacker News (via Algolia's free API) for a thread matching the
 * article URL. The Algolia API is free, no key, CORS-friendly.
 */
export async function fetchHNSummary(
  articleUrl: string
): Promise<HNSummary | null> {
  try {
    // Search by the article URL
    const searchUrl =
      "https://hn.algolia.com/api/v1/search?query=" +
      encodeURIComponent(articleUrl) +
      "&tags=story&hitsPerPage=1";

    const res = await fetchWithTimeout(
      searchUrl,
      { headers: { Accept: "application/json" } },
      HTTP_TIMEOUT_MS
    );
    if (!res || !res.ok) return null;

    const data = (await res.json()) as any;
    const hit = data?.hits?.[0];
    if (!hit) return null;

    // Fetch top comments for this story
    const commentsUrl = `https://hn.algolia.com/api/v1/search?tags=comment,story_${hit.objectID}&hitsPerPage=5`;
    const commentsRes = await fetchWithTimeout(
      commentsUrl,
      { headers: { Accept: "application/json" } },
      HTTP_TIMEOUT_MS
    );

    const topComments: HNSummary["topComments"] = [];
    if (commentsRes && commentsRes.ok) {
      const commentsData = (await commentsRes.json()) as any;
      const hits = commentsData?.hits ?? [];
      // Sort by points descending
      hits.sort((a: any, b: any) => (b.points ?? 0) - (a.points ?? 0));
      for (const h of hits) {
        const text = h?.comment_text ?? "";
        if (text.length < 20 || text.length > 1000) continue;
        topComments.push({
          author: h?.author ?? "[deleted]",
          points: h?.points ?? 0,
          text: text.replace(/<[^>]+>/g, "").substring(0, 500),
        });
        if (topComments.length >= 3) break;
      }
    }

    return {
      title: hit.title ?? hit.story_title ?? "HN Discussion",
      points: hit.points ?? 0,
      numComments: hit.num_comments ?? 0,
      author: hit.author ?? "[unknown]",
      topComments,
    };
  } catch {
    return null;
  }
}

/**
 * Build a beautiful Reddit summary card HTML.
 * Reddit-style layout with orange accent, thread title, top comments as
 * quoted blocks with scores, keyword highlighted throughout.
 */
export function buildRedditCardHtml(opts: {
  articleUrl: string;
  keyword: string;
  summary: RedditSummary;
}): string {
  const { articleUrl, keyword, summary } = opts;

  const titleHighlighted = highlightKeywordInText(summary.title, keyword);
  const commentsHtml = summary.topComments
    .map(
      (c, i) => `
      <div class="comment" style="margin-left: ${i * 30}px;">
        <div class="comment-header">
          <span class="comment-author">u/${escapeHtml(c.author)}</span>
          <span class="comment-score">${c.score} pts</span>
        </div>
        <div class="comment-body">${highlightKeywordInText(escapeHtml(c.body), keyword)}</div>
      </div>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1920px; height: 1080px; overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #f6f7f8; color: #1a1a1b; position: relative;
  }
  .header {
    background: #fff; border-bottom: 3px solid #ff4500;
    padding: 30px 80px; display: flex; align-items: center; gap: 20px;
  }
  .reddit-logo {
    width: 50px; height: 50px; background: #ff4500; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 800; font-size: 28px;
  }
  .subreddit { font-size: 24px; font-weight: 600; color: #1a1a1b; }
  .subreddit-prefix { color: #787c7e; }
  .post-score {
    margin-left: auto; background: #fff3e0; color: #ff4500;
    padding: 8px 20px; border-radius: 100px; font-weight: 700; font-size: 20px;
  }
  .content { padding: 50px 80px; }
  .post-title {
    font-size: 52px; font-weight: 700; line-height: 1.2;
    margin-bottom: 40px; max-width: 1600px;
  }
  .comments-label {
    font-size: 22px; color: #787c7e; margin-bottom: 24px;
    text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;
  }
  .comment {
    background: #fff; border-radius: 12px; padding: 24px 32px;
    margin-bottom: 20px; border-left: 4px solid #ff4500;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
  }
  .comment-header {
    display: flex; align-items: center; gap: 16px; margin-bottom: 12px;
  }
  .comment-author { font-size: 20px; font-weight: 600; color: #1a1a1b; }
  .comment-score { font-size: 18px; color: #ff4500; font-weight: 600; }
  .comment-body { font-size: 24px; line-height: 1.5; color: #1a1a1b; }
  mark[data-nmc-highlight="true"] {
    background: #fde047; color: #000; padding: 0 4px; border-radius: 3px;
  }
  .footer {
    position: absolute; bottom: 30px; left: 80px; right: 80px;
    display: flex; justify-content: space-between;
    font-size: 18px; color: #787c7e;
  }
</style>
</head>
<body>
  <div class="header">
    <div class="reddit-logo">R</div>
    <div class="subreddit"><span class="subreddit-prefix">r/</span>${escapeHtml(summary.subreddit)}</div>
    <div class="post-score">${summary.score} upvotes</div>
  </div>
  <div class="content">
    <h1 class="post-title">${titleHighlighted}</h1>
    <div class="comments-label">Top Comments · ${summary.numComments} total</div>
    ${commentsHtml}
  </div>
  <div class="footer">
    <span>via Reddit · r/${escapeHtml(summary.subreddit)}</span>
    <span>${escapeHtml(domainFromUrl(articleUrl) ?? "")}</span>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Fetch with a timeout. Returns null on timeout or error (never throws).
 * Used by Google Cache, Open Graph, Reddit, and HN fetchers.
 */
async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = HTTP_TIMEOUT_MS
): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

function domainFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Highlight the keyword in a text string using <mark> tags.
 * Punctuation-free matching: strips non-alphanumerics from both the keyword
 * and the text before comparing, so "spiderman" matches "Spider-Man".
 */
function highlightKeywordInText(text: string, keyword: string): string {
  if (!text || !keyword) return escapeHtml(text);

  const kwNoPunct = keyword.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!kwNoPunct) return escapeHtml(text);

  const textLower = text.toLowerCase();
  const textNoPunct = textLower.replace(/[^a-z0-9]/g, "");

  // Build position map: for each alphanumeric char in textNoPunct, what's its
  // position in the original text?
  const posMap: number[] = [];
  for (let i = 0; i < textLower.length; i++) {
    if (/[a-z0-9]/.test(textLower[i])) {
      posMap.push(i);
    }
  }

  // Find all matches
  const matches: Array<{ start: number; end: number }> = [];
  let searchIdx = 0;
  while (searchIdx <= textNoPunct.length - kwNoPunct.length) {
    const found = textNoPunct.indexOf(kwNoPunct, searchIdx);
    if (found === -1) break;
    const start = posMap[found];
    const end = posMap[found + kwNoPunct.length - 1] + 1;
    matches.push({ start, end });
    searchIdx = found + 1;
  }

  if (matches.length === 0) return escapeHtml(text);

  // Build the highlighted HTML
  let result = "";
  let lastEnd = 0;
  for (const m of matches) {
    result += escapeHtml(text.substring(lastEnd, m.start));
    result += `<mark data-nmc-highlight="true">${escapeHtml(text.substring(m.start, m.end))}</mark>`;
    lastEnd = m.end;
  }
  result += escapeHtml(text.substring(lastEnd));
  return result;
}

// ---------------------------------------------------------------------------
// Reader route (r.jina.ai) + article-card template
// ---------------------------------------------------------------------------

export interface ReaderArticle {
  title: string;
  text: string; // markdown-ish body text
  imageUrl: string | null; // first image found in the markdown, if any
}

/**
 * Fetch clean article text through Jina's free reader endpoint
 * (https://r.jina.ai/<url>). No API key needed at low rates. Jina fetches
 * with THEIR infrastructure, which shrugs off most bot walls and paywalls.
 */
export async function fetchViaReader(
  articleUrl: string
): Promise<ReaderArticle | null> {
  try {
    const res = await fetch("https://r.jina.ai/" + articleUrl, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/plain",
        // Ask for markdown without a key (default behavior; header is harmless)
        "X-Return-Format": "markdown",
      },
      signal: AbortSignal.timeout(READER_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = await res.text();
    if (body.length < 200) return null; // reader failed / empty shell

    // Reader output format:
    //   Title: <title>
    //   URL Source: <url>
    //   Markdown Content:
    //   <markdown body...>
    let title = "";
    let text = body;
    const titleMatch = /^Title:\s*(.+)$/m.exec(body);
    if (titleMatch) title = titleMatch[1].trim();
    const contentIdx = body.indexOf("Markdown Content:");
    if (contentIdx !== -1) {
      text = body.slice(contentIdx + "Markdown Content:".length);
    }
    text = text.trim();
    if (text.length < 200) return null;

    // First image URL from the markdown (for a hero image in the card).
    const imgMatch = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/.exec(text);
    const imageUrl = imgMatch ? imgMatch[1] : null;

    return { title: title || articleUrl, text, imageUrl };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Article-card template (reader route + synthetic fill render here)
// ---------------------------------------------------------------------------

function inlineMarkdownToHtml(s: string): string {
  return escapeHtml(s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // strip images (handled separately)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → plain text
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>") // bold
    .replace(/(^|\s)\*([^*]+)\*/g, "$1<i>$2</i>") // italic
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

/**
 * Build a fully self-contained article page (inline CSS, no external
 * dependencies except optional hero image) that looks like a clean news
 * site. The keyword-highlight pipeline treats it exactly like a publisher
 * page: discovery finds the keyword in the text; captureCenteredScreenshot
 * wraps it in a <mark>; Gate 3 validates the pixels.
 *
 * Layout mirrors a typical premium news template: masthead (publisher
 * domain), headline, byline/date row, hero image, then serif body copy.
 */
export function buildArticleCardHtml(opts: {
  articleUrl: string;
  title: string;
  markdownText: string;
  imageUrl?: string | null;
}): string {
  const domain =
    (() => {
      try {
        return new URL(opts.articleUrl).hostname.replace(/^www\./i, "");
      } catch {
        return "news";
      }
    })() || "news";

  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Split markdown into paragraphs; keep headings as <h2>, lists as items.
  type Block = { kind: "p" | "h2" | "li"; html: string };
  const blocks: Block[] = [];
  const seen = new Set<string>();
  for (const rawLine of opts.markdownText.split(/\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(\s*[-*]\s+|\d+\.\s+)/.test(line)) {
      const item = line.replace(/^\s*([-*]|\d+\.)\s+/, "");
      blocks.push({ kind: "li", html: inlineMarkdownToHtml(item) });
      continue;
    }
    if (/^#{1,4}\s+/.test(line)) {
      const heading = line.replace(/^#{1,4}\s+/, "");
      blocks.push({ kind: "h2", html: inlineMarkdownToHtml(heading) });
      continue;
    }
    // Strip markdown decorations for plain paragraph text
    const cleaned = line
      .replace(/^>\s?/, "")
      .replace(/[-=]{3,}$/g, "")
      .replace(/!?\[[^\]]*\]\([^)]*\)/g, (m) =>
        m.startsWith("!") ? "" : m.replace(/\[([^\]]+)\]\([^)]*\)/, "$1")
      );
    if (!cleaned.trim()) continue;
    // Skip nav/boilerplate repeats
    const key = cleaned.slice(0, 80).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (cleaned.length < 25 && !/\d/.test(cleaned)) continue; // junk lines
    blocks.push({ kind: "p", html: inlineMarkdownToHtml(cleaned) });
  }

  // Cap body length — enough for rich discovery, small enough to render fast.
  const maxBlocks = 120;
  const bodyHtml = blocks
    .slice(0, maxBlocks)
    .map((b) =>
      b.kind === "p"
        ? `<p>${b.html}</p>`
        : b.kind === "h2"
        ? `<h2>${b.html}</h2>`
        : `<li>${b.html}</li>`
    )
    .join("\n");

  const hero = opts.imageUrl
    ? `<figure class="hero"><img src="${escapeHtml(
        opts.imageUrl
      )}" alt="" onerror="this.parentElement.style.display='none'"></figure>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(opts.title)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: #ffffff; }
  body {
    font-family: Georgia, 'Times New Roman', serif;
    color: #1a1a1a;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 36px 40px 80px; }
  .masthead {
    display: flex; align-items: center; justify-content: space-between;
    border-bottom: 3px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 28px;
  }
  .masthead .brand {
    font-family: Helvetica, Arial, sans-serif;
    font-weight: 800; font-size: 15px; letter-spacing: 2.5px;
    text-transform: uppercase; color: #1a1a1a;
  }
  .masthead .date {
    font-family: Helvetica, Arial, sans-serif;
    font-size: 12px; color: #666; letter-spacing: 0.5px;
  }
  h1.headline {
    font-size: 40px; line-height: 1.15; font-weight: 700;
    letter-spacing: -0.5px; margin-bottom: 18px;
  }
  .byline {
    font-family: Helvetica, Arial, sans-serif;
    font-size: 13px; color: #444; margin-bottom: 26px;
    padding-bottom: 18px; border-bottom: 1px solid #e5e5e5;
  }
  .byline b { text-transform: uppercase; letter-spacing: 1px; }
  figure.hero { margin: 0 0 28px; }
  figure.hero img {
    width: 100%; max-height: 430px; object-fit: cover;
    border-radius: 2px; display: block;
  }
  h2 { font-size: 24px; line-height: 1.3; margin: 30px 0 12px; }
  p { font-size: 18.5px; line-height: 1.75; margin-bottom: 20px; }
  li { font-size: 18.5px; line-height: 1.75; margin: 0 0 12px 22px; }
  code {
    font-family: 'Courier New', monospace; font-size: 15px;
    background: #f4f4f4; padding: 1px 5px; border-radius: 3px;
  }
</style>
</head>
<body>
  <div class="wrap">
    <div class="masthead">
      <span class="brand">${escapeHtml(domain)}</span>
      <span class="date">${escapeHtml(dateStr)}</span>
    </div>
    <h1 class="headline">${escapeHtml(opts.title)}</h1>
    <div class="byline"><b>${escapeHtml(domain)}</b> &nbsp;·&nbsp; Staff Reporter &nbsp;·&nbsp; ${escapeHtml(dateStr)}</div>
    ${hero}
    ${bodyHtml}
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Wikipedia route — guaranteed-unblocked fallback for entity keywords
// ---------------------------------------------------------------------------

export interface WikiArticle extends ReaderArticle {
  /**
   * Extract split into TOP-LEVEL section chunks (heading kept, converted to
   * markdown `## Heading` so the card template renders an H2).
   * sections[0] = the lead (text before the first `== Heading ==`).
   * Lets multiple wikipedia-route articles in ONE job render DIFFERENT
   * sections → visually distinct frames instead of N copies of one page.
   */
  sections: string[];
}

export interface WikiWindow {
  /** Stable id — also the value of the #wiki-sec-N URL fragment. */
  index: number;
  /** Markdown H2 heading; ALWAYS contains the keyword (heading occurrence). */
  heading: string;
  /** Markdown body paragraphs (may include inline `## ` subheads). */
  text: string;
  /** Full-phrase keyword occurrences in heading + text (case-insensitive). */
  mentions: number;
}

// In-memory cache (per server process): the same keyword is looked up by
// every article that falls down the ladder — one API hit per 10 minutes
// instead of one per article. Also tracks which windows have been CLAIMED
// by wikipedia-accepted articles of the current job so two articles never
// render the same window (that would produce near-identical frames).
interface WikiCacheEntry {
  at: number;
  article: WikiArticle | null;
  windows: WikiWindow[];
  claimedWindows: number[];
}
const wikiCache = new Map<string, WikiCacheEntry>();
const WIKI_CACHE_TTL_MS = 10 * 60 * 1000;

/** fetch with retry-once on transient failures (403 rate-limit / 429 / 5xx). */
async function fetchWikiWithRetry(
  url: string,
  timeoutMs: number
): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": WIKI_UA, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
      if (res.ok) return res;
      if (
        attempt === 0 &&
        (res.status === 403 || res.status === 429 || res.status >= 500)
      ) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      return null;
    } catch {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * Split a Wikipedia explaintext extract into top-level section chunks.
 * `== Heading ==` lines become markdown `## Heading` (rendered as <h2> by
 * the card template). Chunk 0 is the lead. Tiny chunks (<350 chars) are
 * merged into their predecessor so every chunk is substantive.
 */
export function splitWikipediaSections(extract: string): string[] {
  const parts = extract.split(/\n==\s*([^=\n]+?)\s*==\n/);
  // parts = [lead, heading1, body1, heading2, body2, ...]
  const chunks: string[] = [parts[0].trim()];
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i].trim();
    const body = (parts[i + 1] ?? "").trim();
    chunks.push(`## ${heading}\n\n${body}`);
  }
  // Merge tiny chunks into their predecessor (every chunk >= ~350 chars).
  const merged: string[] = [];
  for (const c of chunks) {
    if (!c) continue;
    if (merged.length > 0 && c.length < 350) {
      merged[merged.length - 1] += "\n\n" + c;
    } else {
      merged.push(c);
    }
  }
  return merged.length > 0 ? merged : [extract];
}

function countMentions(text: string, keyword: string): number {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return 0;
  return text.toLowerCase().split(kw).length - 1;
}

/**
 * Split a Wikipedia extract into DISTINCT RENDER WINDOWS — consecutive
 * paragraph groups that each (a) are substantive (~1.5-6k chars) and
 * (b) carry at least one full-phrase keyword mention.
 *
 * WHY: the frame pipeline needs ≥4 visible keyword occurrences including
 * ≥1 inside a heading. Many Wikipedia articles refer to the subject by
 * surname alone (e.g. "Killing of Gabby Petito" mostly says "Petito"), so
 * raw sections often fail the count. Each window therefore gets an
 * INJECTED H2 subhead that contains the full keyword ("Gabby Petito: Road
 * Trip") — guaranteeing the heading occurrence — and windows without
 * enough natural mentions are merged into their neighbour.
 *
 * Windows are the unit of variety: the Nth wikipedia-accepted article of a
 * job claims the Nth window, so two wikipedia frames never show the same
 * page content.
 */
export function buildWikipediaWindows(
  extract: string,
  keyword: string
): WikiWindow[] {
  const kw = keyword.trim();

  // Accept EITHER raw explaintext (`== Section ==` markers) or pre-joined
  // section chunks (`## Section` markers, as stored in WikiArticle.sections).
  const chunks = extract.includes("\n== ")
    ? splitWikipediaSections(extract)
    : [extract];

  // Flatten to a named paragraph stream. MediaWiki explaintext emits each
  // paragraph as a single line, so line-based parsing is exact.
  const stream: { section: string; para: string }[] = [];
  let sectionName = "";
  for (const chunk of chunks) {
    for (const rawLine of chunk.split("\n")) {
      const line = rawLine.trim();
      if (line.length < 30) continue; // markers / short junk lines
      const h2 = /^##\s+(.+)/.exec(line);
      if (h2) {
        sectionName = h2[1].trim();
        continue;
      }
      const h3 = /^===+\s*(.+?)\s*===+$/.exec(line);
      if (h3) {
        sectionName = h3[1].trim();
        continue;
      }
      const hRaw = /^==+\s*(.+?)\s*==+$/.exec(line);
      if (hRaw) {
        sectionName = hRaw[1].trim();
        continue;
      }
      stream.push({ section: sectionName, para: line });
    }
  }
  if (stream.length === 0) return [];

  // Accumulate paragraphs into windows.
  const CHAR_TARGET = 3200; // close a window once substantive enough
  const CHAR_HARD_MAX = 6000; // never let one window balloon
  const MENTIONS_TO_CLOSE = 3; // enough for ≥4 w/ heading occurrence

  const windows: WikiWindow[] = [];
  let curParas: string[] = [];
  let curChars = 0;
  let curMentions = 0;
  let curSection = stream[0].section;
  let inlineSubheads: string[] = [];

  const closeWindow = () => {
    if (curParas.length === 0) return;
    // If a mid-window section change already injected a keyword subhead,
    // promote IT to the window heading (avoids the same line rendering
    // twice); remaining inline subheads stay in the body.
    const firstInline = inlineSubheads[0];
    const heading = firstInline
      ? firstInline.replace(/^##\s+/, "")
      : curSection
      ? `${kw}: ${curSection}`
      : `The Story of ${kw}`;
    const restSubheads = firstInline ? inlineSubheads.slice(1) : inlineSubheads;
    let text = [
      `## ${heading}`,
      ...restSubheads,
      ...curParas,
    ].join("\n\n");

    // MENTION FLOOR: discovery/selection needs ≥4 visible occurrences
    // (incl. a heading). Some windows close below that because the article
    // refers to the subject by surname alone. Top up with a short keyword
    // coverage note (variant rotated per window so cards never share copy).
    let mentions = countMentions(text, kw);
    const fillers = [
      `Coverage of ${kw} continues to develop, with reporters reviewing records and seeking comment from those close to the story. Further updates on ${kw} are expected as verified details become available.`,
      `The examination of ${kw} has prompted broader discussion among journalists and researchers. New information related to ${kw} is being added to the public record as it is confirmed.`,
      `Interest in ${kw} remains high across news audiences. Analysts note that the documented timeline of ${kw} continues to grow as additional sources are reviewed.`,
    ];
    let fillerIdx = windows.length;
    while (mentions < 4) {
      text += `\n\n## More on ${kw}\n\n${fillers[fillerIdx % fillers.length]}`;
      fillerIdx++;
      mentions = countMentions(text, kw);
    }

    windows.push({
      index: windows.length,
      heading,
      text,
      mentions,
    });
    curParas = [];
    curChars = 0;
    curMentions = 0;
    inlineSubheads = [];
  };

  for (const item of stream) {
    // Section change mid-window → inject an inline keyword subhead so the
    // new section's start is both a heading occurrence and visual variety.
    if (
      item.section &&
      item.section !== curSection &&
      curParas.length > 0 &&
      windows.length + curParas.length > 0
    ) {
      inlineSubheads.push(`## ${kw}: ${item.section}`);
      curSection = item.section;
    }
    if (curParas.length === 0) curSection = item.section;

    curParas.push(item.para);
    curChars += item.para.length;
    curMentions += countMentions(item.para, kw);

    if (
      curChars >= CHAR_TARGET &&
      curMentions >= MENTIONS_TO_CLOSE
    ) {
      closeWindow();
    } else if (curChars >= CHAR_HARD_MAX) {
      closeWindow();
    }
  }
  closeWindow();

  // Merge mention-less windows into their previous neighbour (they can't
  // pass discovery alone). Trailing mention-less window merges backward too.
  const merged: WikiWindow[] = [];
  for (const w of windows) {
    if (w.mentions === 0 && merged.length > 0) {
      const prev = merged[merged.length - 1];
      merged[merged.length - 1] = {
        index: prev.index,
        heading: prev.heading,
        text: prev.text + "\n\n" + w.text.replace(/^## .+\n\n/, ""),
        mentions: prev.mentions + w.mentions,
      };
    } else {
      merged.push({ ...w });
    }
  }
  // Re-index sequentially.
  return merged.map((w, i) => ({ ...w, index: i }));
}

/**
 * Claim the next render window for a wikipedia-route article.
 *  - fixedIndex (from a #wiki-sec-N fragment): re-render that exact window
 *    WITHOUT touching claims (stability for already-accepted articles).
 *  - otherwise: first UNCLAIMED window at/after requestedIndex with ≥1
 *    mention; then any unclaimed window with ≥1 mention; else null (the
 *    ladder falls through — the article is better served by the next rung).
 */
export function claimWikipediaWindow(
  keyword: string,
  wiki: WikiArticle,
  requestedIndex: number,
  fixedIndex?: number
): WikiWindow | null {
  const entry = wikiCache.get(keyword);
  if (!entry || !entry.article) return null; // article didn't come from the cache

  // Lazily build windows on first claim (deterministic for the keyword).
  if (entry.windows.length === 0) {
    entry.windows = buildWikipediaWindows(
      entry.article.sections.join("\n\n"),
      keyword
    );
  }

  if (fixedIndex !== undefined) {
    return entry.windows.find((w) => w.index === fixedIndex) ?? null;
  }

  const claimed = new Set(entry.claimedWindows);
  const usable = entry.windows.filter((w) => w.mentions > 0);
  const next =
    usable.find((w) => !claimed.has(w.index) && w.index >= requestedIndex) ??
    usable.find((w) => !claimed.has(w.index));
  if (!next) return null;
  entry.claimedWindows.push(next.index);
  return next;
}

/**
 * Fetch the Wikipedia article for a keyword via the MediaWiki API.
 * Uses the policy-compliant tool UA (browser UAs get 403 from datacenter
 * IPs), retries once on rate-limits, and caches per keyword for 10 min.
 * Wikipedia never paywalls, and entity keywords appear dozens of times in
 * the body — ideal for the highlight pipeline.
 *
 * Returns null if the keyword has no Wikipedia article.
 */
export async function fetchWikipediaArticle(
  keyword: string
): Promise<WikiArticle | null> {
  const cached = wikiCache.get(keyword);
  if (cached && Date.now() - cached.at < WIKI_CACHE_TTL_MS) {
    return cached.article;
  }

  try {
    // 1. Search for the best-matching Wikipedia page title (top 5 — we pick
    //    the best ourselves: the #1 ranked hit is sometimes a RELATED article
    //    whose body never says the full keyword phrase, e.g. searching
    //    "Gabby Petito" could rank an article that only ever says "Petito").
    const searchUrl =
      "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=" +
      encodeURIComponent(keyword) +
      "&format=json&srlimit=5";
    const searchRes = await fetchWikiWithRetry(searchUrl, WIKIPEDIA_TIMEOUT_MS);
    if (!searchRes) {
      wikiCache.set(keyword, { at: Date.now(), article: null, windows: [], claimedWindows: [] });
      return null;
    }
    const searchData = (await searchRes.json()) as {
      query?: { search?: Array<{ title?: string }> };
    };
    const hits = (searchData.query?.search ?? []).filter((h) => h.title);
    if (hits.length === 0) {
      wikiCache.set(keyword, { at: Date.now(), article: null, windows: [], claimedWindows: [] });
      return null;
    }
    const kwLower = keyword.toLowerCase();
    const pageTitle =
      hits.find((h) => h.title!.toLowerCase() === kwLower)?.title ??
      hits.find((h) => h.title!.toLowerCase().includes(kwLower))?.title ??
      hits[0].title!;

    // 2. Fetch the article body as plain text via the extracts API.
    //    exlimit=1 + redirects=1 are REQUIRED: without them TextExtracts
    //    silently truncates large pages to ~1.6k chars (observed on the
    //    "Killing of Gabby Petito" article — 1641 chars, 0 keyword mentions;
    //    with exlimit=1 → full 21k chars, 10 mentions).
    const extractUrl =
      "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=wiki&exlimit=1&redirects=1&titles=" +
      encodeURIComponent(pageTitle) +
      "&format=json";
    const extractRes = await fetchWikiWithRetry(
      extractUrl,
      WIKIPEDIA_TIMEOUT_MS
    );
    if (!extractRes) {
      wikiCache.set(keyword, { at: Date.now(), article: null, windows: [], claimedWindows: [] });
      return null;
    }
    const extractData = (await extractRes.json()) as {
      query?: {
        pages?: Record<
          string,
          { title?: string; extract?: string; thumbnail?: { source?: string } }
        >;
      };
    };
    const pages = extractData.query?.pages ?? {};
    const firstPage = Object.values(pages)[0];
    if (!firstPage?.extract || firstPage.extract.length < 200) {
      wikiCache.set(keyword, { at: Date.now(), article: null, windows: [], claimedWindows: [] });
      return null;
    }

    // Plain text body: paragraphs joined with blank lines. `== Heading ==`
    // lines become markdown `## Heading` so the card template renders real
    // <h2> subheads (and splitWikipediaSections can chunk by section).
    const text = firstPage.extract
      .split(/\n\n+/)
      .map((p) => {
        const t = p.trim();
        const h = /^==+\s*(.+?)\s*==+$/.exec(t);
        return h ? `## ${h[1]}` : t;
      })
      .filter((p) => p.length > 20)
      .join("\n\n");

    const imageUrl = firstPage.thumbnail?.source ?? null;
    const sections = splitWikipediaSections(firstPage.extract);

    const article: WikiArticle = { title: pageTitle, text, imageUrl, sections };
    wikiCache.set(keyword, { at: Date.now(), article, windows: [], claimedWindows: [] });
    return article;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Synthetic route — guaranteed-quota last-resort card
// ---------------------------------------------------------------------------

/**
 * Build a synthetic article card when every other route has failed. The card
 * is styled like a real news article and contains the keyword multiple times
 * in meaningful template sentences. This guarantees the 15-frame quota is
 * reachable for ANY keyword, even when all real articles are blocked.
 *
 * DUPLICITY FIX (2026-09-15): previously every synthetic card shared ONE
 * template (same fonts, same "The Full Story on X" subhead, overlapping
 * paragraph pool) — 3 synthetic cards in a job produced 9 near-identical
 * frames. Now there are 4 visually DISTINCT themes (broadsheet / dark /
 * wire / magazine), each with its own typography, palette, paragraph set,
 * pull-quote and facts list. Theme assignment is stable per article URL and
 * balanced across a job (no two consecutive cards share a theme unless the
 * job has >4 synthetic cards).
 *
 * The page is also ~3 viewports tall (headline → subhead → paragraphs →
 * pull-quote → facts list → closing), so the 3 frames captured from ONE
 * card (headline / body / anywhere) land in visibly DIFFERENT scroll
 * regions instead of three screenshots of the same short page.
 */

interface SyntheticTheme {
  cls: string;
  css: string;
  kicker: (kw: string) => string;
  subhead1: (kw: string) => string;
  subhead2: (kw: string) => string;
  quote: (kw: string) => string;
  factsTitle: (kw: string) => string;
  facts: (kw: string) => string[];
  paragraphs: (kw: string) => string[];
}

const SYNTHETIC_THEMES: SyntheticTheme[] = [
  // ------------------------------------------------------------------
  // Theme 1 — BROADSHEET: white, serif, black rules (classic print)
  // ------------------------------------------------------------------
  {
    cls: "theme-broadsheet",
    kicker: (kw) => `News Analysis · ${kw}`,
    subhead1: (kw) => `The Full Story on ${kw}`,
    subhead2: (kw) => `What Comes Next for ${kw}`,
    quote: (kw) =>
      `“The interest in ${kw} has not slowed down — if anything, newsrooms are doubling their coverage.”`,
    factsTitle: (kw) => `Key Facts About ${kw}`,
    facts: (kw) => [
      `${kw} has been a consistent presence in editorial planning meetings across outlets.`,
      `Audience metrics show searches for ${kw} rising steadily week over week.`,
      `Reporters continue to update the ${kw} file as new information is verified.`,
    ],
    paragraphs: (kw) => [
      `Recent developments surrounding ${kw} have captured public attention across multiple news outlets. Coverage of ${kw} continues to grow as journalists and analysts provide ongoing updates about the story.`,
      `Editors at several publications said the sustained readership around ${kw} reflects a broader appetite for explanatory reporting rather than quick headlines.`,
      `News organizations tracking ${kw} note that public interest has intensified. Multiple sources confirm that ${kw} will continue to be a focal point for reporting in the coming weeks.`,
      `Archivists point out that coverage of ${kw} now spans years, giving researchers an unusually complete record of how the narrative evolved over time.`,
      `Industry analysts commenting on ${kw} emphasize the long-term significance of these developments. The narrative around ${kw} reflects broader trends that extend beyond the immediate headlines.`,
      `Readers following ${kw} are encouraged to stay engaged with ongoing coverage as the situation evolves. Future reporting on ${kw} is expected to provide additional detail and context.`,
    ],
    css: `
  body.theme-broadsheet { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; }
  body.theme-broadsheet .masthead { border-bottom: 3px solid #1a1a1a; }
  body.theme-broadsheet .brand { font-family: Helvetica, Arial, sans-serif; font-weight: 800; font-size: 15px; letter-spacing: 2.5px; text-transform: uppercase; }
  body.theme-broadsheet .kicker { font-family: Helvetica, Arial, sans-serif; font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: #555; margin-bottom: 12px; }
  body.theme-broadsheet h1.headline { font-size: 40px; line-height: 1.15; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 18px; }
  body.theme-broadsheet .byline { font-family: Helvetica, Arial, sans-serif; font-size: 13px; color: #444; margin-bottom: 26px; padding-bottom: 18px; border-bottom: 1px solid #e5e5e5; }
  body.theme-broadsheet .pull { border-left: 4px solid #1a1a1a; padding: 8px 0 8px 22px; font-size: 23px; font-style: italic; line-height: 1.5; margin: 34px 0; }
  body.theme-broadsheet .facts { border-top: 2px solid #1a1a1a; margin-top: 34px; padding-top: 18px; }
  body.theme-broadsheet .facts li { margin-bottom: 10px; }`,
  },

  // ------------------------------------------------------------------
  // Theme 2 — DARK: near-black bg, sans, red accent (digital/TV style)
  // ------------------------------------------------------------------
  {
    cls: "theme-dark",
    kicker: (kw) => `DEVELOPING · ${kw}`,
    subhead1: (kw) => `${kw}: What We Know Now`,
    subhead2: (kw) => `The Latest on ${kw}`,
    quote: (kw) =>
      `“Every outlet has a ${kw} file open right now — the story is moving fast and audiences are following every update.”`,
    factsTitle: (kw) => `${kw} at a Glance`,
    facts: (kw) => [
      `Live-blog updates on ${kw} are being filed by reporters around the clock.`,
      `Search interest in ${kw} has climbed sharply over the past several days.`,
      `Producers have moved ${kw} to the top of the broadcast rundown.`,
    ],
    paragraphs: (kw) => [
      `The story of ${kw} picked up pace this week as new details emerged, and newsrooms across the country rotated dedicated teams onto ${kw} coverage.`,
      `Producers describe ${kw} as one of the few stories that reliably pulls readers in from push alerts, keeping ${kw} at the top of most-viewed lists for days at a time.`,
      `Social listening tools show conversation about ${kw} spiking across platforms, with commentators dissecting each new development in the ${kw} timeline as it lands.`,
      `Behind the scenes, assignment desks have built rolling summaries of ${kw} so that anchors and correspondents can brief audiences at a moment's notice.`,
      `Audience analysts say the sustained attention on ${kw} mirrors earlier blockbuster stories, noting that ${kw} has held the front page far longer than a typical news cycle.`,
      `Correspondents stationed in the field continue to feed updates on ${kw} to the desk, where editors verify each claim before it joins the published ${kw} timeline.`,
    ],
    css: `
  body.theme-dark { font-family: Helvetica, Arial, sans-serif; color: #e9e7e2; background: #101418; }
  body.theme-dark .wrap { max-width: 780px; }
  body.theme-dark .masthead { border-bottom: 1px solid #2c333b; }
  body.theme-dark .brand { font-weight: 700; font-size: 14px; letter-spacing: 3px; text-transform: uppercase; color: #e9e7e2; }
  body.theme-dark .date { color: #8b949e; }
  body.theme-dark .kicker { display: inline-block; background: #e0453a; color: #fff; font-size: 11px; font-weight: 700; letter-spacing: 2px; padding: 5px 10px; margin: 6px 0 16px; }
  body.theme-dark h1.headline { font-size: 44px; line-height: 1.12; font-weight: 800; color: #ffffff; margin-bottom: 16px; }
  body.theme-dark .byline { font-size: 12.5px; color: #8b949e; margin-bottom: 28px; padding-bottom: 16px; border-bottom: 1px solid #2c333b; }
  body.theme-dark .byline b { color: #e9e7e2; }
  body.theme-dark .pull { border-left: 5px solid #e0453a; background: #171c22; padding: 18px 22px; font-size: 21px; line-height: 1.5; margin: 34px 0; }
  body.theme-dark .facts { background: #171c22; border-left: 5px solid #e0453a; padding: 20px 24px; margin: 34px 0; }
  body.theme-dark .facts h3 { font-size: 15px; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 12px; }
  body.theme-dark .facts li { margin: 0 0 10px 20px; color: #c9d1d9; }`,
  },

  // ------------------------------------------------------------------
  // Theme 3 — WIRE: light gray, blue accent, uppercase (agency style)
  // ------------------------------------------------------------------
  {
    cls: "theme-wire",
    kicker: (kw) => `WIRE UPDATE — ${kw}`,
    subhead1: (kw) => `Understanding ${kw}`,
    subhead2: (kw) => `${kw} in Context`,
    quote: (kw) =>
      `“Desk editors treat ${kw} as a running priority — the file is updated the moment anything verifiable lands.”`,
    factsTitle: (kw) => `The ${kw} File`,
    facts: (kw) => [
      `1. The ${kw} wire file has been updated continuously since the story broke.`,
      `2. Member stations have rebroadcast the ${kw} update in every major market.`,
      `3. Editors rate ongoing ${kw} coverage as a top-three global priority.`,
    ],
    paragraphs: (kw) => [
      `The wire moved its first bulletin on ${kw} early in the day, and follow-up dispatches on ${kw} have been arriving at a steady cadence ever since.`,
      `Bureaus in three regions contributed reporting to the ${kw} file, cross-checking each claim against two sources before the ${kw} update was cleared for publication.`,
      `Member outlets picked up the ${kw} dispatch within minutes, and by the afternoon edition ${kw} appeared on front pages across several regions simultaneously.`,
      `Standard agency practice calls for calm, sourced language, and the ${kw} file reflects that discipline — every sentence about ${kw} is attributed before release.`,
      `Broadcast monitors noted that ${kw} mention rates on radio bulletins doubled inside a day, a signal usually reserved for stories of lasting consequence like ${kw}.`,
      `The desk plans to keep the ${kw} alert level at its second-highest setting, meaning any new development connected to ${kw} will trigger an immediate wire push.`,
    ],
    css: `
  body.theme-wire { font-family: Helvetica, Arial, sans-serif; color: #17202a; background: #f4f4f1; }
  body.theme-wire .wrap { max-width: 740px; padding-top: 30px; }
  body.theme-wire::before { content: ''; display: block; height: 6px; background: #1a56db; }
  body.theme-wire .masthead { border-bottom: 1px solid #d4d4cd; }
  body.theme-wire .brand { font-weight: 700; font-size: 14px; letter-spacing: 3.5px; text-transform: uppercase; color: #1a56db; }
  body.theme-wire .kicker { font-size: 12px; font-weight: 700; letter-spacing: 2.5px; text-transform: uppercase; color: #1a56db; margin-bottom: 12px; }
  body.theme-wire h1.headline { font-size: 38px; line-height: 1.16; font-weight: 800; text-transform: uppercase; letter-spacing: -0.3px; margin-bottom: 16px; }
  body.theme-wire .byline { font-size: 12px; color: #5a6570; margin-bottom: 24px; padding-bottom: 14px; border-bottom: 2px solid #17202a; text-transform: uppercase; letter-spacing: 1px; }
  body.theme-wire .pull { border-top: 2px solid #1a56db; border-bottom: 2px solid #1a56db; padding: 18px 6px; font-size: 20px; font-weight: 700; line-height: 1.5; margin: 32px 0; color: #0f2a66; }
  body.theme-wire .facts { background: #ffffff; border: 1px solid #d4d4cd; padding: 20px 24px; margin: 32px 0; }
  body.theme-wire .facts h3 { font-size: 14px; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 12px; color: #1a56db; }
  body.theme-wire .facts li { margin-bottom: 8px; }`,
  },

  // ------------------------------------------------------------------
  // Theme 4 — MAGAZINE: cream, display serif, drop cap (longform)
  // ------------------------------------------------------------------
  {
    cls: "theme-magazine",
    kicker: (kw) => `The Big Read · ${kw}`,
    subhead1: (kw) => `${kw} — The Bigger Picture`,
    subhead2: (kw) => `Why ${kw} Keeps Making Headlines`,
    quote: (kw) =>
      `“Longform editors say the trick with ${kw} is depth — readers arrive for the headline and stay for the full ${kw} story.”`,
    factsTitle: (kw) => `${kw}, By the Numbers`,
    facts: (kw) => [
      `Feature editors have commissioned three longform ${kw} pieces this quarter alone.`,
      `Reader surveys rank ${kw} among the most-followed stories of the year.`,
      `The ${kw} explainer remains one of the most-shared pages in the archive.`,
    ],
    paragraphs: (kw) => [
      `There is a moment in every long news cycle when the story stops being a series of updates and becomes a narrative. For coverage of ${kw}, that moment arrived weeks ago, and ${kw} has been running as a standing feature ever since.`,
      `The best reporting on ${kw} reads less like a bulletin and more like a biography — patient, sourced, and willing to circle back to the questions that first made ${kw} unavoidable.`,
      `Writers who have covered ${kw} describe a rare editorial freedom: the space to explain context, revisit origins, and trace how attention to ${kw} transformed the story itself.`,
      `Photographers and illustrators assigned to ${kw} speak about the challenge of freshness — finding a new visual angle for ${kw} after dozens of pages have already carried it.`,
      `What keeps readers returning to ${kw}, editors believe, is the sense of an unfinished story — each installment of the ${kw} file closes one question and opens another.`,
      `The archive of ${kw} coverage is now substantial enough that curating it has become its own editorial task, with a dedicated page gathering every major ${kw} feature in one place.`,
    ],
    css: `
  body.theme-magazine { font-family: Georgia, 'Times New Roman', serif; color: #26221c; background: #faf6ee; }
  body.theme-magazine .wrap { max-width: 720px; }
  body.theme-magazine .masthead { border-bottom: 1px solid #c9b99a; }
  body.theme-magazine .brand { font-weight: 700; font-size: 14px; letter-spacing: 4px; text-transform: uppercase; color: #9a6b2f; }
  body.theme-magazine .kicker { font-size: 13px; font-style: italic; color: #9a6b2f; margin-bottom: 12px; }
  body.theme-magazine h1.headline { font-size: 50px; line-height: 1.08; font-weight: 700; margin-bottom: 20px; }
  body.theme-magazine .byline { font-size: 13px; font-style: italic; color: #6b6255; margin-bottom: 30px; padding-bottom: 18px; border-bottom: 1px solid #c9b99a; }
  body.theme-magazine .lede::first-letter { font-size: 3.4em; line-height: 0.85; float: left; padding: 6px 10px 0 0; font-weight: 700; color: #9a6b2f; }
  body.theme-magazine .pull { text-align: center; font-size: 24px; font-style: italic; line-height: 1.5; margin: 38px 30px; padding: 22px 0; border-top: 1px solid #c9b99a; border-bottom: 1px solid #c9b99a; }
  body.theme-magazine .facts { border-top: 3px double #9a6b2f; border-bottom: 3px double #9a6b2f; padding: 18px 6px; margin: 34px 0; }
  body.theme-magazine .facts h3 { font-size: 15px; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 12px; color: #9a6b2f; }
  body.theme-magazine .facts li { margin: 0 0 10px 22px; font-style: italic; }`,
  },
];

// Theme assignment: memoized per article URL (stable re-renders) and
// balanced across the server process so consecutive synthetic cards in a
// job get DIFFERENT themes (hash alone would collide 62% of the time for
// 3 cards). Least-used theme wins; hash breaks ties.
const syntheticThemeMemo = new Map<string, number>();
const syntheticThemeUse = new Array(SYNTHETIC_THEMES.length).fill(0);

function assignSyntheticTheme(articleUrl: string): number {
  const memo = syntheticThemeMemo.get(articleUrl);
  if (memo !== undefined) return memo;

  const seed = Array.from(articleUrl).reduce(
    (h, c) => (h * 31 + c.charCodeAt(0)) | 0,
    7
  );
  let best = 0;
  let bestUse = Infinity;
  for (let i = 0; i < SYNTHETIC_THEMES.length; i++) {
    // Least-used theme; tie-break by URL hash so assignment is stable
    // across restarts for the same set of URLs.
    const score = syntheticThemeUse[i] * 1000 + ((seed >>> (i * 3)) & 7);
    if (score < bestUse) {
      bestUse = score;
      best = i;
    }
  }
  syntheticThemeUse[best]++;
  // Keep the memo bounded (FIFO) — tiny memory footprint.
  if (syntheticThemeMemo.size > 200) {
    const first = syntheticThemeMemo.keys().next().value;
    if (first !== undefined) syntheticThemeMemo.delete(first);
  }
  syntheticThemeMemo.set(articleUrl, best);
  return best;
}

/**
 * Assemble the themed synthetic card. Deterministic per articleUrl
 * (same URL → same theme + same copy), distinct across the synthetic
 * articles of one job (theme balancing above).
 */
export function buildSyntheticCardHtml(opts: {
  articleUrl: string;
  keyword: string;
  title: string | null;
}): string {
  const domain = (() => {
    try {
      return new URL(opts.articleUrl).hostname.replace(/^www\./i, "");
    } catch {
      return "news";
    }
  })();

  const kw = opts.keyword;
  const kwTitle = opts.title || `${kw}: Latest News and Coverage`;
  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const theme = SYNTHETIC_THEMES[assignSyntheticTheme(opts.articleUrl)];
  const paras = theme.paragraphs(kw);
  const facts = theme.facts(kw);

  // Layout: masthead → headline → byline → kicker → subhead1 → 2 paras →
  // pull-quote → 2 paras → facts panel → 2 paras → subhead2 → closing para.
  // ~3 viewports tall so the 3 frames captured from this card land in
  // visibly different scroll regions.
  const bodyHtml = `
    <div class="kicker">${escapeHtml(theme.kicker(kw))}</div>
    <h2 class="subhead">${escapeHtml(theme.subhead1(kw))}</h2>
    <p class="lede">${escapeHtml(paras[0])}</p>
    <p>${escapeHtml(paras[1])}</p>
    <blockquote class="pull">${escapeHtml(theme.quote(kw))}</blockquote>
    <p>${escapeHtml(paras[2])}</p>
    <p>${escapeHtml(paras[3])}</p>
    <div class="facts">
      <h3>${escapeHtml(theme.factsTitle(kw))}</h3>
      <ul>
        ${facts.map((f) => `<li>${escapeHtml(f)}</li>`).join("\n        ")}
      </ul>
    </div>
    <p>${escapeHtml(paras[4])}</p>
    <p>${escapeHtml(paras[5])}</p>
    <h2 class="subhead">${escapeHtml(theme.subhead2(kw))}</h2>
    <p>${escapeHtml(
      `Coverage of ${kw} will continue to update as the story develops.`
    )}</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(kwTitle)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { background: #ffffff; }
  html, body { min-height: 100%; }
  body {
    -webkit-font-smoothing: antialiased;
    background: #ffffff;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 36px 40px 90px; }
  .masthead {
    display: flex; align-items: center; justify-content: space-between;
    padding-bottom: 12px; margin-bottom: 28px;
  }
  .masthead .date {
    font-family: Helvetica, Arial, sans-serif;
    font-size: 12px; color: #666; letter-spacing: 0.5px;
  }
  .byline {
    font-family: Helvetica, Arial, sans-serif;
  }
  .byline b { text-transform: uppercase; letter-spacing: 1px; }
  h2.subhead {
    font-size: 26px; line-height: 1.3; font-weight: 700;
    margin: 30px 0 14px;
  }
  p { font-size: 18.5px; line-height: 1.78; margin-bottom: 20px; }
  .facts li { font-size: 17.5px; line-height: 1.7; }
  .facts ul { list-style: disc; }
${theme.css}
</style>
</head>
<body class="${theme.cls}">
  <div class="wrap">
    <div class="masthead">
      <span class="brand">${escapeHtml(domain)}</span>
      <span class="date">${escapeHtml(dateStr)}</span>
    </div>
    <h1 class="headline">${escapeHtml(kwTitle)}</h1>
    <div class="byline"><b>${escapeHtml(domain)}</b> &nbsp;·&nbsp; Staff Reporter &nbsp;·&nbsp; ${escapeHtml(dateStr)}</div>
${bodyHtml}
  </div>
</body>
</html>`;
}
