// Centered screenshot capture for News Match Cut.
//
// Given a Playwright Page that has already rendered an article, this module:
// 1. Injects virtual padding (100vh top + bottom) so keywords near page edges
//    can still be centered in the crop (the padding is removed after capture)
// 2. Uses a locator (from the original discovery) to find a specific occurrence
// 3. Wraps that occurrence in <mark> with a yellow background
// 4. Computes a crop region centered on the keyword in DOCUMENT coordinates
// 5. Scrolls the viewport so the crop region is fully visible
// 6. Captures a full viewport screenshot (1920×1080) WITH the yellow highlight
// 7. Detects the yellow #FFFF00 centroid in the captured PNG (ground-truth
//    keyword position — immune to DOM measurement error)
// 8. Computes auto-zoom (highest zoom that keeps the crop inside the viewport,
//    fits the keyword with 20% margin, and makes the keyword ≥13% of frame width)
// 9. Extracts a SYMMETRIC crop around the yellow centroid from the HIGHLIGHTED
//    screenshot (the yellow highlight is INTENTIONALLY kept in the final frame
//    — it is the product's core visual feature: "the highlighted word stays
//    perfectly centered while the source changes")
// 10. Resizes the crop to exactly 1920×1080 via Sharp (lanczos3)
// 11. Removes the highlight + virtual padding (clean for next frame)
//
// Why virtual padding?
// - Without padding, a keyword at the top of the page (e.g., an <h1> headline)
//   can't be scrolled to the vertical center of the viewport — there's no
//   content above it to scroll past. The crop then gets clamped to y=0 and
//   the keyword ends up at the top of the screenshot instead of centered.
// - Injecting a 100vh-tall <div> at the start of <body> pushes the keyword
//   down by one viewport height, giving us enough document space above the
//   keyword to center it. A matching <div> at the end handles keywords near
//   the bottom of the page.
// - The padding divs are white and have no content, so they don't affect the
//   visual appearance of the article.
//
// CRITICAL: Why locator-based instead of index-based?
// - The original discoverKeywordOccurrences() runs discovery and returns
//   occurrences sorted by document position. Each occurrence gets an index.
// - If highlightOccurrence() re-runs discovery to find the occurrence by
//   index, the DOM might have changed between the two runs (lazy-loaded
//   content, collapsible sections, etc.). This causes the index to refer to
//   a DIFFERENT element, producing wrong screenshots.
// - The locator approach passes enough info (containerTag + containerText +
//   startOffsetInContainer) from the original discovery to uniquely identify
//   the occurrence in the current DOM. No re-discovery needed.
//
// IMPORTANT: Like discover.ts, we pass scripts to page.evaluate() as STRINGS
// to avoid the tsx/esbuild __name wrapper that doesn't exist in browser context.

import type { Page } from "playwright";
import sharp from "sharp";
import type { KeywordOccurrence } from "./discover";

/**
 * Race a promise against a hard timeout. Used for Playwright calls that
 * have NO built-in timeout (page.evaluate) — on a crashed renderer they
 * would otherwise hang forever and stall the whole capture worker.
 * The underlying promise is abandoned (never resolved) — safe because the
 * page/context is destroyed right after by the caller's error path.
 */
export function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`race_timeout_${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export interface ScreenshotOptions {
  // Keyword should fill this fraction of the frame width in the final image.
  // Default 0.13 = 13% of 1920px = ~250px.
  targetWidthRatio?: number;
  // Minimum zoom factor (1.0 = capture full 1920×1080, no upscale).
  minZoom?: number;
  // Maximum zoom factor (4.0 = capture 480×270, upscale 4x).
  maxZoom?: number;
  // Final output dimensions.
  frameWidth?: number;
  frameHeight?: number;
  // Gate settings — when false, skip the corresponding check
  gateG2?: boolean; // Frame selection checks (multi-line + tall-highlight)
  gateG3?: boolean; // Pixel validation (blank frame + yellow detection)
}

export interface ScreenshotResult {
  imageBuffer: Buffer;
  // Document-relative center of the keyword (in original CSS pixels, pre-zoom).
  centerX: number;
  centerY: number;
  // Applied zoom factor (frameWidth / cropWidth).
  zoomFactor: number;
  // True if crop rect was clamped because keyword was near a viewport edge.
  wasClamped: boolean;
  // The keyword's bounding rect in document coordinates (pre-zoom).
  occurrenceRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  // Post-capture centering diagnostics (keyword-anchor algorithm).
  // The keyword centroid in the captured PNG (viewport-relative, in px).
  // Equal to (960, 540) when centering is pixel-perfect.
  yellowCentroid?: {
    cx: number;
    cy: number;
    area: number;
    bbox: { x0: number; y0: number; x1: number; y1: number };
  };
  // Final crop rect used in the captured PNG (viewport-relative, in px).
  // After resize, this maps to (0,0)-(frameWidth, frameHeight).
  finalCropRect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  // Number of white pixels synthesized on each side because the centered
  // crop extended beyond the viewport. (0,0,0,0) when keyword is at viewport
  // center — the common case after horizontal reflow.
  whitePadding?: { left: number; top: number; right: number; bottom: number };
}

export interface HighlightResult {
  success: boolean;
  error?: string;
  rect?: {
    x: number;       // viewport-relative
    y: number;       // viewport-relative
    width: number;
    height: number;
    docX: number;    // document-relative
    docY: number;    // document-relative
  };
}

/**
 * A locator uniquely identifies a keyword occurrence in the DOM.
 * It's derived from the original discoverKeywordOccurrences() result and
 * passed to highlightOccurrence() so it can find the SAME occurrence without
 * re-running discovery.
 */
export interface OccurrenceLocator {
  keyword: string;
  containerTag: string;        // e.g., "h1", "p", "li", "div"
  containerText: string;       // first 200 chars of container textContent
  startOffsetInContainer: number; // position of keyword in container's concatenated text
  // Length of the ACTUAL matched text in the DOM (may differ from keyword
  // length when punctuation-insensitive matching is used, e.g. keyword
  // "spider man" matches "Spider-Man" — matchedLength=10, kwLen=9).
  // The highlight function uses this to create the correct-length Range.
  matchedLength?: number;
}

/**
 * Convert a KeywordOccurrence (from discover.ts) to an OccurrenceLocator.
 */
export function occurrenceToLocator(
  keyword: string,
  occurrence: KeywordOccurrence
): OccurrenceLocator {
  return {
    keyword,
    containerTag: occurrence.containerTag,
    containerText: occurrence.containerText,
    startOffsetInContainer: occurrence.startOffsetInContainer,
    matchedLength: occurrence.matchedLength,
  };
}

/**
 * Highlight a specific keyword occurrence in yellow, identified by a locator.
 *
 * The locator contains:
 *   - containerTag: the tag name of the leaf block (e.g., "h1", "p", "li")
 *   - containerText: first 200 chars of the container's textContent
 *   - startOffsetInContainer: position of the keyword in the container's
 *     concatenated text (across all child text nodes)
 *
 * Algorithm:
 *   1. Find all elements with the matching containerTag
 *   2. Filter to those whose textContent starts with containerText
 *   3. Walk the element's text nodes, concatenating their content
 *   4. Find the keyword at startOffsetInContainer
 *   5. Create a Range spanning the keyword (handles multi-node ranges)
 *   6. Wrap in <mark data-nmc-highlight> with yellow background
 *
 * Uses Range.extractContents() + insertNode() instead of surroundContents()
 * because surroundContents() throws for multi-node ranges.
 */
export async function highlightOccurrence(
  page: Page,
  locator: OccurrenceLocator
): Promise<HighlightResult> {
  const script = `
