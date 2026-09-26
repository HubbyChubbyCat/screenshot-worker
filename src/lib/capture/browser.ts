// Stealth Chromium launcher for Playwright
//
// Why "stealth" without playwright-extra + stealth plugin?
// - The full puppeteer-extra-plugin-stealth ships a dozen evasion patches, but
//   most news sites we hit via Google News RSS only check the easy signals:
//   navigator.webdriver, the missing navigator.plugins/languages, the
//   "Chrome" string in userAgent, and the headless UA suffix.
// - We replicate those checks in a small init script. Good enough for V1
//   and avoids an extra dependency that needs to track Playwright versions.
//
// Browser binary resolution:
// - Playwright 1.61.1 expects chromium-1228 at the standard cache path:
//   /home/z/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome
// - We let Playwright resolve the path by default (don't override
//   executablePath) so future Playwright upgrades work without code changes.
// - If PLAYWRIGHT_BROWSERS_PATH is set in env, Playwright will honor it.

import { chromium, type Browser, type BrowserContext } from "playwright";

const STEALTH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const STEALTH_UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// Init script that patches the most common bot-detection signals.
// Runs in every frame before any page script.
const STEALTH_INIT_SCRIPT = `
(() => {
  // 1. Hide webdriver flag
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  } catch (e) {}

  // 2. Mock plugins (real Chrome has PDF viewer + Native Client)
  try {
    const makePlugin = (name, filename, description) => ({
      name, filename, description,
      length: 1,
      0: { type: 'application/pdf', suffixes: 'pdf', description: '' },
    });
    const plugins = [
      makePlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      makePlugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      makePlugin('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      makePlugin('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      makePlugin('WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format'),
    ];
    Object.defineProperty(navigator, 'plugins', {
      get: () => plugins,
    });
  } catch (e) {}

  // 3. Mock mimeTypes
  try {
    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => [
        { type: 'application/pdf', suffixes: 'pdf', description: '' },
        { type: 'text/pdf', suffixes: 'pdf', description: '' },
      ],
    });
  } catch (e) {}

  // 4. Realistic languages
  try {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
  } catch (e) {}

  // 5. Permissions API: pretend notifications are default (not denied like headless)
  try {
    const origQuery = navigator.permissions && navigator.permissions.query;
    if (origQuery) {
      navigator.permissions.query = (params) =>
        params && params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission || 'default' })
          : origQuery.call(navigator.permissions, params);
    }
  } catch (e) {}

  // 6. WebGL vendor/renderer — headless Chrome reports "Google Inc. (Google)"
  // which is a fingerprint. Real Chrome reports "Intel Inc." / "Intel(R) Iris(TM)..."
  try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param) {
      // UNMASKED_VENDOR_WEBGL = 37445
      if (param === 37445) return 'Intel Inc.';
      // UNMASKED_RENDERER_WEBGL = 37446
      if (param === 37446) return 'Intel(R) Iris(TM) Plus Graphics 640';
      return getParameter.call(this, param);
    };
  } catch (e) {}

  // 7. Chrome runtime — real Chrome has window.chrome object
  try {
    if (!window.chrome) {
      // @ts-ignore
      window.chrome = { runtime: {}, app: { isInstalled: false } };
    }
  } catch (e) {}

  // 8. Hardware concurrency — headless default is 2, real is usually 8 or 12
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  } catch (e) {}

  // 9. Device memory — headless default is 0.5, real is 4 or 8
  try {
    // @ts-ignore
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  } catch (e) {}
})();
`;

export interface LaunchOptions {
  mobile?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
}

/**
 * Launch a stealth Chromium browser. Caller is responsible for browser.close().
 */
export async function launchStealthBrowser(opts: LaunchOptions = {}): Promise<Browser> {
  const mobile = opts.mobile ?? false;
  const viewportWidth = opts.viewportWidth ?? 1920;
  const viewportHeight = opts.viewportHeight ?? 1080;

  const browser = await chromium.launch({
    headless: true,
    args: [
      // Disable the "Chrome is being controlled by automated software" banner
      "--disable-blink-features=AutomationControlled",
      // Sandbox needs to be disabled when running as root in containers
      "--no-sandbox",
      "--disable-setuid-sandbox",
      // /dev/shm is small in many containers; use /tmp instead to avoid crashes
      "--disable-dev-shm-usage",
      // Disable GPU — not needed for headless text rendering
      "--disable-gpu",
      // Mute audio (we're capturing text only)
      "--mute-audio",
      // Ignore certificate errors (some news sites have stale certs)
      "--ignore-certificate-errors",
      // Disable background timers/throttling so lazy-loaded content loads
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      // ------------------------------------------------------------------
      // MEMORY GUARDS (OOM protection — the server has 3.9GB RAM, no swap.
      // A runaway page previously ballooned Chromium to 1.2GB+ RSS and the
      // kernel OOM-killed chrome AND the Next.js server).
      // ------------------------------------------------------------------
      // Cap each renderer's V8 JS heap at 256MB. A page that wants more than
      // that gets a JS error (its capture will fail validation) instead of
      // eating the machine's RAM and killing the whole pipeline.
      "--js-flags=--max-old-space-size=256",
      // One renderer process per site (not per site-instance) — fewer
      // processes = less baseline memory overhead across 50+ article loads.
      "--process-per-site",
      // Hard cap on renderer process count.
      "--renderer-process-limit=4",
      // Fewer utility processes (network service stays, but audio/display
      // compositor threads are trimmed where possible).
      "--disable-features=Translate,BackForwardCache,MediaRouter",
      // Realistic window size
      `--window-size=${viewportWidth},${viewportHeight}`,
    ],
  });

  return browser;
}

