// Keyword discovery + frame selection
//
// Given a Playwright Page and a keyword, finds all visible occurrences of the
// keyword in the article body. Each occurrence is classified by position type
// (heading / body / anywhere) and includes a bounding-box rect for later
// screenshot capture.
//
// Algorithm:
// 1. Walk all "leaf block" elements (p, h1-h6, li, blockquote, td, etc. that
//    don't contain nested blocks). This avoids double-counting when a <p>
//    contains a <span> that contains the keyword.
// 2. For each leaf block, concatenate all child text nodes into one string
//    and find keyword matches (case-insensitive, word-boundary aware).
// 3. For each match, create a DOM Range spanning the match (which may span
//    multiple text nodes if the keyword is split across inline elements like
//    <strong>Donald</strong> <em>Trump</em>).
// 4. Get the Range's bounding rect and classify by container tag.
//
// Word boundary check: we only match if the character before AND after the
// keyword is a non-word character (space, punctuation, start/end of string).
// This prevents matching "Trump" inside "Trumpian" or "Donald" inside
// "Donaldson".
//
// Multi-node matching: by concatenating text from sibling text nodes within
// the same leaf block, we can find keywords that span inline formatting
// elements. The Range API handles the actual DOM range creation.

import type { Page } from "playwright";

export type KeywordPositionType = "heading" | "body" | "anywhere";

export interface KeywordOccurrence {
  id: number;
  positionType: KeywordPositionType;
  containerTag: string;
  containerText: string; // first 200 chars of container textContent
  startOffsetInContainer: number;
  // Length of the ACTUAL matched text in the DOM (may differ from keyword
  // length when the keyword uses spaces but the article uses hyphens/colons,
  // e.g. keyword "spider man" (9 chars) matches "Spider-Man" (10 chars)).
  // The highlight function uses this to create the correct-length Range.
  matchedLength: number;
  isMultiNode: boolean;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  visible: boolean;
  // --- Gate 1 quality fields (added 2026-07-25) ---
  // Number of CSS line boxes the keyword's Range occupies.
  //   1 = keyword fits on a single line (good)
  //   2+ = keyword wraps across multiple lines (bad — produces split highlight)
  // Verified via range.getClientRects().length in the browser.
  clientRectsCount: number;
  // True if the occurrence lives inside the article's main content container
  // (article, main, [role=main], or common publisher body classes).
  // False = sidebar / "related articles" / "recommended for you" / comments.
  isInMainContent: boolean;
  // Composite quality score in [0, 100].
  //   100 = single-line + in-main-content (best)
  //    60 = single-line + sidebar
  //    30 = multi-line + in-main-content (last resort)
  //     0 = multi-line + sidebar (skipped entirely)
  qualityScore: number;
}

export interface FrameSelection {
  headline: KeywordOccurrence;
  body: KeywordOccurrence;
  anywhere: KeywordOccurrence;
  // Ranked candidate pools for each position, best-first.
  // Capture pipeline uses these to retry when Gate 3 rejects a frame.
  headlinePool: KeywordOccurrence[];
  bodyPool: KeywordOccurrence[];
  anywherePool: KeywordOccurrence[];
  totalOccurrences: number;
  headingCount: number;
  bodyCount: number;
}

export interface DiscoverResult {
  occurrences: KeywordOccurrence[];
  total: number;
  visible: number;
  heading: number;
  body: number;
  visibleHeading: number;
  visibleBody: number;
}

/**
 * Discover all keyword occurrences in the page.
 * Returns both visible and non-visible occurrences (non-visible ones are
 * included for debugging but excluded from frame selection).
 */
