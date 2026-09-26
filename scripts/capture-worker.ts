/**
 * Standalone capture worker — runs inside GitHub Actions.
 *
 * This script is triggered by the GitHub Action workflow when the backend
 * sends a `repository_dispatch` event with the article URL + keyword.
 *
 * It runs the FULL capture pipeline (discover → highlight → capture → validate)
 * and POSTs the captured frame PNGs back to the backend's callback endpoint.
 *
 * Usage (inside GitHub Action):
 *   npx tsx scripts/capture-worker.ts
 *
 * Environment variables (set by the workflow from client_payload):
 *   TARGET_URL       — article URL to capture
 *   KEYWORD          — keyword to highlight
 *   ASPECT_RATIO     — "16:9" | "9:16" | "1:1"
 *   JOB_ID           — backend job ID (for callback)
 *   ARTICLE_ID       — backend article ID (for callback)
 *   CALLBACK_URL     — backend URL to POST results to
 *   ARTICLE_TITLE    — optional title (for synthetic/reader routes)
 *   WIKIPEDIA_SECTION — optional section index (for wikipedia re-renders)
 */

import { launchStealthBrowser, newStealthContext } from "../src/lib/capture/browser";
import { renderArticle } from "../src/lib/capture/render";
import { getAspectConfig, getZoomConfig } from "../src/lib/capture/aspect";

interface CapturedFramePayload {
  position: string;
  occurrenceIndex: number;
  imageBase64: string;
  centerX: number;
  centerY: number;
  zoomFactor: number;
  wasClamped: boolean;
}

interface CallbackPayload {
  jobId: string;
  articleId: string;
  url: string;
  success: boolean;
  title?: string;
  routeUsed?: string;
  finalUrl?: string;
  keywordCount?: number;
  skipReason?: string;
  frames?: CapturedFramePayload[];
  error?: string;
}

