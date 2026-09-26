// Article renderer — stealth-render a news article URL and verify it's usable.
//
// What "usable" means for V1:
// 1. Page loaded (HTTP 200, no navigation error)
// 2. Not on a known "blocked" page (Access Denied, 403, Are you a robot, etc.)
// 3. Has substantial body text (>= 500 chars across <p>, <li>, <blockquote>)
// 4. Not behind a hard paywall (heuristic check)
// 5. (Optional) If keyword is provided, discovers all keyword occurrences
//    and returns them in RenderResult.keywordDiscover for the caller to use
//    in frame selection (Step 5) and screenshot capture (Step 6).
//
// For Google News RSS URLs: navigating triggers a JS redirect that lands on
// the publisher's actual article URL. We follow it naturally and capture
// the final URL.
//
// What this function does NOT do:
// - Highlighting (Step 5 will use the discovery data; Step 6 will re-render
//   with highlight + take screenshot)
// - Screenshot capture (Step 6)
// - Save any files to disk
//
// Caller is responsible for managing the BrowserContext (one context per job,
// new page per article).

import type { Page, BrowserContext } from "playwright";
import os from "os";
import { cleanupOverlays } from "./cleanup";
import {
  discoverKeywordOccurrences,
  selectFrames,
  type DiscoverResult,
  type FrameSelection,
  type KeywordOccurrence,
} from "./discover";
import {
  captureCenteredScreenshot,
  occurrenceToLocator,
  type ScreenshotResult,
  type ScreenshotOptions,
} from "./screenshot";
import { validateFrameImage } from "./validate";
import {
  buildArchiveTodayUrl,
  buildArticleCardHtml,
  buildSyntheticCardHtml,
  buildGoogleCacheUrl,
  buildOpenGraphCardHtml,
  buildRedditCardHtml,
  claimWikipediaWindow,
  fetchViaReader,
  fetchWikipediaArticle,
  fetchOpenGraphData,
  fetchRedditSummary,
  findWaybackSnapshot,
  isFallbackEligibleSkipReason,
  saveToWayback,
  ARCHIVE_TODAY_TOOLBAR_SELECTORS,
  WAYBACK_TOOLBAR_SELECTORS,
  type CaptureRoute,
} from "./routes";

const NAV_TIMEOUT_MS = 30_000; // 30s — Google News redirect + article load
const WAYBACK_TIMEOUT_MS = 45_000; // wayback replays can be slow
const ARCHIVE_TODAY_TIMEOUT_MS = 30_000;
const READER_SETCONTENT_TIMEOUT_MS = 20_000;
const POST_LOAD_WAIT_MS = 3_000; // Let lazy content / overlays settle
const MIN_BODY_TEXT_LENGTH = 500; // Min chars in <p>+<li>+<blockquote>

// MEMORY-AWARE LADDER THRESHOLDS (OOM protection).
// The server has 3.9GB RAM and no swap. Wayback/archive replays are the
// HEAVIEST rungs (full publisher page replay with all resources). When free
// memory drops below HEAVY_ROUTE_MIN_FREE_MB, those rungs are skipped and
// the ladder falls through to the lighter reader/wikipedia/synthetic rungs
// (which render self-contained HTML — no heavy page loads at all).
// With RECYCLE_MIN_FREE_MB the caller (capture route) can also recycle the
// whole browser to reclaim leaked renderer memory.
export const HEAVY_ROUTE_MIN_FREE_MB = 700;
export const RECYCLE_MIN_FREE_MB = 600;

/** Free system memory in MB (best-effort; 0 on failure → treated as low). */
export function freeMemMB(): number {
  try {
    return Math.floor(os.freemem() / 1024 / 1024);
  } catch {
    return 0;
  }
}

// Strings that indicate a blocked / non-article page.
// Checked ONLY against <title> and <h1> (the most prominent indicators).
// These phrases almost never appear in legitimate article headlines.
const BLOCK_SIGNALS_IN_HEAD = [
  "access denied",
  "403 forbidden",
  "403 error",
  "404",
  "404 error",
  "not found",
  "are you a robot",
  "are you human",
  "captcha",
  "unusual traffic",
  "automated queries",
  "forbidden",
  "request blocked",
  "you have been blocked",
  "cloudflare",
  "incapsula",
  "akamai",
  "ddos protection",
  "rate limit",
  "verify you are a human",
  "checking your browser",
  "just a moment",
  "attention required",
  "performance & security by cloudflare",
  "human verification",
  "bot protection",
  "500 internal server error",
  "502 bad gateway",
  "503 service unavailable",
  "error",
  "access to this site",
  "denied access",
];

// More specific phrases that are safe to check in body text head too.
// These only appear on challenge/block pages, never in legitimate articles.
const BLOCK_SIGNALS_IN_BODY = [
  "are you a robot",
  "are you human",
  "please verify you are a human",
  "checking your browser before accessing",
  "performance & security by cloudflare",
  "ray id:",
  "just a moment...",
  "automated queries from google",
];

// Selectors that, if present and visible, indicate a hard paywall.
const PAYWALL_SELECTORS = [
  ".paywall",
  "#paywall",
  ".paywall-container",
  ".paywall-overlay",
  ".subscribe-to-read",
  ".subscription-required",
  "#metered-content",
  ".metered-content",
  ".leaky-paywall",
  ".piano-article-paywall",
  ".tp-article-paywall",
  ".tp-active",
  ".subscribe-cta",
  ".subscription-modal",
];

// Phrases in visible body text that indicate paywall.
const PAYWALL_PHRASES = [
  "subscribe to continue reading",
  "subscribe to read more",
  "subscribe now to read",
  "subscribers only",
  "subscription required",
  "this article is for subscribers",
  "to continue reading, subscribe",
  "you have reached your free article limit",
  "free articles this month",
  "create a free account to continue",
  "sign in to continue reading",
  "register to continue reading",
];

export type RenderOutcome = "accepted" | "skipped" | "failed";