export async function discoverKeywordOccurrences(
  page: Page,
  keyword: string
): Promise<DiscoverResult> {
  // Use string-based evaluate to avoid tsx __name wrapper issues.
  // The keyword is safely embedded via JSON.stringify.
  const script = `
(() => {
  const keyword = ${JSON.stringify(keyword)};
  const kwLower = keyword.toLowerCase();
  const kwLen = kwLower.length;

  // --- Punctuation-free keyword matching (added 2026-09-15) ---
  // PROBLEM: Multi-word keywords with different punctuation than the article
  // text fail to match. "spiderman brand new day" doesn't match "Spider-Man:
  // Brand New Day" because:
  //   - "spiderman" (one word) vs "Spider-Man" (hyphenated, two words)
  //   - Colons, hyphens, em-dashes break literal indexOf
  // This caused 8+ direct articles to be accepted (title/URL match) but
  // produce 0 frames (keyword discovery found 0 occurrences in the body).
  //
  // FIX: Strip ALL non-alphanumeric characters from both the keyword and the
  // article text, then search for the stripped keyword in the stripped text.
  // Map the match position back to the original text using a position table.
  //
  // Example:
  //   keyword: "Spiderman brand new day" → stripped: "spidermanbrandnewday"
  //   text: "Spider-Man: Brand New Day" → stripped: "spidermanbrandnewday"
  //   Match found at position 0, length 21 → maps to original text [0, 26)
  //
  // This handles ALL punctuation variants: hyphens, colons, em-dashes,
  // slashes, pipes, periods, etc. — both between words AND within words.
  const kwNoPunct = kwLower.replace(/[^a-z0-9]/g, '');
  const kwNoPunctLen = kwNoPunct.length;

  const isWordBoundary = (ch) => {
    if (!ch) return true;
    // Word boundary = anything that's not a letter, digit, or apostrophe
    // (apostrophe allowed so "Trump's" still matches "Trump")
    return !/[a-zA-Z0-9'\\u00C0-\\u024F]/.test(ch);
  };

  // Tags that count as "heading" containers
  const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  // Tags that count as "body" containers
  const BODY_TAGS = new Set(['p', 'li', 'blockquote', 'td', 'th', 'dd', 'dt', 'figcaption']);
  // Tags whose text content we should skip entirely
  const SKIP_TAGS = new Set(['script', 'style', 'textarea', 'code', 'noscript', 'svg', 'iframe', 'select', 'button']);

  // Select all candidate leaf-block containers.
  // A leaf block is a block-level element that doesn't contain any other
  // block-level elements (so we don't double-count text in nested blocks).
  //
  // IMPORTANT: We only consider BLOCK-level elements for the nesting check.
  // Inline elements (span, a, strong, em, b, i, u) do NOT make a container
  // non-leaf — they're formatting wrappers that we want to look through.
  // If we treated them as blocks, then <h1><span>Donald Trump</span></h1>
  // would skip the <h1> (because it has a nested <span>), and the <span>
  // would become the leaf — but <span> is not a heading tag, so the
  // occurrence would be misclassified as "anywhere" instead of "heading".
  const BLOCK_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'td', 'th', 'dd', 'dt', 'figcaption', 'div'];
  const allCandidates = document.querySelectorAll(BLOCK_TAGS.join(', '));

  // Filter to leaf blocks: those without nested block tags inside
  const leafBlocks = [];
  for (const el of allCandidates) {
    // Skip if inside a SKIP_TAG ancestor
    let ancestor = el.parentElement;
    let skip = false;
    while (ancestor) {
      if (SKIP_TAGS.has(ancestor.tagName.toLowerCase())) { skip = true; break; }
      ancestor = ancestor.parentElement;
    }
    if (skip) continue;

    // Skip hidden
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (Number(style.opacity) === 0) continue;

    // Check if this element contains any nested BLOCK-level elements
    // (inline elements like span/a/strong do NOT count)
    let hasNested = false;
    for (const blockTag of BLOCK_TAGS) {
      if (el.querySelector(blockTag)) { hasNested = true; break; }
    }
    if (hasNested) continue;

    // Must have some text content
    if (!el.textContent || el.textContent.trim().length === 0) continue;

    leafBlocks.push(el);
  }

  const occurrences = [];
  let occurrenceId = 0;
  const seenStarts = new Set(); // dedupe by start node + offset

  for (const container of leafBlocks) {
    const containerTag = container.tagName.toLowerCase();
    const containerText = container.textContent || '';

    // Get all text nodes inside this container
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const ptag = parent.tagName.toLowerCase();
          if (SKIP_TAGS.has(ptag)) return NodeFilter.FILTER_REJECT;
          // Skip text nodes with no content
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
    if (textNodes.length === 0) continue;

    // Concatenate text from all text nodes, tracking positions
    let fullText = '';
    const nodeMap = []; // { node, start, len }
    for (const t of textNodes) {
      nodeMap.push({ node: t, start: fullText.length, len: t.textContent.length });
      fullText += t.textContent;
    }

    const fullLower = fullText.toLowerCase();

    // --- Punctuation-free matching (added 2026-09-15) ---
    // Build a punctuation-free version of the text + a position map that
    // lets us convert match positions back to original text positions.
    // This handles "spiderman" matching "Spider-Man" (hyphen within a word)
    // AND "spider man" matching "Spider-Man: Brand New Day" (punctuation
    // between words).
    let fullNoPunct = '';
    const posMap = []; // posMap[i] = position in fullLower of the i-th alphanumeric char
    for (let pi = 0; pi < fullLower.length; pi++) {
      const ch = fullLower[pi];
      if (/[a-z0-9]/.test(ch)) {
        posMap.push(pi);
        fullNoPunct += ch;
      }
    }

    // Search for kwNoPunct in fullNoPunct using indexOf in a loop
    let searchIdx = 0;
    if (kwNoPunctLen > 0) {
      while (searchIdx <= fullNoPunct.length - kwNoPunctLen) {
        const foundIdx = fullNoPunct.indexOf(kwNoPunct, searchIdx);
        if (foundIdx === -1) break;

        // Map back to original text positions
        const idx = posMap[foundIdx];
        const lastCharPos = posMap[foundIdx + kwNoPunctLen - 1];
        const matchedLen = lastCharPos - idx + 1;
        const endIdx = idx + matchedLen;
        const before = idx > 0 ? fullLower[idx - 1] : '';
        const after = endIdx < fullLower.length ? fullLower[endIdx] : '';

        if (isWordBoundary(before) && isWordBoundary(after)) {
          // Find start and end text nodes
          let startNodeInfo = null;
          let endNodeInfo = null;
          for (const nm of nodeMap) {
            if (!startNodeInfo && idx >= nm.start && idx < nm.start + nm.len) {
              startNodeInfo = nm;
            }
            if (endIdx > nm.start && endIdx <= nm.start + nm.len) {
              endNodeInfo = nm;
            }
            if (startNodeInfo && endNodeInfo) break;
          }

          if (startNodeInfo && endNodeInfo) {
            const startOffset = idx - startNodeInfo.start;
            const endOffset = endIdx - endNodeInfo.start;
            const isMultiNode = startNodeInfo.node !== endNodeInfo.node;

            // Dedupe by start node + offset
            const dedupeKey = startNodeInfo.node.nodeName + ':' + startOffset + ':' + startNodeInfo.node.textContent.length;
            if (seenStarts.has(dedupeKey)) {
              searchIdx = foundIdx + 1;
              continue;
            }
            seenStarts.add(dedupeKey);

            // Classify position type
            let positionType = 'anywhere';
            if (HEADING_TAGS.has(containerTag)) {
              positionType = 'heading';
            } else if (BODY_TAGS.has(containerTag)) {
              positionType = 'body';
            }

            // Create a Range to get the bounding rect + count CSS line boxes
            let rect = null;
            let clientRectsCount = 1;
            try {
              const range = document.createRange();
              range.setStart(startNodeInfo.node, startOffset);
              range.setEnd(endNodeInfo.node, endOffset);
              const domRect = range.getBoundingClientRect();
              clientRectsCount = range.getClientRects().length;
              rect = {
                x: domRect.x, y: domRect.y, width: domRect.width, height: domRect.height,
                top: domRect.top, bottom: domRect.bottom, left: domRect.left, right: domRect.right,
              };
            } catch (e) {
              searchIdx = foundIdx + 1;
              continue;
            }

            const visible = rect && rect.width > 0 && rect.height > 0;

            // --- Gate 1: isInMainContent ---
            const MAIN_CONTENT_SELECTORS = [
              'article', 'main', '[role="main"]',
              '.article-body', '.article-content', '.story-body', '.story-content',
              '.post-content', '.entry-content', '.entry-body',
              '.content-body', '.article-text', '.article__body',
              '[data-article-body]', '[data-story-body]',
              '#article-body', '#story-body', '#main-content',
            ];
            let isInMainContent = false;
            let ancestor = container.parentElement;
            while (ancestor) {
              for (const sel of MAIN_CONTENT_SELECTORS) {
                const tag = ancestor.tagName.toLowerCase();
                const cls = ancestor.className || '';
                const id = ancestor.id || '';
                const role = ancestor.getAttribute && ancestor.getAttribute('role');
                if (sel === 'article' && tag === 'article') { isInMainContent = true; break; }
                if (sel === 'main' && tag === 'main') { isInMainContent = true; break; }
                if (sel === '[role="main"]' && role === 'main') { isInMainContent = true; break; }
                if (sel.startsWith('.') && sel.length > 1) {
                  const name = sel.slice(1);
                  if (cls.split(/\\s+/).includes(name) || cls.includes(name)) { isInMainContent = true; break; }
                }
                if (sel.startsWith('#') && sel.length > 1) {
                  if (id === sel.slice(1)) { isInMainContent = true; break; }
                }
                if (sel.startsWith('[data-') && ancestor.matches && ancestor.matches(sel)) {
                  isInMainContent = true; break;
                }
              }
              if (isInMainContent) break;
              ancestor = ancestor.parentElement;
            }

            // --- Gate 1: qualityScore ---
            const isSingleLine = clientRectsCount === 1;
            const isAbnormallyTall = rect ? rect.height > 80 : false;
            let qualityScore;
            if (isAbnormallyTall) qualityScore = 0;
            else if (isSingleLine && isInMainContent) qualityScore = 100;
            else if (isSingleLine && !isInMainContent) qualityScore = 60;
            else if (!isSingleLine && isInMainContent) qualityScore = 30;
            else qualityScore = 0;

            occurrences.push({
              id: occurrenceId++,
              positionType,
              containerTag,
              containerText: containerText.slice(0, 200),
              startOffsetInContainer: idx,
              matchedLength: matchedLen,
              isMultiNode,
              rect: rect || { x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 },
              visible,
              clientRectsCount,
              isInMainContent,
              qualityScore,
            });
          }
        }
        searchIdx = foundIdx + 1;
      }
    } else {
      // Fallback: literal indexOf (kwNoPunct is empty — keyword has no alphanumerics)
      while ((searchIdx = fullLower.indexOf(kwLower, searchIdx)) !== -1) {
        const idx = searchIdx;
        const endIdx = idx + kwLen;
        const before = idx > 0 ? fullLower[idx - 1] : '';
        const after = endIdx < fullLower.length ? fullLower[endIdx] : '';
        if (isWordBoundary(before) && isWordBoundary(after)) {
          let startNodeInfo = null;
          let endNodeInfo = null;
          for (const nm of nodeMap) {
            if (!startNodeInfo && idx >= nm.start && idx < nm.start + nm.len) startNodeInfo = nm;
            if (endIdx > nm.start && endIdx <= nm.start + nm.len) endNodeInfo = nm;
            if (startNodeInfo && endNodeInfo) break;
          }
          if (startNodeInfo && endNodeInfo) {
            const startOffset = idx - startNodeInfo.start;
            const endOffset = endIdx - endNodeInfo.start;
            const dedupeKey = startNodeInfo.node.nodeName + ':' + startOffset + ':' + startNodeInfo.node.textContent.length;
            if (seenStarts.has(dedupeKey)) { searchIdx += kwLen; continue; }
            seenStarts.add(dedupeKey);
            let positionType = 'anywhere';
            if (HEADING_TAGS.has(containerTag)) positionType = 'heading';
            else if (BODY_TAGS.has(containerTag)) positionType = 'body';
            let rect = null; let clientRectsCount = 1;
            try {
              const range = document.createRange();
              range.setStart(startNodeInfo.node, startOffset);
              range.setEnd(endNodeInfo.node, endOffset);
              const domRect = range.getBoundingClientRect();
              clientRectsCount = range.getClientRects().length;
              rect = { x: domRect.x, y: domRect.y, width: domRect.width, height: domRect.height, top: domRect.top, bottom: domRect.bottom, left: domRect.left, right: domRect.right };
            } catch (e) { searchIdx += kwLen; continue; }
            const visible = rect && rect.width > 0 && rect.height > 0;
            const isSingleLine = clientRectsCount === 1;
            const isAbnormallyTall = rect ? rect.height > 80 : false;
            let qualityScore;
            if (isAbnormallyTall) qualityScore = 0;
            else if (isSingleLine && isInMainContent) qualityScore = 100;
            else if (isSingleLine && !isInMainContent) qualityScore = 60;
            else if (!isSingleLine && isInMainContent) qualityScore = 30;
            else qualityScore = 0;
            occurrences.push({
              id: occurrenceId++, positionType, containerTag, containerText: containerText.slice(0, 200),
              startOffsetInContainer: idx, matchedLength: kwLen, isMultiNode: startNodeInfo.node !== endNodeInfo.node,
              rect: rect || { x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 },
              visible, clientRectsCount, isInMainContent, qualityScore,
            });
          }
        }
        searchIdx += kwLen;
      }
    }
  }

  // Sort by DOCUMENT order (top-to-bottom, left-to-right).
  // IMPORTANT: We must sort by document-relative position (rect.y + scrollY),
  // NOT viewport-relative position (rect.y). getBoundingClientRect() returns
  // viewport-relative coords, which change when the page is scrolled. If we
  // sort by viewport position, the occurrence at index N will be a DIFFERENT
  // element depending on the scroll position — which breaks Step 6, where we
  // re-run discovery after scrolling and expect the same index to refer to
  // the same occurrence.
  const sx = window.scrollX, sy = window.scrollY;
  occurrences.sort((a, b) => {
    const aDocY = a.rect.y + sy;
    const bDocY = b.rect.y + sy;
    if (aDocY !== bDocY) return aDocY - bDocY;
    const aDocX = a.rect.x + sx;
    const bDocX = b.rect.x + sx;
    return aDocX - bDocX;
  });

  // Re-assign IDs after sorting
  occurrences.forEach((o, i) => { o.id = i; });

  return {
    occurrences,
    total: occurrences.length,
    visible: occurrences.filter(o => o.visible).length,
    heading: occurrences.filter(o => o.positionType === 'heading').length,
    body: occurrences.filter(o => o.positionType === 'body').length,
    visibleHeading: occurrences.filter(o => o.visible && o.positionType === 'heading').length,
    visibleBody: occurrences.filter(o => o.visible && o.positionType === 'body').length,
  };
})()
`;

  const result = await page.evaluate(script);
  return result as DiscoverResult;
}