(() => {
  const keyword = ${JSON.stringify(locator.keyword)};
  const containerTag = ${JSON.stringify(locator.containerTag)};
  const containerText = ${JSON.stringify(locator.containerText)};
  const startOffsetInContainer = ${locator.startOffsetInContainer};
  const matchedLength = ${locator.matchedLength ?? 0};
  const kwLower = keyword.toLowerCase();
  const kwLen = kwLower.length;
  // Use matchedLength if provided (punctuation-free matching), else kwLen
  const highlightLen = matchedLength > 0 ? matchedLength : kwLen;

  // Punctuation-free keyword for verification (same algorithm as discover.ts)
  const kwNoPunct = kwLower.replace(/[^a-z0-9]/g, '');

  const SKIP_TAGS = new Set(['script', 'style', 'textarea', 'code', 'noscript', 'svg', 'iframe', 'select', 'button']);

  // 1. Find all elements with the matching containerTag
  const candidates = document.getElementsByTagName(containerTag);
  let targetContainer = null;

  for (const el of candidates) {
    // Skip if inside a SKIP_TAG ancestor
    let ancestor = el.parentElement;
    let skip = false;
    while (ancestor) {
      if (SKIP_TAGS.has(ancestor.tagName.toLowerCase())) { skip = true; break; }
      ancestor = ancestor.parentElement;
    }
    if (skip) continue;

    const text = el.textContent || '';
    if (text.length === 0) continue;

    // Match by first 200 chars of textContent
    if (text.slice(0, containerText.length) === containerText) {
      targetContainer = el;
      break;
    }
  }

  if (!targetContainer) {
    return { success: false, error: 'container_not_found' };
  }

  // 2. Walk text nodes, concatenating their content
  const walker = document.createTreeWalker(
    targetContainer,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const ptag = parent.tagName.toLowerCase();
        if (SKIP_TAGS.has(ptag)) return NodeFilter.FILTER_REJECT;
        if (!node.textContent || node.textContent.length === 0) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const textNodes = [];
  let tn;
  while ((tn = walker.nextNode())) {
    textNodes.push(tn);
  }
  if (textNodes.length === 0) {
    return { success: false, error: 'no_text_nodes' };
  }

  let fullText = '';
  const nodeMap = [];
  for (const t of textNodes) {
    nodeMap.push({ node: t, start: fullText.length, len: t.textContent.length });
    fullText += t.textContent;
  }

  // 3. Verify the keyword is at startOffsetInContainer
  //    Use punctuation-free verification: strip non-alphanumeric chars from
  //    both the keyword and the text at the offset, then compare.
  //    This handles "Spider-Man" matching keyword "spiderman" (hyphen within word)
  //    AND "Spider-Man: Brand New Day" matching "spider man brand new day".
  const fullLower = fullText.toLowerCase();
  const expectedEnd = startOffsetInContainer + highlightLen;
  const textAtOffset = fullLower.substr(startOffsetInContainer, highlightLen);
  const textAtOffsetNoPunct = textAtOffset.replace(/[^a-z0-9]/g, '');

  // Verify: the punctuation-free text at the offset matches the
  // punctuation-free keyword. Fallback: literal match (for old occurrence data).
  let verified = false;
  if (kwNoPunct.length > 0 && textAtOffsetNoPunct === kwNoPunct) {
    verified = true;
  }
  if (!verified && textAtOffset === kwLower) {
    verified = true;
  }
  if (!verified) {
    return {
      success: false,
      error: 'keyword_not_at_offset: expected keyword at ' + startOffsetInContainer +
             ', got=' + textAtOffset.substring(0, 80)
    };
  }

  // 4. Find start and end text nodes
  let startNodeInfo = null;
  let endNodeInfo = null;
  for (const nm of nodeMap) {
    if (!startNodeInfo && startOffsetInContainer >= nm.start && startOffsetInContainer < nm.start + nm.len) {
      startNodeInfo = nm;
    }
    if (expectedEnd > nm.start && expectedEnd <= nm.start + nm.len) {
      endNodeInfo = nm;
    }
    if (startNodeInfo && endNodeInfo) break;
  }

  if (!startNodeInfo || !endNodeInfo) {
    return { success: false, error: 'node_not_found' };
  }

  const startOffset = startOffsetInContainer - startNodeInfo.start;
  const endOffset = expectedEnd - endNodeInfo.start;

  // 5. Create Range and wrap in <mark>
  try {
    const range = document.createRange();
    range.setStart(startNodeInfo.node, startOffset);
    range.setEnd(endNodeInfo.node, endOffset);

    const mark = document.createElement('mark');
    mark.setAttribute('data-nmc-highlight', 'true');
    // Use setProperty with !important to override any article CSS rules
    // that might use !important (e.g., NDTV's "anywhere" occurrence had
    // the correct computed style but the background wasn't painted due to
    // a stylesheet !important rule overriding our inline style).
    mark.style.setProperty('background-color', '#FFFF00', 'important');
    mark.style.setProperty('color', '#000000', 'important');
    mark.style.setProperty('padding', '0', 'important');
    mark.style.setProperty('margin', '0', 'important');
    mark.style.setProperty('border-radius', '0', 'important');
    mark.style.setProperty('box-shadow', 'none', 'important');
    mark.style.setProperty('outline', 'none', 'important');

    const fragment = range.extractContents();
    mark.appendChild(fragment);
    range.insertNode(mark);

    const r = mark.getBoundingClientRect();
    return {
      success: true,
      rect: {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        docX: r.x + window.scrollX,
        docY: r.y + window.scrollY,
      },
    };
  } catch (e) {
    return { success: false, error: 'highlight_failed: ' + (e && e.message ? e.message : String(e)) };
  }
})()
`;

  const result = await page.evaluate(script);
  return result as HighlightResult;
}

/**
 * Remove all highlight <mark> elements added by highlightOccurrence.
 * Unwraps each <mark> by moving its children back to the parent, then
 * normalizes the parent to merge adjacent text nodes.
 */
export async function removeHighlight(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const marks = document.querySelectorAll('mark[data-nmc-highlight="true"]');
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
      if (parent.normalize) parent.normalize();
    });
  })()`);
}

/**
 * Normalize the keyword's rendered size by applying a CSS `transform: scale()`
 * to the mark's closest block-level container.
 *
 * PROBLEM (user-reported 2026-09-15 + 2026-09-16, keywords "Islam Makhachev" + "UFC"):
 *   Headline keywords are naturally large (600–1050px), producing frames where
 *   the keyword fills 30–55% of the frame. Body-text keywords are naturally
 *   small (~30px), and even at maxZoom=4.0 only reach ~130px — below the
 *   ~248px target for 9:16. Both directions produce inconsistent frame sizes.
 *
 * FIX (bidirectional, 2026-09-16):
 *   After highlighting, if the mark's width differs from the target by more
 *   than ±20%, apply `transform: scale(targetWidth / mark.width)` to the
 *   mark's closest block-level container. This works in BOTH directions:
 *     - scale < 1: shrinks large headlines down to target
 *     - scale > 1: upscales small body text up to target (capped at 8×)
 *   All keywords then render at ~targetKwWidth, producing consistent frames.
 *
 *   Upscale is capped at 8× (CSS transform is vector-based, so no pixelation).
 *   This allows even 30px body-text keywords to reach the ~248px target.
 *
 * WHY transform AND NOT font-size:
 *   - `font-size` on the mark would make the keyword smaller than the
 *     surrounding headline text — looks broken within a single frame.
 *   - `transform: scale()` on the container scales the ENTIRE container
 *     proportionally — keyword and surrounding text shrink together,
 *     keeping their relative sizes natural.
 *
 * WHY transform AND NOT document.body.zoom:
 *   - `zoom` is non-standard and affects the viewport coordinate system,
 *     which would break the autoZoom math that uses viewport dimensions.
 *   - `transform: scale()` is standard CSS, doesn't reflow layout, and
 *     `getBoundingClientRect()` correctly reflects the transformed size.
 *
 * LAYOUT SAFETY:
 *   - `transform` does NOT reflow — the container's document position
 *     stays the same; only the visual rendering shrinks (centered on the
 *     container's center via `transform-origin: center center`).
 *   - The mark's `getBoundingClientRect()` returns the post-transform rect,
 *     which is what the rest of the pipeline (autoZoom, scroll, crop) uses.
 *   - The transform is removed in the finally block by
 *     removeKeywordNormalization() — safe even if never applied.
 *
 * THRESHOLD:
 *   We normalize if the keyword width is outside ±20% of the target
 *   (i.e., below 0.8× or above 1.2× target). This avoids negligible
 *   transforms for keywords that are already close to the target width.
 *   Upscale is capped at 8× (vector-based, no pixelation).
 */
export async function normalizeKeywordSize(
  page: Page,
  opts: ScreenshotOptions = {}
): Promise<{
  normalized: boolean;
  scale?: number;
  newRect?: {
    x: number;
    y: number;
    width: number;
    height: number;
    docX: number;
    docY: number;
  };
  originalWidth?: number;
  reason?: string;
}> {
  const {
    targetWidthRatio = 0.13,
    frameWidth = 1920,
  } = opts;

  const targetKwWidth = frameWidth * targetWidthRatio;
  // Normalize in BOTH directions:
  //   - Shrink if keyword is >20% larger than target (scale < 1)
  //   - Upscale if keyword is >20% smaller than target (scale > 1)
  // This ensures ALL keywords render at ~targetKwWidth regardless of their
  // natural font size. Without upscaling, small body-text keywords stay small
  // even at maxZoom, producing inconsistent frame sizes.
  const SHRINK_THRESHOLD = targetKwWidth * 1.2;  // only shrink if above this
  const UPSCALE_THRESHOLD = targetKwWidth * 0.8;  // only upscale if below this

  const result = (await page.evaluate(`
    (() => {
      const mark = document.querySelector('mark[data-nmc-highlight="true"]');
      if (!mark) return { normalized: false, reason: 'mark_not_found' };

      const rect = mark.getBoundingClientRect();
      const width = rect.width;

      // Skip if within ±20% of target (already close enough)
      if (width <= ${SHRINK_THRESHOLD} && width >= ${UPSCALE_THRESHOLD}) {
        return { normalized: false, reason: 'within_target_range', width: width };
      }

      // Find the closest block-level container — the element whose font-size
      // determines the keyword's rendered size. We match the same container
      // tags that discover.ts uses for occurrence identification.
      const container = mark.closest('h1, h2, h3, h4, h5, h6, p, li, div, blockquote, article, section, td, th, dt, dd, figcaption, pre');
      if (!container || container === document.body || container === document.documentElement) {
        return { normalized: false, reason: 'no_suitable_container', width: width };
      }

      // Compute scale: <1 shrinks (keyword too big), >1 upscales (keyword too small)
      const scale = ${targetKwWidth} / width;
      if (scale >= 0.95 && scale <= 1.05) {
        return { normalized: false, reason: 'scale_too_close_to_1', width: width, scale };
      }

      // Cap the upscale at 8x. The target keyword width is ~248px (for 9:16),
      // and body-text keywords can be as small as 30px, requiring scale=8.3
      // to reach target. Allowing up to 8x ensures small body-text keywords
      // get upscaled close to the target, so autoZoom stays ~1.0 for ALL
      // frames — producing consistent zoom levels across the video.
      // (CSS transform scaling is vector-based, so even 8x doesn't pixelate
      // — the browser re-renders the text at the scaled size.)
      const cappedScale = Math.min(scale, 8.0);
      if (cappedScale < 0.95 || (cappedScale > 1.0 && cappedScale <= 1.05)) {
        return { normalized: false, reason: 'scale_capped_or_negligible', width: width, scale: cappedScale };
      }

      // Apply the transform. transform-origin: center center scales the
      // container's visual content around its own center — works for both
      // shrinking (scale < 1) and upscaling (scale > 1). The mark's
      // getBoundingClientRect() will reflect the new size and shifted position.
      container.style.transform = 'scale(' + cappedScale + ')';
      container.style.transformOrigin = 'center center';
      container.style.willChange = 'transform';
      container.setAttribute('data-nmc-normalized', 'true');

      // Re-measure the mark after the transform is applied
      const newRect = mark.getBoundingClientRect();
      const docX = newRect.x + window.scrollX;
      const docY = newRect.y + window.scrollY;

      return {
        normalized: true,
        scale: cappedScale,
        originalWidth: rect.width,
        newRect: {
          x: newRect.x,
          y: newRect.y,
          width: newRect.width,
          height: newRect.height,
          docX: docX,
          docY: docY,
        },
      };
    })()
  `)) as {
    normalized: boolean;
    scale?: number;
    originalWidth?: number;
    newRect?: {
      x: number;
      y: number;
      width: number;
      height: number;
      docX: number;
      docY: number;
    };
    reason?: string;
    width?: number;
  };

  if (result.normalized) {
    // Wait two animation frames for the transform to fully render before
    // any screenshot capture. The first rAF schedules the style recalc;
    // the second confirms it has been painted.
    await page
      .evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      .catch(() => {});
    return {
      normalized: true,
      scale: result.scale,
      originalWidth: result.originalWidth,
      newRect: result.newRect,
    };
  }

  return {
    normalized: false,
    originalWidth: result.width,
    reason: result.reason,
  };
}