export interface RenderResult {
  outcome: RenderOutcome;
  finalUrl: string;
  title: string | null;
  bodyTextLength: number;
  bodyTextSnippet: string;
  skipReason: string | null;
  cleanupClickedButtons: string[];
  durationMs: number;
  // Only populated when keyword was provided AND outcome === "accepted"
  keywordDiscover?: DiscoverResult;
  // Only populated when keywordDiscover meets the ≥4 visible + ≥1 heading +
  // ≥1 body requirements. The caller should check `frameSelection` first;
  // if it's null, the article should be skipped (insufficient keyword).
  // The selection includes the Wikipedia infobox-aware body choice when
  // the URL is a Wikipedia article.
  frameSelection?: FrameSelection | null;
  // Only populated when captureScreenshots=true was passed AND frameSelection
  // is non-null. Contains 3 captured screenshots (headline/body/anywhere)
  // with image buffers + metadata (centerX, centerY, zoomFactor, wasClamped).
  capturedFrames?: CapturedFrame[];
  // Only populated when extraFrameRequest was passed AND frameSelection is
  // non-null. Contains 0..maxCount captured screenshots with
  // positionType="extra", drawn from occurrences NOT in usedOccurrenceIds.
  // Used by Pass 2 backfill in the capture route to fill empty slots left
  // by other articles that failed Gate 3 validation.
  capturedExtraFrames?: CapturedFrame[];
  // Which route of the fallback ladder produced this result:
  //   direct  → live publisher site
  //   wayback → web.archive.org snapshot
  //   archive → archive.today snapshot
  //   reader  → r.jina.ai text rendered into the article-card template
  // Populated on ALL outcomes (so the caller can persist it per article).
  routeUsed?: CaptureRoute;
}

export interface RenderOptions {
  // If provided, the renderer will discover all keyword occurrences after
  // accepting the article and return them in RenderResult.keywordDiscover.
  keyword?: string;
  // If true AND keyword is provided, also capture the 3 screenshots during
  // render (avoids a second page load). Default false (caller can capture
  // later via a separate step).
  captureScreenshots?: boolean;
  // Optional screenshot options (zoom, dimensions). Only used when
  // captureScreenshots=true or extraFrameRequest is set.
  screenshotOpts?: ScreenshotOptions;
  // If set AND keyword is provided, the renderer will ALSO capture up to
  // `maxCount` EXTRA frames from this article, skipping any occurrence
  // whose ID is in `usedOccurrenceIds` (i.e., occurrences already used by
  // this article's existing 3 frames).
  //
  // Use case: Pass 2 backfill. After Pass 1, some articles have <3 valid
  // frames (Gate 3 rejected all candidates for a position). Pass 2 walks
  // accepted articles and asks each to donate extra frames until all empty
  // slots are filled (or all articles are exhausted).
  //
  // Independent of captureScreenshots — you can request extras without
  // re-capturing the standard 3.
  extraFrameRequest?: {
    usedOccurrenceIds: number[];
    maxCount: number;
  };
  // Fallback-ladder control:
  //   "auto"       (default) — direct → wayback → archive.today → reader → wikipedia → synthetic
  //   "direct"     — direct route only (no fallback)
  //   "reader"     — reader route only (used by the synthetic fill pass, which
  //                  pre-selected this route for blocked/paywalled articles)
  //   "wikipedia"  — wikipedia route only
  //   "synthetic"  — synthetic card only
  routeHint?: "auto" | "direct" | "reader" | "wikipedia" | "synthetic";

  // For the synthetic route: the article title (from RSS) to display.
  // Optional — when omitted, a generic "Keyword: Latest News" title is used.
  articleTitle?: string | null;

  // Which Wikipedia SECTION chunk this article should render. The capture
  // route assigns 0, 1, 2, ... to successive wikipedia-accepted articles in
  // the same job, so each renders a DIFFERENT section of the same Wikipedia
  // page (distinct frames instead of N copies of one page). Article URLs
  // carry the assignment as a #wiki-sec-N fragment for stable re-renders.
  wikipediaSection?: number;
}

// One captured screenshot for one frame position.
export interface CapturedFrame {
  positionType: "headline" | "body" | "anywhere" | "extra";
  // The occurrence index in the DiscoverResult.occurrences array (0-based).
  // Stored in DB as Frame.occurrenceIndex so we can re-identify the
  // occurrence if needed (e.g., for re-capture).
  occurrenceIndex: number;
  // PNG image buffer (1920×1080 after Sharp upscale).
  imageBuffer: Buffer;
  // Metadata from the screenshot capture.
  centerX: number;
  centerY: number;
  zoomFactor: number;
  wasClamped: boolean;
}

/**
 * Render a single article URL through Playwright, using the FALLBACK LADDER.
 *
 * Tier A fix for "all websites blocked": if the direct render fails for a
 * reachability reason (bot-block, paywall, timeout), the SAME article is
 * re-routed through independent mirrors until one renders:
 *
 *     direct → wayback → archive.today → reader
 *
 * The mirror pages are verified and captured with the EXACT same checks and
 * keyword pipeline as the direct route (block signals, paywall heuristics,
 * discovery, frame selection, Gate 3 validation) — the pipeline is not
 * distorted, it just has more ways to obtain the article.
 *
 * @param context - The stealth BrowserContext to use
 * @param url     - The URL to render (Google News redirect URL or direct URL)
 * @param opts    - Optional: keyword, screenshot options, routeHint
 * @returns RenderResult with outcome and metadata (routeUsed set)
 */
