// Cookie banner / overlay / CMP cleanup
//
// Strategy:
// 1. Inject a <style> block that hides ~30 common consent/overlay selectors
//    with display:none !important. This is non-destructive (we don't remove
//    the elements, just hide them) so the page DOM stays intact for keyword
//    discovery in Step 5.
// 2. Auto-click common "Accept" / "I Agree" / "Got it" / "Consent" buttons
//    by visible text. Many CMPs don't actually dismiss until you click.
// 3. Remove scroll locks (body { overflow: hidden }) that CMPs add to trap
//    the user.
// 4. Wait briefly for any post-dismiss animations to settle.
//
// We don't try to handle every CMP vendor — just the most common patterns.
// Sites that hard-block content behind a paywall are skipped in render.ts.

import type { Page } from "playwright";

// CSS selectors for common consent/overlay containers.
// Order doesn't matter — they're all hidden with display:none.
const HIDE_SELECTORS = [
  // Generic consent IDs
  "#onetrust-banner-sdk",
  "#onetrust-consent-sdk",
  "#onetrust-accept-all-handler",
  ".onetrust-pc-dark-filter",
  "#consent-banner",
  "#consent-modal",
  "#consent-container",
  "#cookie-banner",
  "#cookieBanner",
  "#cookieConsent",
  "#cookie-consent",
  "#cookie-notice",
  "#cookieNotice",
  "#cookie-bar",
  "#cookieBar",
  "#gdpr-banner",
  "#gdprConsent",
  "#cmp-banner",
  "#cmp-container",
  "#cmp-modal",
  "#sp_message_container_",
  ".sp_message_container",
  "#truste-consent-track",
  ".truste-consent-track",
  // Generic consent classes
  ".cookie-banner",
  ".cookieBanner",
  ".cookie-consent",
  ".cookieConsent",
  ".cookie-notice",
  ".cookie-notice__wrapper",
  ".cookies-banner",
  ".consent-banner",
  ".consent-banner__container",
  ".gdpr-banner",
  ".gdpr-consent",
  ".cmp-banner",
  ".cmp-modal",
  ".privacy-banner",
  ".privacy-notice",
  ".site-notice",
  ".overlay-bg",
  ".modal-backdrop",
  ".scrim",
  // Publisher-specific
  ".gdpr-dda",
  ".gdpr-ddb",
  ".qc-cmp2-container",
  ".qc-cmp2-summary-screen",
  "#_evidon_banner",
  "#_evidon-background",
  ".evidon-banner",
  ".cc-banner",
  ".cc-window",
  ".cc-popup",
  "#cmp-ui",
  ".tp-active",
  "#tp-active",
  ".tp-modal",
  ".tp-backdrop",
  "._fc_m_modal",
  ".fc-dialog-container",
  ".fancybox-container",
  // Newsletter / signup overlays (not consent but block the page)
  ".newsletter-modal",
  ".signup-modal",
  ".paywall-modal",
  ".reg-modal",
  ".registration-modal",
  ".auth-modal",
];

// Build the CSS rule. We use :is() for compactness and broad browser support
// in Chromium 131+.
function buildHideCss(): string {
  const selectorList = HIDE_SELECTORS.join(",\n  ");
  return `
${selectorList} {
  display: none !important;
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
/* Unlock body scroll that CMPs usually force */
html, body {
  overflow: auto !important;
  position: static !important;
  height: auto !important;
  max-height: none !important;
}
/* Remove the dark backdrop that some CMPs add to body */
body > div[style*="fixed"],
body > div[style*="absolute"] {
  background: transparent !important;
}
`;
}

// Clickable button text patterns (lowercase).
// We EXACT match (after lowercasing + trimming + stripping trailing punctuation)
// against the button's visible text. This avoids false positives like
// "ok" matching "Facebook" or "yes" matching "eyes".
//
// Only patterns that are unambiguously consent-related are listed.
// Generic short patterns like "ok" / "yes" / "close" are intentionally
// omitted because they can match important action buttons on the page.
const ACCEPT_BUTTON_PATTERNS = [
  "accept all",
  "accept all cookies",
  "accept cookies",
  "i accept",
  "agree to all",
  "agree and continue",
  "i agree",
  "agree",
  "got it",
  "allow all",
  "allow cookies",
  "i consent",
  "accept & continue",
  "accept and continue",
  "yes, i accept",
  "accept",
  "consent",
  "continue",
  "okay",
  "not now",
  "no thanks",
  "maybe later",
];

export interface CleanupResult {
  hiddenSelectors: number;
  clickedButtons: string[];
  durationMs: number;
}

/**
 * Cleanup cookie banners, CMP overlays, and newsletter modals from a page.
 * Should be called after the page has had a chance to render its overlays
 * (typically 2-3 seconds after navigation).
 */
export async function cleanupOverlays(page: Page): Promise<CleanupResult> {
  const start = Date.now();
  const clickedButtons: string[] = [];

  // 1. Inject hide CSS
  await page
    .addStyleTag({ content: buildHideCss() })
    .catch((e) => console.warn("[cleanup] addStyleTag failed:", e));

  // 2. Try clicking common Accept buttons by visible text.
  //    Use EXACT match (trimmed lowercase text === pattern, ignoring
  //    trailing punctuation) instead of substring match — substring matching
  //    causes false positives like "ok" matching "Facebook".
  //
  //    For each pattern, we iterate up to 30 visible buttons on the page and
  //    click the first one whose trimmed text exactly matches. We also check
  //    the button is reasonably sized (>= 50x20 px) to avoid clicking tiny
  //    nav icons.
  const allButtons = page.locator(
    `button, [role="button"], a[role="button"], input[type="button"]`
  );
  const buttonCount = Math.min(await allButtons.count().catch(() => 0), 50);

  if (buttonCount > 0) {
    // Collect each button's text + visibility in one pass for efficiency
    const buttonInfos: { text: string; idx: number; box: { width: number; height: number } | null }[] = [];
    for (let i = 0; i < buttonCount; i++) {
      const el = allButtons.nth(i);
      const isVisible = await el.isVisible().catch(() => false);
      if (!isVisible) continue;
      const text = ((await el.textContent().catch(() => "")) ?? "").trim().toLowerCase().replace(/[.!?:]+$/, "");
      if (text.length === 0 || text.length > 40) continue;
      const box = await el.boundingBox().catch(() => null);
      if (!box || box.width < 50 || box.height < 20) continue;
      buttonInfos.push({ text, idx: i, box });
    }

    // Click first button matching any pattern (single pass per button)
    for (const info of buttonInfos) {
      if (!ACCEPT_BUTTON_PATTERNS.includes(info.text)) continue;
      try {
        const el = allButtons.nth(info.idx);
        // Re-check visibility (CMP may have removed it)
        const stillVisible = await el.isVisible().catch(() => false);
        if (!stillVisible) continue;
        await el.click({ timeout: 1500 });
        clickedButtons.push(info.text);
        break; // Only click one Accept button per page
      } catch {
        // Click failed — element may have moved or been removed; continue
      }
    }
  }

  // 3. Give the page a moment to react to clicks (some CMPs fade out)
  if (clickedButtons.length > 0) {
    await page.waitForTimeout(500).catch(() => {});
  }

  return {
    hiddenSelectors: HIDE_SELECTORS.length,
    clickedButtons,
    durationMs: Date.now() - start,
  };
}