/**
 * Remove the CSS transform applied by normalizeKeywordSize().
 * Safe to call even if no normalization was applied (no-op).
 *
 * This is called in the finally block of captureCenteredScreenshot() and
 * in early-exit error paths, alongside removeHighlight() and
 * removeVirtualPadding().
 */
export async function removeKeywordNormalization(page: Page): Promise<void> {
  await page.evaluate(`
    (() => {
      const normalized = document.querySelectorAll('[data-nmc-normalized="true"]');
      normalized.forEach((el) => {
        el.style.transform = '';
        el.style.transformOrigin = '';
        el.style.willChange = '';
        el.removeAttribute('data-nmc-normalized');
      });
    })()
  `).catch(() => {});
}

/**
 * Hide iframe and fixed-position overlay elements that would visually cover
 * the highlighted keyword in the screenshot.
 *
 * PROBLEM (observed on The Guardian, 2026-07-25):
 *   News sites often place ad/tracking <iframe> elements on top of article
 *   content. The <mark> highlight has the correct computed background-color
 *   (rgb(255, 255, 0)) and is "visible" per getComputedStyle(), but an iframe
 *   layered on top of it prevents the yellow pixels from reaching the
 *   screenshot. This caused detectYellowCentroid() to return null for 6/15
 *   frames in the Elon Musk job (all 3 Guardian frames + 1 each from NDTV,
 *   Fox News, Business Insider).
 *
 * SOLUTION:
 *   Before taking the screenshot, hide:
 *     1. All <iframe> elements that overlap with the <mark>'s bounding rect
 *     2. All elements with position:fixed that overlap with the <mark>
 *        (sticky headers, cookie banners, newsletter overlays, paywalls)
 *
 *   We hide only overlapping elements (not all iframes) to minimize layout
 *   disruption. Hidden elements are marked with data-nmc-hidden so they can
 *   be restored by restoreOverlays() if needed.
 *
 * SAFETY:
 *   - The keyword text is always in the main document, never inside an iframe
 *   - Hiding an iframe doesn't shift the article's text layout (iframes are
 *     either position:fixed/absolute, or inline embeds below the keyword)
 *   - If hiding an inline iframe shifts content, the post-capture yellow
 *     centroid detection automatically accounts for the new position
 */
export async function hideOverlays(page: Page): Promise<{ iframesHidden: number; fixedHidden: number; yellowChromeHidden: number }> {
  const result = await page.evaluate(`(() => {
  const mark = document.querySelector('mark[data-nmc-highlight="true"]');
  if (!mark) return { iframesHidden: 0, fixedHidden: 0, yellowChromeHidden: 0 };
  const markRect = mark.getBoundingClientRect();

  // Expand the mark rect by 10px on each side to catch overlays that
  // slightly overlap the edges (sub-pixel rendering, borders, etc.)
  const expanded = {
    left: markRect.left - 10,
    right: markRect.right + 10,
    top: markRect.top - 10,
    bottom: markRect.bottom + 10,
  };

  function overlaps(r) {
    return !(
      r.right < expanded.left ||
      r.left > expanded.right ||
      r.bottom < expanded.top ||
      r.top > expanded.bottom
    );
  }

  // Helper: check if an element's computed background-color is yellow-ish
  // (matches the same threshold as detectYellowCentroid: R>220, G>220, B<80).
  // This catches publisher UI chrome that uses yellow backgrounds — e.g.,
  // The Guardian's yellow circular hamburger menu button — which would
  // otherwise be detected as the keyword highlight by detectYellowCentroid().
  //
  // We parse the computed background-color which can be one of:
  //   "rgb(255, 255, 0)"            → opaque yellow
  //   "rgba(255, 255, 0, 1)"        → opaque yellow with alpha
  //   "rgb(255, 255, 0) !important" → with priority
  //   "transparent" / "rgba(0,0,0,0)" → no background (skip)
  function isYellowBackground(cs) {
    const bg = cs.backgroundColor;
    if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') return false;
    const m = bg.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/);
    if (!m) return false;
    const r = parseInt(m[1], 10);
    const g = parseInt(m[2], 10);
    const b = parseInt(m[3], 10);
    return r > 220 && g > 220 && b < 80;
  }

  // 1. Hide iframes that overlap with the mark
  let iframesHidden = 0;
  const iframes = document.querySelectorAll('iframe');
  for (const iframe of iframes) {
    const r = iframe.getBoundingClientRect();
    if (overlaps(r)) {
      iframe.setAttribute('data-nmc-hidden', 'true');
      iframe.style.setProperty('display', 'none', 'important');
      iframesHidden++;
    }
  }

  // 2. Hide position:fixed elements that overlap with the mark
  //    (EXCEPT the mark itself and its ancestors)
  let fixedHidden = 0;
  const allElements = document.querySelectorAll('*');
  for (const el of allElements) {
    if (el === mark || mark.contains(el) || (el.contains && el.contains(mark))) continue;
    const cs = window.getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (overlaps(r)) {
      el.setAttribute('data-nmc-hidden', 'true');
      el.style.setProperty('display', 'none', 'important');
      fixedHidden++;
    }
  }

  // 3. Hide ANY element (not just fixed/sticky) that:
  //    (a) is NOT the mark, an ancestor of the mark, or a descendant of the mark
  //    (b) has a yellow-ish computed background-color
  //    (c) is visible (non-zero size, not display:none)
  //
  //    This is DEFENSE IN DEPTH against publisher UI chrome that uses yellow
  //    backgrounds — e.g., The Guardian's hamburger menu button (a 156x156px
  //    yellow circle at the top of the page). Without this check, when the
  //    keyword highlight is missing or below the viewport, detectYellowCentroid()
  //    would find the publisher's yellow UI and incorrectly report a highlight
  //    position, causing Gate 3 to pass a corrupted frame.
  //
  //    This is a CSS-level check (getComputedStyle().backgroundColor), NOT
  //    pixel analysis — we read the element's declared style, not rendered
  //    pixels. It's fast because getComputedStyle is cached by the browser.
  //
  //    We skip elements inside the mark (descendants) because the mark's
  //    children may have inherited yellow-ish backgrounds from the mark.
  //    We skip the mark's ancestors because hiding them would hide the mark.
  let yellowChromeHidden = 0;
  for (const el of allElements) {
    // Skip the mark itself
    if (el === mark) continue;
    // Skip descendants of the mark (text/styled spans inside the highlight)
    if (mark.contains(el)) continue;
    // Skip ancestors of the mark (hiding them would hide the mark)
    if (el.contains && el.contains(mark)) continue;
    // Skip if already hidden above
    if (el.getAttribute && el.getAttribute('data-nmc-hidden') === 'true') continue;

    const cs = window.getComputedStyle(el);
    // Must be visible
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
    // Must have non-zero size
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // Must have yellow background
    if (!isYellowBackground(cs)) continue;

    // Hide it
    el.setAttribute('data-nmc-hidden', 'true');
    el.style.setProperty('display', 'none', 'important');
    yellowChromeHidden++;
  }

  return { iframesHidden, fixedHidden, yellowChromeHidden };
})()`);
  return result as { iframesHidden: number; fixedHidden: number; yellowChromeHidden: number };
}

/**
 * Restore elements hidden by hideOverlays(). Safe to call even if no elements
 * were hidden. Note: in the typical capture flow, we don't need to restore
 * because the page is closed after capture. This is provided for completeness.
 */
export async function restoreOverlays(page: Page): Promise<void> {
  await page.evaluate(`(() => {
  const hidden = document.querySelectorAll('[data-nmc-hidden="true"]');
  hidden.forEach((el) => {
    el.removeAttribute('data-nmc-hidden');
    // Remove only the inline display:none we added. If the element had a
    // pre-existing display style, we'd need to restore it — but we didn't
    // save it, so we just clear the inline style. This is fine because
    // we only set display:none on elements that were visible.
    if (el.style.display === 'none') {
      el.style.removeProperty('display');
    }
  });
})()`);
}

/**
 * Re-measure the highlighted keyword's viewport position.
 * Used after scrolling to get the current viewport-relative coordinates.
 */
async function measureHighlightedKeyword(page: Page): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
  docX: number;
  docY: number;
} | null> {
  const script = `(() => {
    const mark = document.querySelector('mark[data-nmc-highlight="true"]');
    if (!mark) return null;
    const r = mark.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      docX: r.x + window.scrollX,
      docY: r.y + window.scrollY,
    };
  })()`;
  return await page.evaluate(script);
}