export async function renderArticle(
  context: BrowserContext,
  url: string,
  opts: RenderOptions = {}
): Promise<RenderResult> {
  // ALL FALLBACKS REMOVED (2026-09-26):
  // Only direct rendering of authentic news articles and blogs.
  // No Google Cache, Wayback, Archive, Reader, OpenGraph, Reddit,
  // Wikipedia, or Synthetic. If a URL doesn't load directly, it's skipped.

  const ladder: CaptureRoute[] = ["direct"];

  // The canonical publisher URL — refined after the direct attempt resolves
  // Google News redirects, so mirror routes target the REAL article.
  let publisherUrl = url;
  let lastResult: RenderResult | null = null;

  for (const route of ladder) {
    // MEMORY-AWARE LADDER: skip the HEAVY rungs (wayback/archive full-page
    // replays) when free memory is low. The ladder falls through to the
    // lighter rungs (reader/wikipedia/synthetic render self-contained HTML
    // with no heavy page loads), so quota completion still succeeds — just
    // via a cheaper path. This prevents the OOM-kill failure mode where a
    // heavy replay balloons Chromium until the kernel kills the server.
    if (
      (route === "wayback" || route === "archive") &&
      freeMemMB() < HEAVY_ROUTE_MIN_FREE_MB
    ) {
      console.warn(
        `[render] low memory (${freeMemMB()}MB < ${HEAVY_ROUTE_MIN_FREE_MB}MB) — skipping heavy '${route}' rung for ${url.slice(0, 70)}`
      );
      continue;
    }

    // direct keeps the original URL (may be a Google News redirect);
    // mirror routes always use the resolved publisher URL.
    const target = route === "direct" ? url : publisherUrl;
    if (!target || !/^https?:\/\//i.test(target)) continue;

    // CRASH GUARD: a renderer crash ("Target crashed" — monster pages can
    // OOM Chromium's tab process) THROWS out of the rung. Without this
    // guard the throw aborts the whole ladder (and previously hung or
    // killed the worker). Instead: log, treat as a failed rung, and fall
    // through to the next — lighter — rung (reader/wikipedia/synthetic
    // render self-contained HTML and cannot crash this way).
    let result: RenderResult;
    try {
      result = await renderViaRoute(context, route, target, opts);
    } catch (rungErr) {
      const msg = rungErr instanceof Error ? rungErr.message : String(rungErr);
      // Whole-browser death: the renderer crash can take the browser
      // process down with it. Every further Playwright call on this
      // context will fail — abandon the ladder and let the caller recycle.
      if (/has been closed|Target crashed|Target closed/i.test(msg)) {
        console.warn(
          `[render] browser died during '${route}' for ${url.slice(0, 70)} — abandoning ladder`
        );
        return makeFailedResult(
          target,
          `browser_dead:${route}:${msg.slice(0, 60)}`,
          Date.now()
        );
      }
      console.warn(
        `[render] route '${route}' threw for ${url.slice(0, 70)}: ${msg.slice(0, 120)} — trying next rung`
      );
      result = makeFailedResult(target, `route_error:${route}:${msg.slice(0, 60)}`, Date.now());
    }
    result.routeUsed = route;
    lastResult = result;

    // Browser died mid-rung (thrown error swallowed above into skipReason)?
    // Stop the ladder — no rung can run on a dead browser.
    if (result.skipReason?.startsWith("browser_dead:")) {
      return result;
    }

    if (result.outcome === "accepted") {
      if (route !== "direct") {
        console.log(
          `[render] article rescued via '${route}' route: ${result.finalUrl.slice(0, 90)}`
        );
      }
      return result;
    }

    // Track the resolved publisher URL for mirror routes. Ignore mirror
    // domains and unresolved Google News URLs.
    if (
      result.finalUrl &&
      /^https?:\/\//i.test(result.finalUrl) &&
      !/web\.archive\.org|archive\.(ph|today|is|li)|news\.google\.com/i.test(
        result.finalUrl
      )
    ) {
      publisherUrl = result.finalUrl;
    }

    // After DIRECT: only re-route when the failure is about REACHING or
    // READING the page (blocked/paywall/timeout). Content problems like
    // insufficient_keyword can't be fixed by any mirror.
    // After mirror routes: always try the next rung.
    if (route === "direct" && !isFallbackEligibleSkipReason(result.skipReason)) {
      return result;
    }
  }

  return (
    lastResult ?? {
      outcome: "failed",
      finalUrl: url,
      title: null,
      bodyTextLength: 0,
      bodyTextSnippet: "",
      skipReason: "ladder_exhausted",
      cleanupClickedButtons: [],
      durationMs: 0,
    }
  );
}

/** Build a failed RenderResult quickly. */
function makeFailedResult(
  url: string,
  skipReason: string,
  start: number,
  title: string | null = null
): RenderResult {
  return {
    outcome: "failed",
    finalUrl: url,
    title,
    bodyTextLength: 0,
    bodyTextSnippet: "",
    skipReason,
    cleanupClickedButtons: [],
    durationMs: Date.now() - start,
  };
}

/**
 * Render via ONE specific route. Opens its own page (closed on exit).
 *   - direct  : navigate to the target URL (may be a Google News redirect)
 *   - wayback : find (or create) a web.archive.org snapshot, navigate it
 *   - archive : navigate to the archive.today newest snapshot
 *   - reader  : fetch text via r.jina.ai, render into the article-card
 *               template with setContent (no navigation at all)
 * All routes converge on verifyAndCapture() for checks + keyword capture.
 */
async function renderViaRoute(
  context: BrowserContext,
  route: CaptureRoute,
  target: string,
  opts: RenderOptions
): Promise<RenderResult> {
  if (route === "reader") {
    const page = await context.newPage();
    try {
      return await renderReaderPage(page, target, opts);
    } finally {
      await page.close().catch(() => {});
    }
  }

  if (route === "wikipedia") {
    const page = await context.newPage();
    try {
      return await renderWikipediaPage(page, target, opts);
    } finally {
      await page.close().catch(() => {});
    }
  }

  if (route === "synthetic") {
    const page = await context.newPage();
    try {
      return await renderSyntheticPage(page, target, opts);
    } finally {
      await page.close().catch(() => {});
    }
  }

  if (route === "opengraph") {
    const page = await context.newPage();
    try {
      return await renderOpenGraphCard(page, target, opts);
    } finally {
      await page.close().catch(() => {});
    }
  }

  if (route === "reddit") {
    const page = await context.newPage();
    try {
      return await renderRedditCard(page, target, opts);
    } finally {
      await page.close().catch(() => {});
    }
  }

  const start = Date.now();
  const page = await context.newPage();

  try {
    // --- Route-specific navigation target ---
    let navUrl = target;
    if (route === "googlecache") {
      navUrl = buildGoogleCacheUrl(target);
    } else if (route === "wayback") {
      let snap = await findWaybackSnapshot(target);
      if (!snap) {
        // Nothing archived yet — ask the Wayback Machine to archive it now
        // (anonymous Save Page Now, best-effort, time-capped).
        console.log(
          `[render] wayback: no snapshot for ${target.slice(0, 80)} — attempting Save Page Now`
        );
        snap = await saveToWayback(target);
      }
      if (!snap) {
        return makeFailedResult(target, "wayback:no_snapshot", start);
      }
      navUrl = snap.snapshotUrl;
    } else if (route === "archive") {
      navUrl = buildArchiveTodayUrl(target);
    }

    // --- Navigate ---
    const timeout =
      route === "wayback"
        ? WAYBACK_TIMEOUT_MS
        : route === "archive"
        ? ARCHIVE_TODAY_TIMEOUT_MS
        : route === "googlecache"
        ? 20_000 // Google Cache is lighter than Wayback
        : NAV_TIMEOUT_MS;

    let navigationOk = false;
    let navigationError: string | null = null;
    try {
      await page.goto(navUrl, {
        waitUntil: "domcontentloaded",
        timeout,
      });
      navigationOk = true;
    } catch (e) {
      navigationError = e instanceof Error ? e.message : String(e);
    }

    if (!navigationOk) {
      const isTimeout = navigationError?.toLowerCase().includes("timeout");
      return makeFailedResult(
        target,
        isTimeout ? "navigation_timeout" : `navigation_error:${(navigationError ?? "unknown").slice(0, 80)}`,
        start
      );
    }

    // --- Settle + cleanup ---
    await page.waitForTimeout(POST_LOAD_WAIT_MS).catch(() => {});
    const cleanup = await cleanupOverlays(page);

    // Remove archiver toolbars (Wayback / archive.today chrome) so they can
    // never appear in frames. Pure DOM removal — no pixel analysis.
    const toolbarSelectors =
      route === "wayback"
        ? WAYBACK_TOOLBAR_SELECTORS
        : route === "archive"
        ? ARCHIVE_TODAY_TOOLBAR_SELECTORS
        : null;
    if (toolbarSelectors) {
      await page
        .evaluate(`((sels) => {
          for (const sel of sels) {
            try {
              document.querySelectorAll(sel).forEach((el) => el.remove());
            } catch (e) {}
          }
        })(${JSON.stringify(toolbarSelectors)})`)
        .catch(() => {});
    }

    // finalUrl semantics:
    //   direct  → page.url() — PRESERVES V1 BEHAVIOR: the Google News JS
    //             redirect lands on the publisher and page.url() reports the
    //             RESOLVED article URL (callers store it; the ladder uses it
    //             as the mirror target; the scoreboard keys the publisher).
    //   wayback/archive → the publisher target (NOT the mirror URL) so the
    //             canonical article URL is what gets stored.
    const finalUrl = route === "direct" ? page.url() : target;
    const title = await page.title().catch(() => null);

    return await verifyAndCapture(page, finalUrl, opts, start, cleanup.clickedButtons, title);
  } finally {
    // Always close the page to free memory
    await page.close().catch(() => {});
  }
}

/**
 * Reader route: fetch the article's text through r.jina.ai (Jina fetches
 * with their own infrastructure — shrugs off most bot walls and paywalls),
 * then render it into our self-contained article-card template.
 */
async function renderReaderPage(
  page: Page,
  articleUrl: string,
  opts: RenderOptions
): Promise<RenderResult> {
  const start = Date.now();

  const reader = await fetchViaReader(articleUrl);
  if (!reader) {
    return makeFailedResult(articleUrl, "reader:no_text", start);
  }

  const html = buildArticleCardHtml({
    articleUrl,
    title: reader.title,
    markdownText: reader.text,
    imageUrl: reader.imageUrl,
  });

  try {
    await page.setContent(html, {
      waitUntil: "load",
      timeout: READER_SETCONTENT_TIMEOUT_MS,
    });
  } catch {
    // The template is self-contained; even if a lazy hero image hangs the
    // load event, the DOM is already parseable — try domcontentloaded, then
    // proceed regardless.
    await page
      .setContent(html, { waitUntil: "domcontentloaded", timeout: 8_000 })
      .catch(() => {});
  }

  await page.waitForTimeout(800).catch(() => {});
  const cleanup = await cleanupOverlays(page);

  return await verifyAndCapture(
    page,
    articleUrl,
    opts,
    start,
    cleanup.clickedButtons,
    reader.title
  );
}

/**
 * Wikipedia route: fetch the Wikipedia article for the KEYWORD via the
 * MediaWiki REST API (no scraping — official API, never blocked), then
 * render it through the article-card template. The keyword appears dozens
 * of times in a typical Wikipedia article, so discovery always finds
 * plenty of single-line occurrences.
 */
async function renderWikipediaPage(
  page: Page,
  target: string,
  opts: RenderOptions
): Promise<RenderResult> {
  const start = Date.now();
  const keyword = opts.keyword ?? "";
  if (!keyword) {
    return makeFailedResult("wikipedia://", "wikipedia:no_keyword", start);
  }

  const wiki = await fetchWikipediaArticle(keyword);
  if (!wiki) {
    return makeFailedResult(
      `wikipedia://${keyword}`,
      "wikipedia:no_article",
      start
    );
  }

  // Window assignment: a #wiki-sec-N fragment embedded in the target URL
  // pins the re-render to that exact window (stable for already-accepted
  // wikipedia articles). Fresh accepts CLAIM the next unclaimed window —
  // the per-job cursor lives in the routes.ts cache, so successive
  // wikipedia articles never render the same content.
  let fixedWindow: number | undefined;
  const fragMatch = /#wiki-sec-(\d+)/i.exec(target);
  if (fragMatch) fixedWindow = parseInt(fragMatch[1], 10);

  const win = claimWikipediaWindow(
    keyword,
    wiki,
    opts.wikipediaSection ?? 0,
    fixedWindow
  );
  if (!win) {
    // Every window already claimed by earlier wikipedia accepts — let the
    // ladder fall through to the next rung instead of duplicating content.
    return makeFailedResult(
      `wikipedia://${keyword}`,
      "wikipedia:windows_exhausted",
      start
    );
  }

  const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(
    wiki.title.replace(/ /g, "_")
  )}#wiki-sec-${win.index}`;

  const html = buildArticleCardHtml({
    articleUrl: wikiUrl,
    title: wiki.title,
    markdownText: win.text,
    // Hero image only on the first window — later windows render text-only
    // cards (more visual variety between wikipedia-frame articles).
    imageUrl: win.index === 0 ? wiki.imageUrl : null,
  });

  try {
    await page.setContent(html, {
      waitUntil: "load",
      timeout: READER_SETCONTENT_TIMEOUT_MS,
    });
  } catch {
    await page
      .setContent(html, { waitUntil: "domcontentloaded", timeout: 8_000 })
      .catch(() => {});
  }

  await page.waitForTimeout(800).catch(() => {});
  const cleanup = await cleanupOverlays(page);

  return await verifyAndCapture(
    page,
    wikiUrl,
    opts,
    start,
    cleanup.clickedButtons,
    wiki.title
  );
}

