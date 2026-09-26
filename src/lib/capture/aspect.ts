/**
 * Aspect ratio configuration for the News Match Cut pipeline.
 *
 * Each aspect ratio defines:
 *   - width:  the native capture + output width in pixels
 *   - height: the native capture + output height in pixels
 *   - targetWidthRatio: what fraction of the frame width the keyword should
 *     fill (used by computeZoom/computeAutoZoom). Calibrated per aspect ratio
 *     so the keyword is ~250px regardless of orientation:
 *       16:9 → 0.13 × 1920 = 250px
 *       9:16 → 0.23 × 1080 = 248px
 *       1:1  → 0.23 × 1080 = 248px
 *
 * Native capture means the browser viewport, screenshot crop, and final MP4
 * are ALL set to the target dimensions — no letterboxing or post-crop. This
 * ensures the composition and framing are optimized for each ratio:
 *   - 16:9 (1920×1080): landscape, standard YouTube/video
 *   - 9:16 (1080×1920): vertical, Shorts/Reels/TikTok
 *   - 1:1  (1080×1080): square, Instagram feed
 */

export const ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export interface AspectConfig {
  width: number;
  height: number;
  targetWidthRatio: number;
}

export const ASPECT_CONFIGS: Record<AspectRatio, AspectConfig> = {
  "16:9": { width: 1920, height: 1080, targetWidthRatio: 0.13 },
  "9:16": { width: 1080, height: 1920, targetWidthRatio: 0.23 },
  "1:1": { width: 1080, height: 1080, targetWidthRatio: 0.23 },
};

/**
 * Get the dimensions + targetWidthRatio for a given aspect ratio string.
 * Falls back to 16:9 if the string is unrecognized (defensive — should
 * never happen since Zod validates the input, but protects against old
 * DB rows or manual edits).
 */
export function getAspectConfig(ar: string | null | undefined): AspectConfig {
  if (ar && ar in ASPECT_CONFIGS) {
    return ASPECT_CONFIGS[ar as AspectRatio];
  }
  return ASPECT_CONFIGS["16:9"];
}

/**
 * Get just the viewport dimensions for a given aspect ratio.
 * Used by launchStealthBrowser / newStealthContext.
 */
export function dimsForAspect(ar: string | null | undefined): { width: number; height: number } {
  const cfg = getAspectConfig(ar);
  return { width: cfg.width, height: cfg.height };
}

/**
 * Check if an aspect ratio string is valid.
 */
export function isValidAspectRatio(ar: string): ar is AspectRatio {
  return ASPECT_RATIOS.includes(ar as AspectRatio);
}

// ─────────────────────────────────────────────────────────────────────
// Zoom level configuration
// ─────────────────────────────────────────────────────────────────────

export const ZOOM_LEVELS = ["auto", "low", "medium", "high"] as const;
export type ZoomLevel = (typeof ZOOM_LEVELS)[number];

export interface ZoomConfig {
  minZoom: number;
  maxZoom: number;
}

export const ZOOM_CONFIGS: Record<ZoomLevel, ZoomConfig> = {
  auto: { minZoom: 1.0, maxZoom: 4.0 },
  low: { minZoom: 1.0, maxZoom: 1.5 },
  medium: { minZoom: 1.5, maxZoom: 2.5 },
  high: { minZoom: 2.5, maxZoom: 4.0 },
};

export function getZoomConfig(level: string | null | undefined): ZoomConfig {
  if (level && level in ZOOM_CONFIGS) {
    return ZOOM_CONFIGS[level as ZoomLevel];
  }
  return ZOOM_CONFIGS.auto;
}