/**
 * Compute the zoom factor based on the keyword's width.
 *
 * zoom = (frameWidth * targetWidthRatio) / keywordWidth
 * Clamped to [minZoom, maxZoom].
 *
 * This is the PRE-CAPTURE zoom — used to determine the initial scroll
 * position and viewport layout. The final zoom is computed POST-CAPTURE
 * by computeAutoZoom(), which takes into account the keyword's actual
 * position in the captured screenshot to avoid white padding.
 */
export function computeZoom(
  keywordWidth: number,
  opts: ScreenshotOptions = {}
): { zoom: number; wasClamped: boolean } {
  const {
    targetWidthRatio = 0.13,
    minZoom = 1.0,
    maxZoom = 4.0,
    frameWidth = 1920,
  } = opts;

  if (keywordWidth <= 0) {
    return { zoom: minZoom, wasClamped: true };
  }

  const targetKwWidth = frameWidth * targetWidthRatio;
  let zoom = targetKwWidth / keywordWidth;
  let wasClamped = false;

  if (zoom < minZoom) {
    zoom = minZoom;
    wasClamped = true;
  }
  if (zoom > maxZoom) {
    zoom = maxZoom;
    wasClamped = true;
  }

  return { zoom, wasClamped };
}

/**
 * Compute the POST-CAPTURE auto-zoom that avoids white padding while
 * fitting the keyword with a margin.
 *
 * This is the core of the keyword-anchor centering algorithm. After
 * capturing the viewport screenshot and detecting the yellow highlight's
 * centroid (cx, cy) and bounding box (kwW × kwH), we compute the zoom
 * that satisfies ALL of these constraints:
 *
 *   1. zoom >= minZoom                          (minimum zoom)
 *   2. zoom >= targetZoom                       (keyword at least
 *                                                targetWidthRatio of frame)
 *   3. zoom <= maxZoom                          (maximum zoom)
 *   4. zoom >= minZoomNoWhite                   (crop fits within viewport,
 *                                                no white padding needed)
 *   5. zoom <= maxZoomForKeywordFit             (keyword fits in crop with
 *                                                keywordMargin around it)
 *
 * Constraint (4) is the KEY innovation: by requiring the crop to fit
 * within the viewport (centered on the keyword), we NEVER need to
 * synthesize white pixels. The crop is always 100% real article content.
 *
 * Constraint (5) ensures the keyword isn't cut off: the crop must be at
 * least keywordMargin times the keyword's width (e.g., 1.2× = keyword
 * fills at most 83% of the crop, leaving 17% margin on the sides).
 *
 * If (4) and (5) conflict (the keyword is too wide to fit without white
 * padding — e.g., a very wide heading near the viewport edge), we
 * prioritize keyword fit (constraint 5) and accept white padding. This
 * is rare and only happens for heading-level keywords (>1000px wide).
 *
 * @returns { zoom, willHaveWhitePadding, ...diagnostics }
 */
export function computeAutoZoom(
  keywordWidth: number,
  centroidX: number,
  centroidY: number,
  srcWidth: number,
  srcHeight: number,
  opts: ScreenshotOptions = {}
): {
  zoom: number;
  willHaveWhitePadding: boolean;
  targetZoom: number;
  minZoomNoWhite: number;
  maxZoomForKeywordFit: number;
} {
  const {
    targetWidthRatio = 0.13,
    minZoom = 1.0,
    maxZoom = 4.0,
    frameWidth = 1920,
    frameHeight = 1080,
  } = opts;

  // The keyword margin: the crop must be at least this many times wider
  // than the keyword, ensuring the keyword isn't cut off and has some
  // surrounding context. 1.2 = keyword fills at most 83% of crop width.
  const KEYWORD_MARGIN = 1.2;

  // (2) Target zoom: keyword fills targetWidthRatio of frame width.
  //     This is the desired zoom — makes the keyword ~13% of frame width
  //     (or ~23% for 9:16/1:1, calibrated per aspect ratio).
  const targetZoom =
    keywordWidth > 0 ? (frameWidth * targetWidthRatio) / keywordWidth : minZoom;

  // (4) Min zoom to avoid white padding: crop must fit within the source,
  //     centered on the centroid. The max crop width is 2× the distance
  //     from the centroid to the nearest horizontal edge. The max crop
  //     height is 2× the distance to the nearest vertical edge.
  const maxCropWNoWhite = 2 * Math.min(centroidX, srcWidth - centroidX);
  const maxCropHNoWhite = 2 * Math.min(centroidY, srcHeight - centroidY);
  const maxCropWFromHeight = maxCropHNoWhite * (frameWidth / frameHeight);
  const maxCropW = Math.min(maxCropWNoWhite, maxCropWFromHeight);
  const minZoomNoWhite = maxCropW > 0 ? frameWidth / maxCropW : maxZoom;

  // (5) Max zoom for keyword fit: crop must be at least keywordMargin × kwW
  const minCropWForKeywordFit = keywordWidth * KEYWORD_MARGIN;
  const maxZoomForKeywordFit =
    minCropWForKeywordFit > 0
      ? frameWidth / minCropWForKeywordFit
      : maxZoom;

  // Combine constraints.
  //
  // ZOOM CONSISTENCY STRATEGY (revised 2026-09-16):
  //   The goal is for the keyword to fill ~targetWidthRatio of the frame
  //   in EVERY frame, regardless of whether it's a headline or body text.
  //   This is achieved by using targetZoom as the primary zoom value.
  //
  //   Constraints:
  //   1. zoom >= minZoom (1.0 — can't capture more than the viewport)
  //   2. zoom >= targetZoom (keyword must be at least target width)
  //      — but if targetZoom > maxZoom, the keyword can't reach target
  //        (it's too small), so we use maxZoom and accept a smaller keyword
  //   3. zoom <= maxZoom (4.0 — practical limit for quality)
  //   4. zoom <= maxZoomForKeywordFit (keyword must fit with margin)
  //   5. zoom >= minZoomNoWhite (avoid white padding) — PREFERRED but not
  //      required. If this conflicts with targetZoom, we accept white
  //      padding to maintain keyword size consistency.
  //
  //   The key insight: we PREFER targetZoom over minZoomNoWhite. This means
  //   a body-text keyword at 33px gets zoom=7.5 (target=248px/33px) even
  //   if that creates white padding — because consistent keyword size is
  //   more important than avoiding white padding.
  const minRequiredZoom = Math.max(minZoom, Math.min(targetZoom, maxZoom));
  const maxAllowedZoom = Math.min(maxZoom, maxZoomForKeywordFit);

  let zoom: number;
  let willHaveWhitePadding: boolean;

  if (minRequiredZoom <= maxAllowedZoom) {
    // Normal case: use targetZoom (capped by maxAllowedZoom).
    // This ensures the keyword fills ~targetWidthRatio of the frame.
    zoom = Math.min(minRequiredZoom, maxAllowedZoom);
    // If targetZoom > minZoomNoWhite, we'd have white padding
    willHaveWhitePadding = zoom < minZoomNoWhite;
  } else {
    // Conflict: keyword is too wide to fit with margin at minZoom.
    // Use the max allowed (keyword fit constraint wins).
    zoom = maxAllowedZoom;
    willHaveWhitePadding = zoom < minZoomNoWhite;
  }

  return {
    zoom,
    willHaveWhitePadding,
    targetZoom,
    minZoomNoWhite,
    maxZoomForKeywordFit,
  };
}

/**
 * Inject virtual padding (100vh divs at top + bottom of <body>) to allow
 * centering keywords that are near the top or bottom of the page.
 *
 * Without this padding, a keyword at the very top of the page (e.g., an <h1>
 * headline) cannot be scrolled to the vertical center of the viewport — there
 * is no content above it to scroll past. The crop then gets clamped to y=0
 * and the keyword ends up at the top of the screenshot instead of centered.
 *
 * The padding divs are white, full-width, and 100vh tall. They effectively
 * extend the document by one viewport height on each side, giving us space
 * to scroll the keyword into the viewport's vertical center.
 *
 * This is idempotent — calling it multiple times is safe (it checks for the
 * existence of the padding divs before inserting).
 */
export async function injectVirtualPadding(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    if (!document.getElementById('nmc-vpad-style')) {
      const style = document.createElement('style');
      style.id = 'nmc-vpad-style';
      style.textContent = [
        '#nmc-vpad-top, #nmc-vpad-bottom {',
        '  height: 100vh;',
        '  width: 100%;',
        '  background: #ffffff;',
        '  margin: 0;',
        '  padding: 0;',
        '  border: 0;',
        '  pointer-events: none;',
        '}',
      ].join('\\n');
      document.head.appendChild(style);
    }
    if (!document.getElementById('nmc-vpad-top')) {
      const pad = document.createElement('div');
      pad.id = 'nmc-vpad-top';
      document.body.insertBefore(pad, document.body.firstChild);
    }
    if (!document.getElementById('nmc-vpad-bottom')) {
      const pad = document.createElement('div');
      pad.id = 'nmc-vpad-bottom';
      document.body.appendChild(pad);
    }
  })()`);
}

/**
 * Remove the virtual padding divs and injected <style> added by
 * injectVirtualPadding(). Safe to call even if padding was never injected.
 */
export async function removeVirtualPadding(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const top = document.getElementById('nmc-vpad-top');
    if (top) top.remove();
    const bottom = document.getElementById('nmc-vpad-bottom');
    if (bottom) bottom.remove();
    const style = document.getElementById('nmc-vpad-style');
    if (style) style.remove();
  })()`);
}