/**
 * Synthetic route: render a self-contained article-card template that
 * contains the keyword multiple times in meaningful sentences. This is
 * the guaranteed-quota last resort — it always produces capturable
 * frames because we control the layout and the keyword's position.
 */
async function renderSyntheticPage(
  page: Page,
  articleUrl: string,
  opts: RenderOptions
): Promise<RenderResult> {
  const start = Date.now();
  const keyword = opts.keyword ?? "";
  if (!keyword) {
    return makeFailedResult(articleUrl, "synthetic:no_keyword", start);
  }

  const html = buildSyntheticCardHtml({
    articleUrl,
    keyword,
    title: opts.articleTitle ?? null,
  });

  try {
    await page.setContent(html, {
      waitUntil: "load",
      timeout: READER_SETCONTENT_TIMEOUT_MS,
    });
  } catch {
    await page
      .setContent(html, { waitUntil: "domcontentloaded", timeout: 8_000 })
      .catch(() => {});
  }

  await page.waitForTimeout(600).catch(() => {});
  const cleanup = await cleanupOverlays(page);

  return await verifyAndCapture(
    page,
    articleUrl,
    opts,
    start,
    cleanup.clickedButtons,
    opts.articleTitle ?? `${keyword}: Latest News and Coverage`
  );
}