/**
 * Create a new browser context with stealth settings applied.
 * Returns the context — caller manages its lifecycle.
 */
export async function newStealthContext(
  browser: Browser,
  opts: LaunchOptions = {}
): Promise<BrowserContext> {
  const mobile = opts.mobile ?? false;
  const viewportWidth = opts.viewportWidth ?? 1920;
  const viewportHeight = opts.viewportHeight ?? 1080;

  const context = await browser.newContext({
    userAgent: mobile ? STEALTH_UA_MOBILE : STEALTH_UA,
    viewport: { width: viewportWidth, height: viewportHeight },
    locale: "en-US",
    timezoneId: "America/New_York",
    geolocation: { latitude: 40.7128, longitude: -74.006 }, // NYC
    permissions: ["geolocation"],
    colorScheme: "light",
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
    hasTouch: mobile,
    isMobile: mobile,
    // Extra HTTP headers that real Chrome sends
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      "sec-ch-ua":
        '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      "sec-ch-ua-mobile": mobile ? "?1" : "?0",
      "sec-ch-ua-platform": mobile ? '"Android"' : '"macOS"',
    },
    // Ignore HTTPS errors for stale-cert sites
    ignoreHTTPSErrors: true,
  });

  // Apply stealth init script to every new page in this context
  await context.addInitScript(STEALTH_INIT_SCRIPT);

  // Block heavy resources we don't need. Two tiers:
  //
  // TIER 1 — known ad/analytics domains (bot-detection-safe blocklist).
  //
  // TIER 2 — memory-hog RESOURCE TYPES, blocked by type regardless of domain.
  //   media (video/audio): the #1 Chromium memory hog — a single autoplay
  //     video can buffer hundreds of MB. The pipeline captures TEXT with a
  //     yellow <mark> highlight; videos contribute nothing.
  //   font: web fonts add download + decode memory; system fallback fonts
  //     render fine and the DOM-based highlight pipeline is unaffected.
  //   cross-origin iframe documents: embedded players/ad frames each spawn
  //     heavy rendering work. News articles never need them.
  //
  // Images and stylesheets remain ALLOWED (frame fidelity + site layouts).
  // All blocking is request-level (Playwright route interception) — pure
  // network-layer filtering, no pixel analysis, no DOM distortion: the
  // keyword text, layout containers, and highlight mechanics are untouched.
  const blockPatterns: RegExp[] = [
    /googlesyndication\.com/i,
    /doubleclick\.net/i,
    /googletagmanager\.com/i,
    /google-analytics\.com/i,
    /analytics\.google\.com/i,
    /connect\.facebook\.net/i,
    /platform\.twitter\.com/i,
    /platform\.linkedin\.com/i,
    /adservice\.google\.com/i,
    /amazon-adsystem\.com/i,
    /criteo\.com/i,
    /scorecardresearch\.com/i,
    /quantserve\.com/i,
    // Common embedded video players (heavy media decoders)
    /youtube(-nocookie)?\.com\/embed\//i,
    /player\.vimeo\.com/i,
    /brightcove\.net/i,
    /jwplayer\.com/i,
    /jwplatform\.com/i,
    /dailymotion\.com\/embed\//i,
    /facebook\.com\/plugins\//i,
    /tiktok\.com\/embed\//i,
  ];
  await context.route(
    (url) => {
      const href = url.toString();
      return blockPatterns.some((p) => p.test(href));
    },
    (route) => route.abort().catch(() => {})
  );

  // TIER 2 handler — resource-type based blocking.
  await context.route(
    (url) => true, // inspect every request; decide by type below
    (route) => {
      try {
        const req = route.request();
        const type = req.resourceType();

        // Videos / audio / fonts — always block.
        if (type === "media" || type === "font") {
          route.abort().catch(() => {});
          return;
        }

        // Cross-origin iframe documents — block. The main-frame navigation
        // (the article itself) is exempt. Fail-open if frame introspection
        // throws (detached frames) so legit navigation is never broken.
        if (type === "document" && req.isNavigationRequest()) {
          const frame = req.frame();
          const mainFrame = frame?.page()?.mainFrame?.();
          if (mainFrame && frame !== mainFrame) {
            // This is an iframe document load — allow only same-host embeds.
            try {
              const reqHost = new URL(req.url()).hostname;
              const parentUrl = frame.parentFrame()?.url() ?? mainFrame.url();
              const parentHost = new URL(parentUrl).hostname;
              if (reqHost !== parentHost) {
                route.abort().catch(() => {});
                return;
              }
            } catch {
              route.abort().catch(() => {});
              return;
            }
          }
        }

        route.continue().catch(() => {});
      } catch {
        route.continue().catch(() => {});
      }
    }
  );

  return context;
}