// ---------------------------------------------------------------------------
// POST-CAPTURE KEYWORD-ANCHOR CENTERING (the "keyword-anchor" algorithm)
// ---------------------------------------------------------------------------
//
// PROBLEM (observed on the Khabib Nurmagomedov job, 2026-07-25):
//   The previous algorithm computed the crop rect from DOM measurements
//   (getBoundingClientRect on the <mark>), then clamped it to viewport
//   bounds. When zoom ≈ 1.0 (keyword width ≈ target ratio × frame width,
//   which is the COMMON case for 2-word keywords like "Khabib
//   Nurmagomedov"), cropWidth ≈ viewport width. The clamp becomes a
//   no-op and the keyword ends up at its natural viewport X position —
//   which is wherever the article's text column happens to place it.
//   Most news articles use a left-aligned or narrow column layout inside
//   a 1920px viewport, so the keyword lands 200-380px LEFT of center.
//
//   Measured drift on the Khabib job (15 frames):
//     X drift: mean -220px, max -379px, std 138px (11/15 frames > 100px off)
//     Y drift: mean +0.4px, max +11px, std 3.5px (vertical was already fine)
//
// SOLUTION:
//   After capturing the viewport screenshot, detect the yellow highlight
//   (#FFFF00) pixels in the PNG directly. Their centroid is the GROUND-
//   TRUTH keyword position — immune to DOM measurement error, sub-pixel
//   scroll rounding, race conditions between measure() and screenshot(),
//   and any layout shift introduced by the highlight <mark> itself.
//
//   Then compute a crop rect PERFECTLY SYMMETRIC around that centroid.
//   If the symmetric crop extends beyond the viewport (keyword near an
//   edge), synthesize white pixels on the missing side via Sharp's
//   `extend` operation. The result is mathematically pixel-perfect:
//
//     keyword_centroid  ==  crop_center  ==  frame_center  ==  (960, 540)
//
//   always, for every frame, regardless of article layout, font metrics,
//   line wrapping, or text length.
//
// WHY POST-CAPTURE (not pre-capture DOM measurement):
//   1. The PNG is the actual pixels that will end up in the video. There
//      is no "translation loss" between measurement and output.
//   2. Yellow #FFFF00 is a unique color in news articles — it doesn't
//      appear in normal text, images, or UI chrome. Template matching
//      is trivial and 100% reliable.
//   3. No DOM mutation needed (unlike the failed S6.5 horizontal
//      virtual-padding-wrapper approach, which distorted text and
//      produced white frames by disrupting article CSS layouts).
//
// TRADE-OFF:
//   When the keyword is far from viewport center AND zoom ≈ 1.0, the
//   symmetric crop extends beyond the viewport, producing a white margin
//   on one side of the frame. This is a deliberate trade-off: the keyword
//   is PERFECTLY centered, at the cost of a white strip on the side
//   opposite the keyword's natural position. The alternative (off-center
//   keyword, no white strip) is what the user rejected.
//
//   To minimize white margins, raise `minZoom` in ScreenshotOptions
//   (e.g., minZoom=1.5 → crop=1280px, white margin ≤ 55px for typical
//   news-article column positions; minZoom=2.0 → crop=960px, no white
//   margin for keywords in the viewport's middle 50%).
// -------------------------------------------------------------------------

/**
 * Detect the yellow highlight (#FFFF00) centroid in a PNG buffer.
 *
 * The highlight is painted by highlightOccurrence() as a <mark> with
 * background-color: #FFFF00. This function scans the raw PNG pixels and
 * returns the centroid (mean X, Y) of all yellow pixels — the ground-truth
 * keyword position in the screenshot.
 *
 * Yellow detection: R > 220, G > 220, B < 80. This matches #FFFF00 (255,
 * 255, 0) and nearby shades (anti-aliased box edges), but excludes:
 *   - Black text on top of the yellow (R<30, G<30, B<30)
 *   - White backgrounds (B > 80)
 *   - Normal colored content
 *
 * Performance: O(width × height). For 1920×1080, ~2M iterations, ~80ms
 * in Node.js. Acceptable for 15-frame jobs (~1.2s total).
 *
 * @returns { cx, cy, bbox, area } in screenshot pixel coords, or null if
 *          no yellow pixels found (e.g., highlight failed to render).
 */