/**
 * Open Graph card renderer — fetches OG meta tags from the article URL and
 * renders a beautiful magazine-style card. Works even when the article body
 * is paywalled/blocked, because meta tags are in the <head> and always
 * accessible.
 */
async function renderOpenGraphCard(
  page: Page,
  articleUrl: string,
  opts: RenderOptions
): Promise<RenderResult> {
  const start = Date.now();
  const keyword = opts.keyword ?? "";
  if (!keyword) {
    return makeFailedResult(articleUrl, "opengraph:no_keyword", start);
  }

  const og = await fetchOpenGraphData(articleUrl);
  if (!og) {
    return makeFailedResult(articleUrl, "opengraph:no_metadata", start);
  }

  const html = buildOpenGraphCardHtml({ articleUrl, keyword, og });

  try {
    await page.setContent(html, {
      waitUntil: "load",
      timeout: READER_SETCONTENT_TIMEOUT_MS,
    });
  } catch {
    await page
      .setContent(html, { waitUntil: "domcontentloaded", timeout: 8_000 })
      .catch(() => {});
  }

  await page.waitForTimeout(600).catch(() => {});
  const cleanup = await cleanupOverlays(page);

  return await verifyAndCapture(
    page,
    articleUrl,
    opts,
    start,
    cleanup.clickedButtons,
    og.title
  );
}

/**
 * Reddit card renderer — searches Reddit for a thread matching the article
 * and renders a beautiful card with the thread title + top comments.
 * Falls back gracefully if no Reddit thread is found.
 */
async function renderRedditCard(
  page: Page,
  articleUrl: string,
  opts: RenderOptions
): Promise<RenderResult> {
  const start = Date.now();
  const keyword = opts.keyword ?? "";
  if (!keyword) {
    return makeFailedResult(articleUrl, "reddit:no_keyword", start);
  }

  const summary = await fetchRedditSummary(articleUrl, keyword);
  if (!summary) {
    return makeFailedResult(articleUrl, "reddit:no_thread", start);
  }

  const html = buildRedditCardHtml({ articleUrl, keyword, summary });

  try {
    await page.setContent(html, {
      waitUntil: "load",
      timeout: READER_SETCONTENT_TIMEOUT_MS,
    });
  } catch {
    await page
      .setContent(html, { waitUntil: "domcontentloaded", timeout: 8_000 })
      .catch(() => {});
  }

  await page.waitForTimeout(600).catch(() => {});
  const cleanup = await cleanupOverlays(page);

  return await verifyAndCapture(
    page,
    articleUrl,
    opts,
    start,
    cleanup.clickedButtons,
    summary.title
  );
}

/**
 * Shared verification + keyword capture phase — IDENTICAL for every route.
 * (This is the original V1 verification logic, unchanged.)
 */