/**
 * Select 3 frames from discovered occurrences using quality-ranked pools.
 *
 * Gate 2 of the three-gate validation pipeline:
 *   - Gate 1 (discover.ts) tagged each occurrence with a qualityScore
 *     (100 = single-line + in-main-content, down to 0 = multi-line + sidebar).
 *   - This function picks the highest-scoring occurrence for each position
 *     AND returns the full ranked candidate pool for each, so the capture
 *     pipeline can fall back through them when Gate 3 rejects a frame.
 *
 * Position assignments:
 *   - Position 1 (headline): best-scored visible HEADING occurrence
 *   - Position 2 (body): best-scored visible BODY occurrence
 *     (Wikipedia infobox-aware: candidates below the infobox are preferred
 *      when scored equally — preserves the existing visual behavior)
 *   - Position 3 (anywhere): best-scored visible occurrence of any type
 *     not already used by positions 1 or 2
 *
 * Excluded entirely:
 *   - qualityScore === 0 (multi-line + sidebar) — never useful.
 *   - clientRectsCount > 1 (keyword wraps across 2+ CSS lines) — MULTI-LINE
 *     KEYWORD FIX (2026-09-14):
 *
 *     PROBLEM (user-reported, keyword "Blue Origin"):
 *       When a multi-word keyword wraps across lines — e.g., "Blue" at the
 *       end of one line and "Origin" at the start of the next — the yellow
 *       <mark> highlight renders as TWO separate boxes on different lines.
 *       In the final video this looks broken/weird. Previously these
 *       occurrences were "last resort" (qualityScore=30) and could be
 *       picked when better candidates were missing — and the new adaptive
 *       extra-frame harvesting (Pass 2/Pass 3 top-up) digs deeper into the
 *       candidate pools, surfacing them more often. Gate 3's pixel-level
 *       split detector misses tight line gaps (≤~20px) because the 10px
 *       dilation merges the two yellow boxes into one component.
 *
 *     FIX: filter them out here, at the DOM level. clientRectsCount is a
 *     DOM measurement (range.getClientRects().length in the discovery
 *     script — one rect per CSS line box the keyword's Range occupies),
 *     NOT pixel analysis. Filtering here also automatically excludes
 *     multi-line occurrences from the Pass 2/Pass 3 extra-frame pools,
 *     because captureExtraFrames() builds its unified pool from these
 *     same selection pools.
 *
 *     Trade-off: articles whose keyword occurrences are ALL multi-line
 *     will be skipped (selectFrames returns null → "insufficient_keyword").
 *     That's the correct behavior — a split-highlight frame is worse than
 *     a missing frame, and the pipeline proceeds with other articles.
 *
 * Returns null if any position has no usable candidates.
 */