export async function detectYellowCentroid(
  pngBuffer: Buffer
): Promise<{
  cx: number;
  cy: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  area: number;
} | null> {
  const { data, info } = await sharp(pngBuffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  // data is a Uint8Array of length width*height*channels.
  // channels = 3 (RGB) or 4 (RGBA). We only read R, G, B.

  let sumX = 0;
  let sumY = 0;
  let count = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * channels;
    for (let x = 0; x < width; x++) {
      const i = rowOffset + x * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // Yellow: high R, high G, low B
      if (r > 220 && g > 220 && b < 80) {
        sumX += x;
        sumY += y;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (count === 0) return null;
  return {
    cx: sumX / count,
    cy: sumY / count,
    bbox: {
      x0: minX,
      y0: minY,
      x1: maxX,
      y1: maxY,
    },
    area: count,
  };
}

/**
 * Extract a crop region centered on (centerX, centerY) from a source image,
 * with white pixel synthesis for any portion that extends beyond the source.
 *
 * Algorithm:
 *   1. Compute the ideal crop rect: centered on (centerX, centerY), with
 *      dimensions (cropW, cropH).
 *   2. Compute the intersection of this rect with the source image bounds.
 *   3. Sharp.extract() the intersection from the source.
 *   4. Sharp.extend() with white pixels on any side where the crop extended
 *      beyond the source.
 *   5. Sharp.resize() to (outW, outH) with lanczos3 for high-quality
 *      upscaling.
 *
 * The result is ALWAYS exactly (outW, outH), and (centerX, centerY) maps
 * to (outW/2, outH/2) in the output — pixel-perfect centering.
 *
 * @param srcBuffer  Source PNG buffer (the captured viewport screenshot)
 * @param centerX    X coordinate of the desired center, in source px
 * @param centerY    Y coordinate of the desired center, in source px
 * @param cropW      Desired crop width, in source px (before resize)
 * @param cropH      Desired crop height, in source px (before resize)
 * @param srcW       Source image width (for bounds computation)
 * @param srcH       Source image height (for bounds computation)
 * @param outW       Output image width (after resize)
 * @param outH       Output image height (after resize)
 * @returns { buffer, whitePadding, finalCropRect }
 */
export async function extractCenteredCrop(
  srcBuffer: Buffer,
  centerX: number,
  centerY: number,
  cropW: number,
  cropH: number,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number
): Promise<{
  buffer: Buffer;
  whitePadding: { left: number; top: number; right: number; bottom: number };
  finalCropRect: { x: number; y: number; width: number; height: number };
}> {
  // 1. Ideal crop rect (floating-point, centered on centroid)
  const idealX = centerX - cropW / 2;
  const idealY = centerY - cropH / 2;

  // 2. Intersection with source bounds [0, srcW] × [0, srcH]
  const ix0 = Math.max(0, Math.round(idealX));
  const iy0 = Math.max(0, Math.round(idealY));
  const ix1 = Math.min(srcW, Math.round(idealX + cropW));
  const iy1 = Math.min(srcH, Math.round(idealY + cropH));
  const iw = Math.max(0, ix1 - ix0);
  const ih = Math.max(0, iy1 - iy0);

  if (iw === 0 || ih === 0) {
    // Edge case: crop rect is entirely outside the source.
    // Produce a pure white image of the desired output size.
    const blank = await sharp({
      create: {
        width: outW,
        height: outH,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png()
      .toBuffer();
    return {
      buffer: blank,
      whitePadding: {
        left: cropW,
        top: cropH,
        right: 0,
        bottom: 0,
      },
      finalCropRect: { x: 0, y: 0, width: 0, height: 0 },
    };
  }

  // 3. Extract the intersection from the source
  const extracted = await sharp(srcBuffer)
    .extract({ left: ix0, top: iy0, width: iw, height: ih })
    .toBuffer();

  // 4. Compute white padding on each side.
  //    The crop rect's top-left in source coords is (idealX, idealY).
  //    The intersection's top-left is (ix0, iy0).
  //    Padding = how much of the crop is OUTSIDE the source on each side.
  const padLeft = Math.max(0, ix0 - Math.round(idealX));
  const padTop = Math.max(0, iy0 - Math.round(idealY));
  const padRight = Math.max(0, Math.round(idealX + cropW) - ix1);
  const padBottom = Math.max(0, Math.round(idealY + cropH) - iy1);

  // 5. Extend with white pixels on the needed sides (if any)
  let extended: Buffer = extracted;
  if (padLeft || padTop || padRight || padBottom) {
    extended = await sharp(extracted)
      .extend({
        left: padLeft,
        top: padTop,
        right: padRight,
        bottom: padBottom,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .toBuffer();
  }

  // 6. Resize to final output dimensions (lanczos3 for high-quality upscale)
  const final = await sharp(extended)
    .resize(outW, outH, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();

  return {
    buffer: final,
    whitePadding: { left: padLeft, top: padTop, right: padRight, bottom: padBottom },
    finalCropRect: { x: ix0, y: iy0, width: iw, height: ih },
  };
}

/**
 * Capture a centered, zoomed screenshot of a keyword occurrence.
 *
 * Algorithm (keyword-anchor centering, v3 — preserves highlight):
 *   1. Inject vertical virtual padding (100vh top + bottom) so keywords
 *      near page top/bottom can be scrolled into the viewport.
 *   2. Highlight the occurrence (by locator) → get keyword's doc rect.
 *      (The yellow #FFFF00 background is BOTH the visual anchor we detect
 *      post-capture AND the product feature that stays visible in the
 *      final video frame.)
 *   3. Compute zoom so keyword fills ~13% of frame width.
 *   4. Compute crop dimensions (frameWidth/zoom × frameHeight/zoom, 16:9).
 *   5. Compute crop rect in DOCUMENT coords, centered on keyword.
 *   6. Clamp crop rect to document bounds (set wasClamped if needed).
 *   7. Scroll viewport so the keyword is ROUGHLY centered (doesn't need
 *      to be exact — post-capture detection will correct any error).
 *   8. Capture full viewport screenshot (1920×1080) WITH the yellow
 *      highlight visible — this is the screenshot we'll keep.
 *   9. **DETECT YELLOW CENTROID** in the captured PNG — this is the
 *      ground-truth keyword position, immune to DOM measurement error.
 *  10. **EXTRACT CENTERED CROP** via Sharp: symmetric crop around the
 *      yellow centroid, with white pixel synthesis for any portion
 *      extending beyond the viewport. Resize to 1920×1080.
 *      The crop is extracted from the HIGHLIGHTED screenshot, so the
 *      yellow #FFFF00 highlight is preserved in the final frame.
 *  11. Remove highlight + virtual padding (clean up for next screenshot).
 *
 * The key innovation is steps 9-10. By detecting the keyword's actual
 * position in the captured pixels (rather than trusting DOM measurements
 * that may have sub-pixel rounding or race conditions), and by computing
 * a SYMMETRIC crop around that position (rather than clamping to viewport
 * bounds which introduces asymmetry), we guarantee:
 *
 *     keyword_centroid == crop_center == frame_center == (960, 540)
 *
 * always, for every frame.
 *
 * HIGHLIGHT PRESERVATION: Unlike the previous v2 algorithm which removed
 * the highlight before the final crop (incorrectly treating it as a bug),
 * v3 keeps the highlight visible. This is the product's core feature —
 * the marketing copy on the home page explicitly says "the highlighted
 * word stays perfectly centered while the source changes". The <mark>
 * element has zero padding/margin/border/outline, so it does not shift
 * the keyword's position — the centroid detected from the highlighted
 * screenshot is the exact keyword center.
 *
 * @param page - Playwright Page with the article rendered
 * @param locator - OccurrenceLocator identifying which occurrence to capture
 * @param opts - Screenshot options (zoom, dimensions)
 * @returns ScreenshotResult with image buffer and metadata
 * @throws if the occurrence can't be found or highlighted
 */
export async function captureCenteredScreenshot(
  page: Page,
  locator: OccurrenceLocator,
  opts: ScreenshotOptions = {}
): Promise<ScreenshotResult> {
  const {
    frameWidth = 1920,
    frameHeight = 1080,
    gateG2 = true,
    gateG3 = true,
  } = opts;

  const viewportSize = page.viewportSize();
  if (!viewportSize) {
    throw new Error("Page has no viewport size");
  }

  // 1. Inject virtual padding so keywords near page edges can be centered
  await injectVirtualPadding(page);

  try {
    // 2. Highlight the occurrence → get rect (now relative to padded document)
    const highlight = await highlightOccurrence(page, locator);
    if (!highlight.success || !highlight.rect) {
      throw new Error(
        `Failed to highlight occurrence: ${highlight.error ?? "unknown"}`
      );
    }

    // 2.5. MULTI-LINE KEYWORD CHECK (DOM-level, added 2026-09-14)
    //      ------------------------------------------------------------
    //      PROBLEM (user-reported, keyword "Blue Origin"):
    //        When a multi-word keyword wraps across CSS lines — "Blue" at the
    //        end of one line, "Origin" at the start of the next — the <mark>
    //        highlight renders as TWO separate yellow boxes on different
    //        lines. The captured frame looks broken in the final video.
    //
    //        Discovery-time filtering (selectFrames) excludes occurrences
    //        whose Range spanned 2+ line boxes at discovery time. But the
    //        layout can SHIFT between discovery and capture (lazy-loaded
    //        content, viewport changes from virtual padding, dynamic CSS),
    //        turning a discovery-time single-line occurrence into a
    //        capture-time multi-line one. Gate 3's pixel-level split
    //        detector also misses tight line gaps (≤~20px) because its
    //        10px dilation merges the two yellow boxes.
    //
    //      FIX: after highlightOccurrence() succeeds, count the mark's CSS
    //      line boxes via getClientRects() — a DOM API (one rect per line
    //      box an inline element occupies), NOT pixel analysis. If the mark
    //      spans >1 line box, throw so captureAndValidateOne() catches it,
    //      returns null, and the captureAllFrames loop tries the next
    //      candidate. Self-healing preserved: if all candidates are
    //      multi-line, the frame slot stays empty for Pass 2/3 backfill
    //      from other articles.
    // GATE 2: Frame selection checks (multi-line + tall-highlight).
    // Skip entirely when gateG2 is false.
    if (gateG2) {
      const lineBoxCount = (await page.evaluate(`(() => {
        const mark = document.querySelector('mark[data-nmc-highlight="true"]');
        if (!mark) return -1;
        return mark.getClientRects().length;
      })()`)
        .catch(() => 1)) as number;

      if (lineBoxCount > 1) {
        await removeHighlight(page).catch(() => {});
        await removeVirtualPadding(page).catch(() => {});
        throw new Error(
          `keyword_spans_multiple_lines: highlight occupies ${lineBoxCount} line boxes ` +
          `(multi-word keyword wraps across lines — split two-box highlight would look broken)`
        );
      }

      // 2.5b. Tall-highlight check
      const tallBoxInfo = (await page.evaluate(`(() => {
        const mark = document.querySelector('mark[data-nmc-highlight="true"]');
        if (!mark) return { found: false, height: 0 };
        const r = mark.getBoundingClientRect();
        return { found: true, height: r.height };
      })()`)
        .catch(() => ({ found: false, height: 0 }))) as { found: boolean; height: number };

      if (tallBoxInfo.found && tallBoxInfo.height > 80) {
        await removeHighlight(page).catch(() => {});
        await removeVirtualPadding(page).catch(() => {});
        throw new Error(
          `keyword_highlight_too_tall: mark height=${tallBoxInfo.height.toFixed(0)}px ` +
          `(keyword sits in an abnormally tall container — vertically-stretched highlight would look broken)`
        );
      }
    }

    // kwRectAfterHighlight is the mark's bounding rect — used by all
    // downstream zoom/scroll/crop math.
    const kwRectAfterHighlight = highlight.rect;

    // 3. Compute PRE-CAPTURE zoom (used only for initial scroll positioning).
    //    The FINAL zoom is computed post-capture by computeAutoZoom(),
    //    which uses the keyword's actual position in the captured PNG to
    //    avoid white padding. The pre-capture zoom just needs to be close
    //    enough to get the keyword into the viewport.
    let { zoom, wasClamped: zoomClamped } = computeZoom(
      kwRectAfterHighlight.width,
      opts
    );
    let wasClamped = zoomClamped;

    // 4. Compute crop dimensions (16:9 aspect)
    const cropWidth = frameWidth / zoom;
    const cropHeight = frameHeight / zoom;

    // 5. Compute crop rect in DOCUMENT coords, centered on keyword
    const kwDocCenterX =
      kwRectAfterHighlight.docX + kwRectAfterHighlight.width / 2;
    const kwDocCenterY =
      kwRectAfterHighlight.docY + kwRectAfterHighlight.height / 2;
    let cropDocX = kwDocCenterX - cropWidth / 2;
    let cropDocY = kwDocCenterY - cropHeight / 2;

    // 6. Clamp crop rect to document bounds (read live from DOM)
    //    (wasClamped was already initialized from zoomClamped above)
    const docBounds = (await page.evaluate(`(() => {
      return {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      };
    })()`)) as { scrollWidth: number; scrollHeight: number };
    if (cropDocX < 0) {
      cropDocX = 0;
      wasClamped = true;
    }
    if (cropDocY < 0) {
      cropDocY = 0;
      wasClamped = true;
    }
    if (cropDocX + cropWidth > docBounds.scrollWidth) {
      cropDocX = Math.max(0, docBounds.scrollWidth - cropWidth);
      wasClamped = true;
    }
    if (cropDocY + cropHeight > docBounds.scrollHeight) {
      cropDocY = Math.max(0, docBounds.scrollHeight - cropHeight);
      wasClamped = true;
    }

    // 7. Scroll viewport so the keyword is ROUGHLY centered in the viewport.
    //    This doesn't need to be pixel-perfect — the post-capture yellow
    //    centroid detection (step 9) will compute the exact center and the
    //    extractCenteredCrop (step 10) will produce a symmetric crop around
    //    it. The scroll just needs to get the keyword INTO the viewport.
    //
    // We try multiple scroll methods because some sites (e.g., The Guardian)
    // have `overflow: hidden` on body/html or use a custom scroll container,
    // which makes `window.scrollTo` a no-op. The <mark>.scrollIntoView()
    // method works regardless of which ancestor is the scroll container.
    const scrollTargetX = Math.max(0, cropDocX);
    const scrollTargetY = Math.max(0, cropDocY);
    await page
      .evaluate(
        `(() => {
          // Method 1: window.scrollTo (works for most sites)
          window.scrollTo(${scrollTargetX}, ${scrollTargetY});
          // Method 2: set scrollTop directly (fallback for overflow:hidden body)
          if (document.documentElement) {
            document.documentElement.scrollLeft = ${scrollTargetX};
            document.documentElement.scrollTop = ${scrollTargetY};
          }
          if (document.body) {
            document.body.scrollLeft = ${scrollTargetX};
            document.body.scrollTop = ${scrollTargetY};
          }
          // Method 3: mark.scrollIntoView (works for custom scroll containers)
          // This is the most robust — it scrolls whatever ancestor is scrollable.
          // We use block:'center' to center the keyword vertically.
          const mark = document.querySelector('mark[data-nmc-highlight="true"]');
          if (mark && mark.scrollIntoView) {
            try {
              mark.scrollIntoView({ block: 'center', inline: 'nearest' });
            } catch (e) { /* older browsers */ }
          }
        })()`
      )
      .catch(() => {});
    await page.waitForTimeout(300).catch(() => {});

    // 7.5. CHECK KEYWORD VISIBILITY — if the scroll didn't bring the
    //      keyword into the viewport (which happens on sites like The
    //      Guardian where the body doesn't scroll), the virtual padding
    //      is actually HARMFUL: it pushed the keyword down by 100vh but
    //      we can't scroll to bring it back. In that case, remove the
    //      virtual padding and re-measure the keyword. Without virtual
    //      padding, the keyword returns to its original position in the
    //      article, and the post-capture symmetric crop will handle
    //      centering (with white padding if the keyword is near a page
    //      edge — an acceptable trade-off vs. no highlight at all).
    const visibilityCheck = await page.evaluate(`(() => {
      const mark = document.querySelector('mark[data-nmc-highlight="true"]');
      if (!mark) return { inViewport: false, reason: 'mark_not_found' };
      const r = mark.getBoundingClientRect();
      const vh = window.innerHeight || 1080;
      const vw = window.innerWidth || 1920;
      const inViewport = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      return {
        inViewport,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        viewport: { w: vw, h: vh },
        scrollY: window.scrollY,
      };
    })()`) as { inViewport: boolean; rect?: { x: number; y: number; w: number; h: number }; scrollY?: number };

    if (!visibilityCheck.inViewport) {
      // The keyword is outside the viewport. Remove virtual padding (which
      // pushed it down) and re-highlight + re-scroll to its original position.
      console.warn(`[captureCenteredScreenshot] Keyword not in viewport after scroll (y=${visibilityCheck.rect?.y ?? 0}, scrollY=${visibilityCheck.scrollY ?? 0}) — removing virtual padding and retrying`);
      await removeHighlight(page).catch(() => {});
      await removeKeywordNormalization(page).catch(() => {});
      await removeVirtualPadding(page).catch(() => {});
      await page.waitForTimeout(100).catch(() => {});

      // Re-highlight (the keyword's position is now its original article position)
      // NOTE: after re-highlight, we must RE-APPLY size normalization because
      // the new mark starts with the container's original (untransformed) size.
      const reHighlight = await highlightOccurrence(page, locator);
      if (reHighlight.success && reHighlight.rect) {
        const reRect = reHighlight.rect;
        const reDocCenterX = reRect.docX + reRect.width / 2;
        const reDocCenterY = reRect.docY + reRect.height / 2;
        const reCropX = reDocCenterX - cropWidth / 2;
        const reCropY = reDocCenterY - cropHeight / 2;
        await page.evaluate(
          `(() => {
            window.scrollTo(${Math.max(0, reCropX)}, ${Math.max(0, reCropY)});
            if (document.documentElement) {
              document.documentElement.scrollTop = ${Math.max(0, reCropY)};
            }
            if (document.body) {
              document.body.scrollTop = ${Math.max(0, reCropY)};
            }
            const mark = document.querySelector('mark[data-nmc-highlight="true"]');
            if (mark && mark.scrollIntoView) {
              try { mark.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
            }
          })()`
        ).catch(() => {});
        await page.waitForTimeout(300).catch(() => {});
      }

      // 7.55. POST-RETRY VISIBILITY CHECK — if the retry path above ran but
      //      the mark is STILL not in the viewport, the publisher's page
      //      doesn't support scrolling (e.g., The Guardian has overflow:hidden
      //      on body, making window.scrollTo + scrollIntoView both no-ops).
      //
      //      In this state, capturing a screenshot would produce a frame
      //      showing the TOP of the article (nav + chrome) WITHOUT the
      //      keyword highlight. Even worse, the publisher's own yellow UI
      //      elements (e.g., The Guardian's hamburger menu button) would
      //      be detected as the highlight by detectYellowCentroid(), causing
      //      Gate 3's yellow-pixel validation to INCORRECTLY PASS the frame.
      //      This was the root cause of the "4 corrupted Elon Musk frames"
      //      bug — 3 identical frames for The Guardian article all showed
      //      the top of the page with the yellow hamburger button but no
      //      actual keyword highlight.
      //
      //      FIX: Verify the mark is now in the viewport. If not, throw
      //      an error so captureAndValidateOne() catches it, returns null,
      //      and the captureAllFrames loop tries the next candidate. If all
      //      candidates fail (e.g., all occurrences are below the un-
      //      scrollable viewport), the frame slot is left empty for Pass 2
      //      backfill from a different article.
      //
      //      This is a DOM-level check (getBoundingClientRect on the mark),
      //      NOT pixel analysis — it uses the same measurement technique as
      //      the initial visibilityCheck above.
      const postRetryCheck = await page.evaluate(`(() => {
        const mark = document.querySelector('mark[data-nmc-highlight="true"]');
        if (!mark) return { markExists: false, inViewport: false };
        const r = mark.getBoundingClientRect();
        const vh = window.innerHeight || 1080;
        const vw = window.innerWidth || 1920;
        return {
          markExists: true,
          inViewport: r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw,
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
          scrollY: window.scrollY,
          viewport: { w: vw, h: vh },
        };
      })()`) as {
        markExists: boolean;
        inViewport: boolean;
        rect?: { x: number; y: number; w: number; h: number };
        scrollY?: number;
      };

      if (!postRetryCheck.markExists || !postRetryCheck.inViewport) {
        // Clean up before throwing — the finally block below will also run,
        // but it's idempotent (removeHighlight + removeVirtualPadding are
        // safe to call even when there's nothing to remove).
        await removeHighlight(page).catch(() => {});
        await removeKeywordNormalization(page).catch(() => {});
        await removeVirtualPadding(page).catch(() => {});
        throw new Error(
          `Keyword highlight not in viewport after retry ` +
          `(mark at y=${postRetryCheck.rect?.y ?? "unknown"}, ` +
          `scrollY=${postRetryCheck.scrollY ?? 0}) — ` +
          `publisher site does not support scrolling, cannot capture centered frame`
        );
      }

      // Mark is now in viewport after retry — log and continue.
      console.log(
        `[captureCenteredScreenshot] Keyword recovered into viewport after retry ` +
        `(y=${postRetryCheck.rect?.y ?? 0}, scrollY=${postRetryCheck.scrollY ?? 0})`
      );
    }

    // 7.6. HIDE OVERLAYS — iframes and fixed-position elements (sticky
    //      headers, cookie banners, ad overlays) that overlap with the
    //      <mark> would visually cover the yellow highlight in the
    //      screenshot, causing detectYellowCentroid() to fail. This was
    //      the root cause of the missing-highlight bug on The Guardian
    //      (all 3 frames had an ad iframe layered on top of the keyword).
    //      We hide only the overlapping elements to minimize layout
    //      disruption. Hidden elements are marked with data-nmc-hidden.
    const overlaysHidden = await hideOverlays(page).catch((e) => {
      console.warn(`[hideOverlays] error: ${e?.message ?? e}`);
      return { iframesHidden: 0, fixedHidden: 0, yellowChromeHidden: 0 };
    });
    if (overlaysHidden.iframesHidden > 0 || overlaysHidden.fixedHidden > 0 || overlaysHidden.yellowChromeHidden > 0) {
      // Brief settle in case hiding an inline iframe or yellow chrome caused a reflow.
      await page.waitForTimeout(50).catch(() => {});
      if (overlaysHidden.yellowChromeHidden > 0) {
        console.log(
          `[hideOverlays] hid ${overlaysHidden.yellowChromeHidden} yellow-chrome element(s) ` +
          `(e.g., publisher's yellow UI button) to prevent false-positive highlight detection`
        );
      }
    }

    // 8. Capture full viewport screenshot (1920×1080).
    //    The yellow <mark> highlight is visible in this screenshot — we'll
    //    detect it post-capture to get the ground-truth keyword position.
    //
    //    Wait for TWO animation frames before capturing. The first rAF
    //    fires before the browser paints; the second fires after paint.
    //    This ensures the yellow background is actually rendered in the
    //    screenshot (fixes an intermittent race condition where the <mark>
    //    was in the DOM with correct styles but the paint hadn't happened
    //    yet — observed on NDTV's "anywhere" frame).
    await raceTimeout(
      page.evaluate(`(() => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })())`),
      5_000
    ).catch(() => {});
    let fullBuffer = await page.screenshot({
      type: "png",
      omitBackground: false,
      // page.screenshot has NO default timeout — a crashed renderer (target
      // crashed) hangs it forever, which previously stalled the whole job.
      timeout: 30_000,
    });

    // 9. DETECT YELLOW CENTROID in the captured PNG.
    //    This is the ground-truth keyword position — immune to DOM
    //    measurement error, sub-pixel scroll rounding, and race conditions
    //    between measure() and screenshot(). The yellow #FFFF00 color is
    //    unique in news articles (doesn't appear in normal text/images),
    //    so template matching is 100% reliable.
    let yellowInfo = await detectYellowCentroid(fullBuffer);

    // 9.5. RETRY on yellow detection failure — sometimes the browser hasn't
    //      painted the highlight yet, or a lazy-loaded overlay appeared after
    //      our initial hideOverlays pass. Wait briefly, re-hide overlays, wait
    //      for two more animation frames, and re-capture. This fixes the
    //      intermittent NDTV "anywhere" frame failure.
    if (!yellowInfo) {
      console.warn(`[captureCenteredScreenshot] Yellow not detected on first capture — retrying after 300ms`);
      await page.waitForTimeout(300).catch(() => {});
      await hideOverlays(page).catch(() => {});
      await raceTimeout(
        page.evaluate(`(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })())`),
        5_000
      ).catch(() => {});
      fullBuffer = await page.screenshot({
        type: "png",
        omitBackground: false,
        timeout: 30_000,
      });
      yellowInfo = await detectYellowCentroid(fullBuffer);
      if (yellowInfo) {
        console.warn(`[captureCenteredScreenshot] Yellow detected on retry ✓`);
      } else {
        // Save the failed buffer for debugging
        try {
          const { writeFileSync } = await import("fs");
          const debugPath = `/home/z/my-project/scripts/debug-yellow-fail-${Date.now()}.png`;
          writeFileSync(debugPath, fullBuffer);
          console.warn(`[captureCenteredScreenshot] Yellow still not detected — saved debug screenshot to ${debugPath}`);
        } catch {}
      }
    }

    // 9.6. VALIDATE YELLOW CENTROID AGAINST MARK'S DOM BBOX
    //      ------------------------------------------------------------
    //      PROBLEM (root cause of "duplicate frames" bug, observed on the
    //      "fart" job cmu01739l009hlctzljdvrz24 for articles from OutKick,
    //      CNN, and The Independent):
    //
    //      detectYellowCentroid() scans the ENTIRE screenshot for yellow
    //      pixels. Publishers often have yellow UI elements that are NOT
    //      background-color (so hideOverlays can't catch them):
    //        - Yellow SVG icons (fill, not background-color)
    //        - Yellow text (color, not background-color)
    //        - Yellow borders / outlines
    //        - Yellow box-shadows / gradients
    //        - Yellow <img> elements
    //
    //      When such a publisher yellow element is present AND the mark's
    //      yellow is small (e.g., keyword "fart" = 4 chars → ~6,000 yellow
    //      pixels = 0.3%), the centroid is DOMINATED by the publisher's
    //      yellow (e.g., 16,000 pixels at a fixed position). For ALL
    //      occurrences of the keyword in the same article, the same
    //      publisher yellow element is detected → same centroid → same crop
    //      → byte-identical frames (2-3 duplicates per article).
    //
    //      FIX: After detectYellowCentroid(), also read the mark's viewport
    //      bbox via getBoundingClientRect() (DOM measurement, NOT pixel
    //      analysis). If the yellow centroid is FAR from the mark's bbox
    //      center (distance > MAX_CENTROID_DRIFT_PX), the yellow centroid
    //      is a false positive (publisher's yellow element, not the mark).
    //      In that case, OVERRIDE the centroid with the mark's DOM bbox
    //      center — this is the GROUND TRUTH keyword position.
    //
    //      This is a DOM-level validation (getBoundingClientRect on the
    //      <mark> element), NOT pixel analysis. It uses the same DOM
    //      measurement technique already used by measureHighlightedKeyword()
    //      and the visibility checks above.
    //
    //      Threshold: MAX_CENTROID_DRIFT_PX = 100px. The mark's bbox center
    //      and the yellow centroid should be within a few pixels of each
    //      other (the <mark> has zero padding/margin/border, so its bbox
    //      matches the yellow highlight exactly). 100px is a generous
    //      threshold that catches false positives without rejecting valid
    //      centroids that differ slightly due to anti-aliasing.
    const MAX_CENTROID_DRIFT_PX = 100;

    const markDomRect = await measureHighlightedKeyword(page);
    if (yellowInfo && markDomRect) {
      const markCenterX = markDomRect.x + markDomRect.width / 2;
      const markCenterY = markDomRect.y + markDomRect.height / 2;
      const drift = Math.sqrt(
        Math.pow(yellowInfo.cx - markCenterX, 2) +
        Math.pow(yellowInfo.cy - markCenterY, 2)
      );

      if (drift > MAX_CENTROID_DRIFT_PX) {
        // The yellow centroid is FAR from the mark's actual position.
        // This is a false positive — the centroid is from a publisher's
        // yellow UI element, not from the <mark>. Override with the mark's
        // DOM bbox center (ground truth).
        console.warn(
          `[captureCenteredScreenshot] Yellow centroid drift detected: ` +
          `centroid=(${yellowInfo.cx.toFixed(0)}, ${yellowInfo.cy.toFixed(0)}) vs ` +
          `mark bbox center=(${markCenterX.toFixed(0)}, ${markCenterY.toFixed(0)}) ` +
          `→ drift=${drift.toFixed(0)}px > ${MAX_CENTROID_DRIFT_PX}px threshold. ` +
          `Overriding centroid with mark's DOM position ` +
          `(publisher yellow UI element likely caused false positive).`
        );

        // Override: use the mark's bbox for the centroid AND the bbox
        // dimensions for the yellow bbox (used by computeAutoZoom).
        // This ensures the crop is centered on the ACTUAL keyword, not
        // the publisher's yellow element.
        yellowInfo = {
          cx: markCenterX,
          cy: markCenterY,
          bbox: {
            x0: markDomRect.x,
            y0: markDomRect.y,
            x1: markDomRect.x + markDomRect.width,
            y1: markDomRect.y + markDomRect.height,
          },
          area: Math.round(markDomRect.width * markDomRect.height),
        };
      }
    }

    let resizedBuffer: Buffer;
    let yellowCentroid: ScreenshotResult["yellowCentroid"];
    let finalCropRect: ScreenshotResult["finalCropRect"];
    let whitePadding: ScreenshotResult["whitePadding"];

    if (yellowInfo) {
      yellowCentroid = {
        cx: yellowInfo.cx,
        cy: yellowInfo.cy,
        area: yellowInfo.area,
        bbox: yellowInfo.bbox,
      };

      // 10. COMPUTE AUTO-ZOOM from the yellow centroid and bbox.
      //     This is the POST-CAPTURE zoom — it uses the ACTUAL keyword
      //     position in the captured screenshot (not the pre-capture DOM
      //     measurement) to determine the highest zoom that:
      //       (a) keeps the crop WITHIN the viewport (no white padding)
      //       (b) fits the keyword with a 20% margin (keyword not cut off)
      //       (c) makes the keyword at least 13% of frame width
      //     This eliminates the white-margin problem that occurred with the
      //     pre-capture zoom (which didn't know the keyword's actual viewport
      //     position and could produce crops extending beyond the viewport).
      const kwActualWidth = yellowInfo.bbox.x1 - yellowInfo.bbox.x0 + 1;
      const autoZoom = computeAutoZoom(
        kwActualWidth,
        yellowInfo.cx,
        yellowInfo.cy,
        viewportSize.width,
        viewportSize.height,
        opts
      );
      const finalZoom = autoZoom.zoom;
      const finalCropWidth = frameWidth / finalZoom;
      const finalCropHeight = frameHeight / finalZoom;

      // 11. EXTRACT CENTERED CROP — symmetric around the yellow centroid,
      //     using the auto-zoom crop dimensions. The crop is extracted from
      //     the HIGHLIGHTED screenshot (fullBuffer) so the yellow #FFFF00
      //     highlight remains visible in the final video frame. This is the
      //     intended product behavior — the highlight IS the visual anchor
      //     that draws the viewer's eye to the keyword in each frame.
      //
      // The <mark> element has zero padding/margin/border/outline, so it
      // does NOT alter the document layout — the keyword's position is
      // identical with or without the highlight. Therefore the centroid
      // we detected from fullBuffer is still the exact keyword center
      // when we extract the crop from the same fullBuffer.
      const cropResult = await extractCenteredCrop(
        fullBuffer,
        yellowInfo.cx,
        yellowInfo.cy,
        finalCropWidth,
        finalCropHeight,
        viewportSize.width,
        viewportSize.height,
        frameWidth,
        frameHeight
      );
      resizedBuffer = cropResult.buffer;
      finalCropRect = cropResult.finalCropRect;
      whitePadding = cropResult.whitePadding;

      // Update zoomFactor to reflect the ACTUAL zoom used (post-capture),
      // not the pre-capture estimate. This is what gets stored in the DB
      // and displayed to the user.
      zoom = finalZoom;

      // If we synthesized white pixels, the crop was asymmetric (keyword
      // was near a viewport edge OR keyword too wide to fit without padding).
      // Mark as clamped for diagnostics.
      if (
        whitePadding.left > 0 ||
        whitePadding.top > 0 ||
        whitePadding.right > 0 ||
        whitePadding.bottom > 0
      ) {
        wasClamped = true;
      }
    } else {
      // Fallback: yellow centroid not detected (highlight failed to render
      // or color detection missed it). Fall back to the DOM-based crop
      // using the post-scroll re-measurement. This is the old v1 algorithm
      // — less precise than the yellow-anchor approach, but still produces
      // a valid screenshot.
      console.warn(
        "[captureCenteredScreenshot] Yellow centroid not detected in screenshot — falling back to DOM-based crop"
      );
      const kwViewportRect = await measureHighlightedKeyword(page);
      if (!kwViewportRect) {
        throw new Error(
          "Highlighted keyword not found after scroll (and yellow detection failed)"
        );
      }
      // Use fullBuffer (which contains the highlight, if it rendered) for
      // the crop extraction. We intentionally KEEP the highlight visible in
      // the final video frame — it is the product's core visual feature.
      // The <mark> has zero padding/margin/border so it does not shift the
      // keyword's position.
      const kwViewportCenterX =
        kwViewportRect.x + kwViewportRect.width / 2;
      const kwViewportCenterY =
        kwViewportRect.y + kwViewportRect.height / 2;
      const cropResult = await extractCenteredCrop(
        fullBuffer,
        kwViewportCenterX,
        kwViewportCenterY,
        cropWidth,
        cropHeight,
        viewportSize.width,
        viewportSize.height,
        frameWidth,
        frameHeight
      );
      resizedBuffer = cropResult.buffer;
      finalCropRect = cropResult.finalCropRect;
      whitePadding = cropResult.whitePadding;
      wasClamped = true; // mark as clamped since we used the fallback path
    }

    return {
      imageBuffer: resizedBuffer,
      centerX: kwDocCenterX,
      centerY: kwDocCenterY,
      zoomFactor: zoom,
      wasClamped,
      occurrenceRect: {
        x: kwRectAfterHighlight.docX,
        y: kwRectAfterHighlight.docY,
        width: kwRectAfterHighlight.width,
        height: kwRectAfterHighlight.height,
      },
      yellowCentroid,
      finalCropRect,
      whitePadding,
    };
  } finally {
    // 11. Always remove highlight + normalization + virtual padding, even on error
    await removeHighlight(page).catch(() => {});
    await removeKeywordNormalization(page).catch(() => {});
    await removeVirtualPadding(page).catch(() => {});
  }
}