async function main() {
  const targetUrl = process.env.TARGET_URL;
  const keyword = process.env.KEYWORD;
  const aspectRatio = process.env.ASPECT_RATIO || "16:9";
  const zoomLevel = process.env.ZOOM_LEVEL || "auto";
  // Parse gates string: "g1:true,g2:true,g3:true"
  const gatesRaw = process.env.GATES || "g1:true,g2:true,g3:true";
  const gateG2 = gatesRaw.includes("g2:true");
  const gateG3 = gatesRaw.includes("g3:true");
  const jobId = process.env.JOB_ID;
  const articleId = process.env.ARTICLE_ID;
  // The CALLBACK_URL secret is the BASE server URL (e.g., https://preview-xxx.space-z.ai)
  // We construct the full callback path using the job ID
  const callbackBaseUrl = process.env.CALLBACK_URL?.replace(/\/$/, "");
  const callbackUrl = callbackBaseUrl
    ? `${callbackBaseUrl}/api/jobs/${jobId}/frame-callback`
    : process.env.CALLBACK_URL; // fallback to old format if base URL not available
  const articleTitle = process.env.ARTICLE_TITLE || null;
  const wikipediaSection = process.env.WIKIPEDIA_SECTION
    ? parseInt(process.env.WIKIPEDIA_SECTION, 10)
    : undefined;

  // Validate required env vars
  if (!targetUrl || !keyword || !jobId || !articleId || !callbackUrl) {
    console.error("Missing required environment variables");
    console.error("Required: TARGET_URL, KEYWORD, JOB_ID, ARTICLE_ID, CALLBACK_URL");
    process.exit(1);
  }

  console.log(`[capture-worker] Starting capture for job=${jobId} article=${articleId}`);
  console.log(`[capture-worker] URL: ${targetUrl}`);
  console.log(`[capture-worker] Keyword: ${keyword}`);
  console.log(`[capture-worker] Aspect: ${aspectRatio}`);

  const aspectCfg = getAspectConfig(aspectRatio);
  const zoomCfg = getZoomConfig(zoomLevel);
  console.log(`[capture-worker] Viewport: ${aspectCfg.width}x${aspectCfg.height} Zoom: ${zoomLevel}(${zoomCfg.minZoom}-${zoomCfg.maxZoom})`);

  const callbackPayload: CallbackPayload = {
    jobId,
    articleId,
    url: targetUrl,
    success: false,
  };

  let browser;
  try {
    // Launch stealth browser with the correct viewport for the aspect ratio
    browser = await launchStealthBrowser({
      viewportWidth: aspectCfg.width,
      viewportHeight: aspectCfg.height,
    });
    const context = await newStealthContext(browser, {
      viewportWidth: aspectCfg.width,
      viewportHeight: aspectCfg.height,
    });

    console.log("[capture-worker] Browser launched, rendering article...");

    // Run the full capture pipeline
    const result = await renderArticle(context, targetUrl, {
      keyword,
      captureScreenshots: true,
      articleTitle,
      wikipediaSection,
      screenshotOpts: {
        targetWidthRatio: aspectCfg.targetWidthRatio,
        minZoom: zoomCfg.minZoom,
        maxZoom: zoomCfg.maxZoom,
        frameWidth: aspectCfg.width,
        frameHeight: aspectCfg.height,
        gateG2,
        gateG3,
      },
    });

    console.log(`[capture-worker] Result: ${result.outcome}`);
    if (result.skipReason) {
      console.log(`[capture-worker] Skip reason: ${result.skipReason}`);
    }

    if (result.outcome === "accepted" && result.capturedFrames && result.capturedFrames.length > 0) {
      callbackPayload.success = true;
      callbackPayload.title = result.title ?? undefined;
      callbackPayload.routeUsed = result.routeUsed ?? undefined;
      callbackPayload.finalUrl = result.finalUrl ?? undefined;
      callbackPayload.keywordCount = result.keywordDiscover?.visible;

      // Convert captured frames to base64 for the callback
      callbackPayload.frames = result.capturedFrames.map((f) => ({
        position: f.positionType,
        occurrenceIndex: f.occurrenceIndex,
        imageBase64: f.imageBuffer.toString("base64"),
        centerX: f.centerX,
        centerY: f.centerY,
        zoomFactor: f.zoomFactor,
        wasClamped: f.wasClamped,
      }));

      console.log(`[capture-worker] Captured ${callbackPayload.frames.length} frames`);
    } else {
      callbackPayload.success = false;
      // Always set a descriptive skip reason for debugging
      if (result.outcome === "accepted" && (!result.capturedFrames || result.capturedFrames.length === 0)) {
        // Article was accepted (keyword found) but 0 frames captured (Gate 3 rejected all)
        callbackPayload.skipReason = "accepted_but_no_frames:gate3_rejected_all";
      } else {
        callbackPayload.skipReason = result.skipReason || `render_outcome:${result.outcome}`;
      }
      callbackPayload.title = result.title ?? undefined;
      callbackPayload.routeUsed = result.routeUsed ?? undefined;
      callbackPayload.finalUrl = result.finalUrl ?? undefined;
    }

    await context.close().catch(() => {});
  } catch (err) {
    console.error("[capture-worker] ERROR:", err);
    callbackPayload.success = false;
    callbackPayload.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
      try {
        browser.process()?.kill("SIGKILL");
      } catch {}
    }
  }

  // POST results back to the backend
  console.log(`[capture-worker] Sending callback to ${callbackUrl}`);
  console.log(`[capture-worker] Success: ${callbackPayload.success}`);
  console.log(`[capture-worker] Frames: ${callbackPayload.frames?.length ?? 0}`);

  try {
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(callbackPayload),
    });

    if (response.ok) {
      console.log("[capture-worker] Callback sent successfully");
    } else {
      console.error(`[capture-worker] Callback failed: HTTP ${response.status}`);
      const text = await response.text().catch(() => "");
      console.error(`[capture-worker] Response: ${text.substring(0, 500)}`);
    }
  } catch (err) {
    console.error("[capture-worker] Callback error:", err);
  }

  console.log("[capture-worker] Done");
}

main().catch((err) => {
  console.error("[capture-worker] FATAL:", err);
  process.exit(1);
});