export async function selectFrames(
  discover: DiscoverResult,
  options?: { page?: Page; url?: string }
): Promise<FrameSelection | null> {
  const visible = discover.occurrences.filter((o) => o.visible);

  // Requirement 1: ≥4 total visible occurrences
  if (visible.length < 4) return null;

  // Filter out:
  //   - qualityScore=0 occurrences (multi-line + sidebar — never use)
  //   - multi-line occurrences (clientRectsCount > 1 — keyword wraps across
  //     lines, produces split two-box highlight; see doc comment above)
  // Sort each pool by qualityScore DESC, then by document order ASC as a tiebreaker.
  const usable = visible.filter(
    (o) => o.qualityScore > 0 && o.clientRectsCount === 1
  );
  if (usable.length < 4) return null;

  const sortByQuality = (arr: KeywordOccurrence[]) =>
    arr
      .slice()
      .sort((a, b) => {
        if (b.qualityScore !== a.qualityScore) {
          return b.qualityScore - a.qualityScore;
        }
        // Tiebreaker: document order (top-to-bottom). rect.y is viewport-
        // relative, but at discover time scroll is at 0,0 so this is fine.
        return a.rect.y - b.rect.y;
      });

  // --- Position 1: Headline pool (visible headings, best quality first) ---
  const headlinePool = sortByQuality(
    usable.filter((o) => o.positionType === "heading")
  );
  if (headlinePool.length === 0) return null;

  // --- Position 2: Body pool (visible bodies, best quality first) ---
  // For body, we still apply the Wikipedia infobox-aware logic — but only
  // as a tiebreaker WITHIN the same qualityScore tier. The bodyPool itself
  // is the full ranked list; the picked `body` is the first element.
  let bodyPoolUnranked = sortByQuality(
    usable.filter((o) => o.positionType === "body")
  );
  if (bodyPoolUnranked.length === 0) return null;

  // Apply Wikipedia infobox-aware reordering within the top quality tier.
  bodyPoolUnranked = await reorderBodyPoolForInfobox(
    bodyPoolUnranked,
    options?.page,
    options?.url
  );

  // Exclude the headline pick from the body pool (an occurrence can't be both)
  const headline = headlinePool[0];
  const bodyPool = bodyPoolUnranked.filter((o) => o.id !== headline.id);
  if (bodyPool.length === 0) return null;
  const body = bodyPool[0];

  // --- Position 3: Anywhere pool (any usable occurrence not already used) ---
  const usedIds = new Set([headline.id, body.id]);
  const anywherePool = sortByQuality(
    usable.filter((o) => !usedIds.has(o.id))
  );
  if (anywherePool.length === 0) return null;
  const anywhere = anywherePool[0];

  return {
    headline,
    body,
    anywhere,
    headlinePool,
    bodyPool,
    anywherePool,
    totalOccurrences: discover.visible,
    headingCount: discover.visibleHeading,
    bodyCount: discover.visibleBody,
  };
}