async function verifyAndCapture(
  page: Page,
  finalUrl: string,
  opts: RenderOptions,
  start: number,
  clickedButtons: string[],
  title: string | null
): Promise<RenderResult> {
  // 0. RUNAWAY PAGE GUARD (OOM protection).
  //    A pathological page (infinite-scroll feed, broken JS, archive replay
  //    glitch) can balloon Chromium's memory until the kernel OOM-kills the
  //    browser AND the Next.js server — this exact failure killed a previous
  //    job. Both checks are pure DOM reads (no pixel analysis):
  //      - nodeCount: total DOM elements. Healthy news articles: 1-5k.
  //        Runaway pages: 100k+. Threshold 60k is generous.
  //      - scrollHeight: pages taller than 120k px mean an infinite feed —
  //        capture-time scrolling + virtual padding would compound it.
  //    A skipped page falls through the ladder to the next rung (self-healing
  //    preserved) — and the next rung is always lighter than the runaway page.
  try {
    const guard = (await page.evaluate(`(() => {
      return {
        nodeCount: document.getElementsByTagName('*').length,
        scrollHeight: (document.documentElement && document.documentElement.scrollHeight) || 0,
      };
    })()`)) as { nodeCount: number; scrollHeight: number };

    const MAX_DOM_NODES = 60_000;
    const MAX_SCROLL_HEIGHT = 120_000;
    if (guard.nodeCount > MAX_DOM_NODES) {
      console.warn(
        `[render] runaway DOM guard: ${guard.nodeCount} nodes > ${MAX_DOM_NODES} — skipping ${finalUrl.slice(0, 80)}`
      );
      return {
        outcome: "skipped",
        finalUrl,
        title,
        bodyTextLength: 0,
        bodyTextSnippet: "",
        skipReason: `runaway_dom:${guard.nodeCount}_nodes`,
        cleanupClickedButtons: clickedButtons,
        durationMs: Date.now() - start,
      };
    }
    if (guard.scrollHeight > MAX_SCROLL_HEIGHT) {
      console.warn(
        `[render] runaway page guard: scrollHeight=${guard.scrollHeight} > ${MAX_SCROLL_HEIGHT} — skipping ${finalUrl.slice(0, 80)}`
      );
      return {
        outcome: "skipped",
        finalUrl,
        title,
        bodyTextLength: 0,
        bodyTextSnippet: "",
        skipReason: `runaway_page_height:${guard.scrollHeight}px`,
        cleanupClickedButtons: clickedButtons,
        durationMs: Date.now() - start,
      };
    }
  } catch {
    // Guard evaluation failed (detached frame etc.) — proceed normally.
  }

  // 1. Extract body text from main content containers
  //    NOTE: We pass the function as a string to page.evaluate() because
  //    tsx/esbuild wraps inline function expressions with a __name() helper
  //    for debugging — that helper isn't defined in the browser context and
  //    throws "ReferenceError: __name is not defined". String evaluation
  //    bypasses the transform entirely.
  interface PageBodyData {
    bodyText: string;
    bodyTextLength: number;
    bodyTextHead: string;
    pageTextHead: string;
    h1Text: string;
    paywallSelectorMatches: string[];
  }
  const bodyData = (await page.evaluate(`(() => {
      const getVisibleText = (selector) => {
        const els = Array.from(document.querySelectorAll(selector));
        const parts = [];
        for (const el of els) {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          if (Number(style.opacity) === 0) continue;
          if (parseFloat(style.fontSize) < 8) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          parts.push(el.textContent ?? '');
        }
        return parts.join('\\n');
      };

      const bodyText = [
        getVisibleText('p'),
        getVisibleText('li'),
        getVisibleText('blockquote'),
      ]
        .join('\\n')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();

      return {
        bodyText,
        bodyTextLength: bodyText.length,
        bodyTextHead: bodyText.slice(0, 2000),
        pageTextHead: (document.body && document.body.textContent ? document.body.textContent : '').slice(0, 2000),
        h1Text: Array.from(document.querySelectorAll('h1'))
          .map((h) => h.textContent || '')
          .join(' ')
          .slice(0, 500),
        paywallSelectorMatches: Array.from(
          document.querySelectorAll(
            '.paywall, #paywall, .paywall-container, .paywall-overlay, .subscribe-to-read, .subscription-required, #metered-content, .metered-content, .piano-article-paywall, .tp-article-paywall, .tp-active, .subscribe-cta'
          )
        )
          .filter((el) => {
            const style = window.getComputedStyle(el);
            if (style.display === 'none') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 50 && rect.height > 50;
          })
          .map((el) => el.className || el.id || 'anonymous-paywall')
          .slice(0, 3),
      };
    })()`) as PageBodyData);

  // 2. Check for block signals — split into head-only and body-safe lists
  const titleLower = (title ?? "").toLowerCase();
  const h1Lower = bodyData.h1Text.toLowerCase();
  const headHaystack = `${titleLower}\n${h1Lower}`;
  const bodyHaystack = bodyData.pageTextHead.toLowerCase();

  let matchedBlockSignal: string | null = null;
  for (const signal of BLOCK_SIGNALS_IN_HEAD) {
    if (headHaystack.includes(signal)) {
      matchedBlockSignal = signal;
      break;
    }
  }
  if (!matchedBlockSignal) {
    for (const signal of BLOCK_SIGNALS_IN_BODY) {
      if (bodyHaystack.includes(signal)) {
        matchedBlockSignal = signal;
        break;
      }
    }
  }

  if (matchedBlockSignal) {
    return {
      outcome: "skipped",
      finalUrl,
      title,
      bodyTextLength: bodyData.bodyTextLength,
      bodyTextSnippet: bodyData.bodyTextHead.slice(0, 200),
      skipReason: `blocked:${matchedBlockSignal}`,
      cleanupClickedButtons: clickedButtons,
      durationMs: Date.now() - start,
    };
  }

  // 3. Check for paywall signals
  const paywallPhraseMatch = PAYWALL_PHRASES.find((p) =>
    bodyData.bodyTextHead.toLowerCase().includes(p)
  );
  if (paywallPhraseMatch || bodyData.paywallSelectorMatches.length > 0) {
    return {
      outcome: "skipped",
      finalUrl,
      title,
      bodyTextLength: bodyData.bodyTextLength,
      bodyTextSnippet: bodyData.bodyTextHead.slice(0, 200),
      skipReason: paywallPhraseMatch
        ? `paywall:${paywallPhraseMatch.slice(0, 50)}`
        : `paywall_selector:${bodyData.paywallSelectorMatches[0]}`,
      cleanupClickedButtons: clickedButtons,
      durationMs: Date.now() - start,
    };
  }

  // 4. Check for sufficient body text
  if (bodyData.bodyTextLength < MIN_BODY_TEXT_LENGTH) {
    return {
      outcome: "skipped",
      finalUrl,
      title,
      bodyTextLength: bodyData.bodyTextLength,
      bodyTextSnippet: bodyData.bodyTextHead.slice(0, 200),
      skipReason: `insufficient_text:${bodyData.bodyTextLength}chars`,
      cleanupClickedButtons: clickedButtons,
      durationMs: Date.now() - start,
    };
  }

  // 5. All checks passed — accepted.
  //    If keyword was provided, discover all occurrences BEFORE closing the page,
  //    then immediately run selectFrames while the page is still alive (needed
  //    for Wikipedia infobox detection, which queries the DOM).
  let keywordDiscover: DiscoverResult | undefined;
  let frameSelection: FrameSelection | null = null;
  let capturedFrames: CapturedFrame[] | undefined;
  let capturedExtraFrames: CapturedFrame[] | undefined;
  if (opts.keyword && opts.keyword.length > 0) {
    try {
      keywordDiscover = await discoverKeywordOccurrences(page, opts.keyword);
      // Run frame selection inside renderArticle so the page is available
      // for Wikipedia infobox detection. selectFrames is now async.
      frameSelection = await selectFrames(keywordDiscover, {
        page,
        url: finalUrl,
      });

      // If captureScreenshots=true AND we have a valid frame selection,
      // capture all 3 screenshots NOW (while page is alive). This avoids
      // a second page load + re-render in a separate step.
      if (opts.captureScreenshots && frameSelection && keywordDiscover) {
        capturedFrames = await captureAllFrames(
          page,
          opts.keyword,
          frameSelection,
          opts.screenshotOpts
        );
      }

      // If extraFrameRequest is set, capture up to maxCount EXTRA frames
      // from occurrences not in usedOccurrenceIds. Used by Pass 2 backfill.
      if (opts.extraFrameRequest && frameSelection && keywordDiscover) {
        capturedExtraFrames = await captureExtraFrames(
          page,
          opts.keyword,
          frameSelection,
          opts.extraFrameRequest.usedOccurrenceIds,
          opts.extraFrameRequest.maxCount,
          opts.screenshotOpts
        );
      }
    } catch (e) {
      // Discovery failure shouldn't fail the whole render — just log and
      // return accepted without discovery data. The caller can decide
      // whether to skip the article.
      console.warn(
        `[render] keyword discovery failed for ${finalUrl}:`,
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  return {
    outcome: "accepted",
    finalUrl,
    title,
    bodyTextLength: bodyData.bodyTextLength,
    bodyTextSnippet: bodyData.bodyTextHead.slice(0, 200),
    skipReason: null,
    cleanupClickedButtons: clickedButtons,
    durationMs: Date.now() - start,
    keywordDiscover,
    frameSelection,
    capturedFrames,
    capturedExtraFrames,
  };
}

/**
 * Capture + validate ONE occurrence as a frame.
 *
 * Extracted from captureAllFrames so the backfill pass (captureExtraFrames)
 * can reuse the exact same capture + Gate 3 validation logic.
 *
 * Steps:
 *   1. Convert occurrence → OccurrenceLocator
 *   2. Call captureCenteredScreenshot() — produces 1920×1080 PNG
 *   3. Call validateFrameImage() — Gate 3 pixel-level validation
 *   4. Return CapturedFrame on pass, null on fail (with reason logged)
 */
async function captureAndValidateOne(
  page: Page,
  keyword: string,
  occurrence: KeywordOccurrence,
  positionType: "headline" | "body" | "anywhere" | "extra",
  screenshotOpts?: ScreenshotOptions,
  logLabel?: string
): Promise<CapturedFrame | null> {
  const gateG3 = screenshotOpts?.gateG3 !== false;
  try {
    const locator = occurrenceToLocator(keyword, occurrence);
    const result: ScreenshotResult = await captureCenteredScreenshot(
      page,
      locator,
      screenshotOpts
    );

    // Gate 3: pixel-level validation (skip when gateG3 is false)
    if (!gateG3) {
      // Gate 3 disabled — accept the frame without validation
      console.log(`[render] ${logLabel}: GATE 3 DISABLED — accepting frame without validation`);
      return {
        positionType,
        occurrenceIndex: occurrence.id,
        imageBuffer: result.imageBuffer,
        centerX: result.centerX,
        centerY: result.centerY,
        zoomFactor: result.zoomFactor,
        wasClamped: result.wasClamped,
      };
    }

    const validation = await validateFrameImage(result.imageBuffer);

    if (validation.pass) {
      return {
        positionType,
        occurrenceIndex: occurrence.id,
        imageBuffer: result.imageBuffer,
        centerX: result.centerX,
        centerY: result.centerY,
        zoomFactor: result.zoomFactor,
        wasClamped: result.wasClamped,
      };
    }

    console.warn(
      `[render] ${logLabel ?? positionType} FAILED validation: ${validation.reason} ` +
      `(quality=${occurrence.qualityScore}, clientRects=${occurrence.clientRectsCount})`
    );
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[render] ${logLabel ?? positionType} threw during capture:`,
      msg
    );
    // When Gate 3 is disabled, try a LAST RESORT capture: take a simple
    // viewport screenshot without centering/zoom. This ensures the user
    // gets frames even when the keyword can't be highlighted or scrolled to.
    if (!gateG3) {
      try {
        console.log(`[render] ${logLabel}: GATE 3 DISABLED — attempting last-resort viewport screenshot`);
        const buffer = await page.screenshot({ type: "png", timeout: 15000 });
        return {
          positionType,
          occurrenceIndex: occurrence.id,
          imageBuffer: buffer,
          centerX: 0,
          centerY: 0,
          zoomFactor: 1.0,
          wasClamped: true,
        };
      } catch (e2) {
        console.error(`[render] ${logLabel}: last-resort screenshot also failed:`, e2 instanceof Error ? e2.message : String(e2));
      }
    }
    return null;
  }
}

/**
 * Capture all 3 frame screenshots for one article, using the three-gate
 * validation pipeline.
 *
 * For each position (headline / body / anywhere):
 *   1. Iterate the ranked candidate pool (best quality first)
 *   2. For each candidate, call captureAndValidateOne()
 *   3. If validation passes → keep this frame, move to next position
 *   4. If validation fails → try the next candidate in the pool
 *   5. If all candidates fail → leave the frame empty (imagePath="" in DB;
 *      Pass 2 backfill in the capture route will try to fill it)
 *
 * This is the heart of the self-healing pipeline. Gate 1 + Gate 2 ensure
 * the FIRST candidate is usually the best; Gate 3 + retry ensure that even
 * if the first candidate produces a bad frame (blank / split keyword /
 * missing highlight), we automatically try the next-best candidate without
 * user intervention.
 *
 * Exported so the manual-capture route (bookmarklet submissions) can run
 * the exact same capture + validation on user-provided pages.
 */
export async function captureAllFrames(
  page: Page,
  keyword: string,
  selection: FrameSelection,
  screenshotOpts?: ScreenshotOptions
): Promise<CapturedFrame[]> {
  // Each position has its own ranked pool from Gate 2.
  const positions: Array<{
    positionType: "headline" | "body" | "anywhere";
    pool: KeywordOccurrence[];
  }> = [
    { positionType: "headline", pool: selection.headlinePool },
    { positionType: "body", pool: selection.bodyPool },
    { positionType: "anywhere", pool: selection.anywherePool },
  ];

  const captured: CapturedFrame[] = [];
  // Track occurrence IDs that have been SUCCESSFULLY CAPTURED across all
  // positions. When a position's first-choice candidate fails Gate 3 and we
  // fall back to the next candidate, that fallback occurrence must NOT be
  // re-used by a later position — otherwise we get duplicate frames (same
  // occurrence captured twice, identical image). The selection pools can
  // overlap (e.g., bodyPool and anywherePool both contain mid-tier body
  // occurrences), so this cross-position dedup is essential.
  const capturedOccurrenceIds = new Set<number>();

  for (const pos of positions) {
    let capturedThisPos: CapturedFrame | null = null;

    // SKIP GATE 3 RETRIES ON FIRST SUCCESS (optimized 2026-09-15):
    // Only try the top 3 candidates per position. If all 3 fail, the position
    // is left empty for Pass 2 backfill. Previously the pipeline tried ALL
    // candidates in the pool (sometimes 10+), wasting time on low-quality
    // occurrences that rarely pass Gate 3. The top 3 by qualityScore are
    // almost always sufficient.
    const MAX_CANDIDATES_PER_POSITION = 3;
    const poolToTry = pos.pool.slice(0, MAX_CANDIDATES_PER_POSITION);

    for (let candIdx = 0; candIdx < poolToTry.length; candIdx++) {
      const occurrence = poolToTry[candIdx];
      // Skip occurrences already captured by a previous position — prevents
      // duplicate frames when fallback picks an occurrence that's also in a
      // later position's pool.
      if (capturedOccurrenceIds.has(occurrence.id)) {
        continue;
      }
      const label = `${pos.positionType} candidate #${candIdx + 1}/${pos.pool.length}`;
      capturedThisPos = await captureAndValidateOne(
        page,
        keyword,
        occurrence,
        pos.positionType,
        screenshotOpts,
        label
      );
      if (capturedThisPos) {
        capturedOccurrenceIds.add(occurrence.id);
        if (candIdx > 0) {
          console.log(
            `[render] ${pos.positionType}: passed on candidate #${candIdx + 1}/${pos.pool.length} ` +
            `(quality=${occurrence.qualityScore}, clientRects=${occurrence.clientRectsCount})`
          );
        }
        break; // success — move to next position
      }
    }

    if (capturedThisPos) {
      captured.push(capturedThisPos);
    } else {
      console.error(
        `[render] ${pos.positionType}: ALL ${poolToTry.length} candidates failed — ` +
        `leaving frame empty (Pass 2 backfill will try to fill it)`
      );
    }
  }

  return captured;
}

/**
 * Capture EXTRA frames for an article, used by Pass 2 backfill to fill empty
 * slots left over from other articles that had failed Gate 3 validation.
 *
 * Strategy:
 *   - Build a UNIFIED candidate pool by merging headlinePool + bodyPool +
 *     anywherePool, deduplicating by occurrence ID.
 *   - Sort by qualityScore DESC (then by document order as tiebreaker).
 *   - Skip any occurrence whose ID is in `usedOccurrenceIds` (already used
 *     by this article's existing 3 frames).
 *   - Iterate the remaining pool, calling captureAndValidateOne() for each.
 *   - Stop when we have `maxCount` successful captures OR the pool is exhausted.
 *
 * The positionType for extra frames is "extra" — the assemble step doesn't
 * care about positionType, it just iterates Frame records with keep=true and
 * non-empty imagePath.
 *
 * @returns up to `maxCount` CapturedFrame objects with positionType="extra"
 */
export async function captureExtraFrames(
  page: Page,
  keyword: string,
  selection: FrameSelection,
  usedOccurrenceIds: number[],
  maxCount: number,
  screenshotOpts?: ScreenshotOptions
): Promise<CapturedFrame[]> {
  if (maxCount <= 0) return [];

  // Build a unified pool from all 3 position pools, deduped by occurrence ID.
  const seen = new Set<number>(usedOccurrenceIds);
  const unifiedPool: KeywordOccurrence[] = [];
  for (const occ of [
    ...selection.headlinePool,
    ...selection.bodyPool,
    ...selection.anywherePool,
  ]) {
    if (seen.has(occ.id)) continue;
    seen.add(occ.id);
    unifiedPool.push(occ);
  }

  // Sort by qualityScore DESC, then by document order (rect.y ASC) as tiebreaker.
  unifiedPool.sort((a, b) => {
    if (b.qualityScore !== a.qualityScore) {
      return b.qualityScore - a.qualityScore;
    }
    return a.rect.y - b.rect.y;
  });

  console.log(
    `[render] captureExtraFrames: ${unifiedPool.length} usable candidates ` +
    `(after excluding ${usedOccurrenceIds.length} already-used), want up to ${maxCount}`
  );

  const captured: CapturedFrame[] = [];
  for (let i = 0; i < unifiedPool.length && captured.length < maxCount; i++) {
    const occurrence = unifiedPool[i];
    const label = `extra candidate #${i + 1}/${unifiedPool.length}`;
    const result = await captureAndValidateOne(
      page,
      keyword,
      occurrence,
      "extra",
      screenshotOpts,
      label
    );
    if (result) {
      captured.push(result);
      console.log(
        `[render] extra frame ${captured.length}/${maxCount}: passed on candidate #${i + 1} ` +
        `(quality=${occurrence.qualityScore}, clientRects=${occurrence.clientRectsCount})`
      );
    }
  }

  if (captured.length < maxCount) {
    console.warn(
      `[render] captureExtraFrames: only got ${captured.length}/${maxCount} — pool exhausted`
    );
  }

  return captured;
}