/**
 * Reorder the body candidate pool using Wikipedia infobox-aware logic.
 *
 * Within the top qualityScore tier, prefer body occurrences that sit just
 * BELOW the article's infobox (the right-side summary box on Wikipedia).
 * This preserves the existing visual behavior where Frame 2 shows the
 * infobox in the upper portion of the cropped screenshot.
 *
 * - If the URL is not Wikipedia, or no infobox exists, or no candidates
 *   are in the "below infobox" zone, the pool is returned unchanged.
 * - Otherwise, candidates in the below-infobox zone are moved to the front
 *   of their quality tier (sorted by distance to infobox bottom).
 *
 * The pool remains a valid ranked list — Gate 3 can still fall back through it.
 */
async function reorderBodyPoolForInfobox(
  pool: KeywordOccurrence[],
  page?: Page,
  url?: string
): Promise<KeywordOccurrence[]> {
  if (!page || !url || !/wikipedia\.org/i.test(url)) return pool;
  if (pool.length === 0) return pool;

  // Query the infobox bounding rect.
  const infoboxRect = (await page
    .evaluate(`(() => {
      const infobox = document.querySelector('table.infobox');
      if (!infobox) return null;
      const r = infobox.getBoundingClientRect();
      return {
        docBottom: r.bottom + window.scrollY,
        docRight: r.right + window.scrollX,
      };
    })()`)
    .catch(() => null)) as { docBottom: number; docRight: number } | null;

  if (!infoboxRect) return pool;

  const BELOW_INFOBOX_MAX_PX = 400;
  const scrollY = (await page
    .evaluate("() => window.scrollY")
    .catch(() => 0)) as number;

  // Group pool by qualityScore tier, preserving the existing sort.
  // Within each tier, occurrences in the below-infobox zone move to the front.
  const tiers = new Map<number, KeywordOccurrence[]>();
  for (const o of pool) {
    const tier = o.qualityScore;
    if (!tiers.has(tier)) tiers.set(tier, []);
    tiers.get(tier)!.push(o);
  }

  const sortedTiers = Array.from(tiers.keys()).sort((a, b) => b - a);
  const reordered: KeywordOccurrence[] = [];
  for (const tier of sortedTiers) {
    const items = tiers.get(tier)!;
    const withDist = items.map((o) => {
      const docY = o.rect.y + scrollY;
      const docX = o.rect.x;
      const distanceBelow = docY - infoboxRect.docBottom;
      const inZone =
        distanceBelow >= 0 &&
        distanceBelow <= BELOW_INFOBOX_MAX_PX &&
        docX < infoboxRect.docRight;
      return { o, inZone, distanceBelow };
    });
    const inZone = withDist
      .filter((x) => x.inZone)
      .sort((a, b) => a.distanceBelow - b.distanceBelow)
      .map((x) => x.o);
    const outOfZone = withDist.filter((x) => !x.inZone).map((x) => x.o);
    reordered.push(...inZone, ...outOfZone);
  }

  return reordered;
}
