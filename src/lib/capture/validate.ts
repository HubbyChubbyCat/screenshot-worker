// Post-capture frame validation — Gate 3 of the three-gate pipeline.
//
// After screenshot.ts captures a frame, this module runs three pixel-level
// checks on the PNG to detect the three classes of bad frames:
//
//   1. isBlank:        >95% of pixels are the same color (white/empty page,
//                       lazy-load skeleton, overlay covering the keyword).
//                       Catches "blank frame" edge case.
//
//   2. yellowComponentCount: connected-components labeling on the yellow
//                       pixel mask. If > 1, the <mark> highlight painted
//                       as 2+ separate boxes → keyword is split across
//                       lines. Catches "split keyword" edge case that
//                       slipped past Gate 1 (rare, but possible with
//                       dynamic layout shifts between discover & capture).
//
//   3. yellowPixelRatio: yellow pixels / total pixels. Should be 0.3%-20%.
//                       Too few = highlight missing (overlay won, or CSS
//                       override). Too much = highlight bled into adjacent
//                       text (range capture grabbed too much).
//
// All three checks run in a single Sharp.raw() pass — ~30ms per 1920×1080
// frame, well under the 200ms settle delay.
//
// If validation fails, the caller (screenshot.ts) retries with the next-best
// occurrence from the ranked pool (Gate 2 output).

import sharp from "sharp";

export interface ValidationResult {
  // Overall pass/fail. True = frame is good, keep it.
  pass: boolean;
  // Human-readable reason for failure (empty string when pass=true).
  reason: string;
  // Individual check results (always populated, even on pass).
  isBlank: boolean;
  yellowComponentCount: number;
  yellowPixelRatio: number;
  // Diagnostics
  totalPixels: number;
  yellowPixels: number;
  dominantColor: { r: number; g: number; b: number };
  dominantColorRatio: number;
}

// Tunable thresholds. Conservative defaults — false negatives (rejecting
// good frames) are worse than false positives (letting a marginal frame
// through), because we have backup candidates to retry with.
const BLANK_DOMINANT_RATIO = 0.95; // >95% one color = blank
const YELLOW_MIN_RATIO = 0.003; // <0.3% yellow = highlight missing
const YELLOW_MAX_RATIO = 0.20; // >20% yellow = highlight bled
const YELLOW_MAX_COMPONENTS = 1; // >1 component = split keyword

// Yellow threshold — must match detectYellowCentroid() in screenshot.ts.
// Yellow #FFFF00 = R=255, G=255, B=0. We allow some slack for anti-aliasing.
function isYellow(r: number, g: number, b: number): boolean {
  return r > 220 && g > 220 && b < 80;
}

/**
 * Validate a captured frame PNG.
 *
 * @param pngBuffer  1920×1080 PNG buffer from screenshot.ts
 * @returns          ValidationResult with pass/fail + diagnostics
 */
export async function validateFrameImage(
  pngBuffer: Buffer
): Promise<ValidationResult> {
  const { data, info } = await sharp(pngBuffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const totalPixels = width * height;

  // --- Pass 1: color histogram + yellow mask + yellow pixel count ---
  // We track:
  //   - color histogram (quantized to 16 levels per channel = 4096 buckets)
  //     to find the dominant color and its ratio (for blank detection)
  //   - yellow pixel mask (boolean array, 1 byte per pixel) for connected-
  //     components labeling in pass 2
  const HIST_BUCKETS = 16;
  const hist = new Uint32Array(HIST_BUCKETS * HIST_BUCKETS * HIST_BUCKETS);
  const yellowMask = new Uint8Array(totalPixels);
  let yellowPixels = 0;

  // We'll also track the exact color of the first yellow pixel we see —
  // useful for debugging.
  let firstYellow: { r: number; g: number; b: number } | null = null;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * channels;
    for (let x = 0; x < width; x++) {
      const i = rowOffset + x * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      // Update histogram (quantize to 16 levels per channel)
      const ri = Math.floor(r / (256 / HIST_BUCKETS));
      const gi = Math.floor(g / (256 / HIST_BUCKETS));
      const bi = Math.floor(b / (256 / HIST_BUCKETS));
      hist[ri * HIST_BUCKETS * HIST_BUCKETS + gi * HIST_BUCKETS + bi]++;

      // Update yellow mask
      if (isYellow(r, g, b)) {
        yellowMask[x * height + y] = 1; // note: transposed for column-major access below
        // Actually, let's keep it row-major to match the loop above
        yellowMask[x * height + y] = 0; // undo
        yellowMask[y * width + x] = 1;
        yellowPixels++;
        if (!firstYellow) firstYellow = { r, g, b };
      }
    }
  }

  // Find dominant color
  let maxBucket = 0;
  let maxBucketIdx = 0;
  for (let i = 0; i < hist.length; i++) {
    if (hist[i] > maxBucket) {
      maxBucket = hist[i];
      maxBucketIdx = i;
    }
  }
  const dr = Math.floor(
    (Math.floor(maxBucketIdx / (HIST_BUCKETS * HIST_BUCKETS)) * 256) / HIST_BUCKETS +
    256 / HIST_BUCKETS / 2
  );
  const dg = Math.floor(
    (Math.floor((maxBucketIdx % (HIST_BUCKETS * HIST_BUCKETS)) / HIST_BUCKETS) * 256) /
      HIST_BUCKETS +
    256 / HIST_BUCKETS / 2
  );
  const db = Math.floor(
    ((maxBucketIdx % HIST_BUCKETS) * 256) / HIST_BUCKETS + 256 / HIST_BUCKETS / 2
  );
  const dominantColor = { r: dr, g: dg, b: db };
  const dominantColorRatio = maxBucket / totalPixels;

  // --- Check 1: isBlank ---
  const isBlank = dominantColorRatio >= BLANK_DOMINANT_RATIO;

  // --- Check 2: yellow pixel ratio ---
  const yellowPixelRatio = yellowPixels / totalPixels;

  // --- Check 3: connected components on yellow mask ---
  // IMPORTANT: We dilate the mask by a few pixels before labeling components.
  // Why? The <mark> background is painted yellow, but the LETTERS on top of
  // it are black/colored. Between letters (and especially between words like
  // "Dua" and "Lipa"), there are 5-15px-wide columns where NO yellow pixel
  // exists because the letter strokes cover the entire mark background in
  // that column. Without dilation, the connected-components count for a
  // 2-word keyword is always 2 (one box per word), even when the keyword
  // is correctly on a single line.
  //
  // Dilation by ~10px bridges these letter-gap columns while still detecting
  // real multi-line splits (where the vertical gap between lines is ~30-50px
  // — larger than the dilation kernel).
  const DILATION_RADIUS = 10; // px — bridges letter gaps, not line gaps
  const dilated = new Uint8Array(totalPixels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (yellowMask[y * width + x] === 1) {
        // Set this pixel + all neighbors within DILATION_RADIUS
        const y0 = Math.max(0, y - DILATION_RADIUS);
        const y1 = Math.min(height - 1, y + DILATION_RADIUS);
        const x0 = Math.max(0, x - DILATION_RADIUS);
        const x1 = Math.min(width - 1, x + DILATION_RADIUS);
        for (let dy = y0; dy <= y1; dy++) {
          for (let dx = x0; dx <= x1; dx++) {
            dilated[dy * width + dx] = 1;
          }
        }
      }
    }
  }

  // 4-connectivity flood fill on the DILATED mask.
  // We early-exit if we find >1 component, since that's already a failure.
  const visited = new Uint8Array(totalPixels);
  let componentCount = 0;
  const stack: number[] = [];

  for (let start = 0; start < totalPixels && componentCount <= YELLOW_MAX_COMPONENTS; start++) {
    if (dilated[start] === 0 || visited[start] === 1) continue;
    componentCount++;
    if (componentCount > YELLOW_MAX_COMPONENTS) break;

    // Flood fill this component
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    while (stack.length > 0) {
      const idx = stack.pop()!;
      const x = idx % width;
      const y = Math.floor(idx / width);
      // 4 neighbors
      if (x > 0) {
        const n = idx - 1;
        if (dilated[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          stack.push(n);
        }
      }
      if (x < width - 1) {
        const n = idx + 1;
        if (dilated[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          stack.push(n);
        }
      }
      if (y > 0) {
        const n = idx - width;
        if (dilated[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          stack.push(n);
        }
      }
      if (y < height - 1) {
        const n = idx + width;
        if (dilated[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          stack.push(n);
        }
      }
    }
  }

  // --- Final verdict ---
  let pass = true;
  const reasons: string[] = [];

  if (isBlank) {
    pass = false;
    reasons.push(
      `blank_frame:dominant_color_rgb(${dr},${dg},${db})_covers_${(dominantColorRatio * 100).toFixed(1)}%`
    );
  }

  if (yellowPixels === 0) {
    pass = false;
    reasons.push("no_yellow:highlight_missing");
  } else if (yellowPixelRatio < YELLOW_MIN_RATIO) {
    pass = false;
    reasons.push(
      `too_little_yellow:${(yellowPixelRatio * 100).toFixed(2)}%_below_${YELLOW_MIN_RATIO * 100}%`
    );
  } else if (yellowPixelRatio > YELLOW_MAX_RATIO) {
    pass = false;
    reasons.push(
      `too_much_yellow:${(yellowPixelRatio * 100).toFixed(2)}%_above_${YELLOW_MAX_RATIO * 100}%`
    );
  }

  if (yellowPixels > 0 && componentCount > YELLOW_MAX_COMPONENTS) {
    pass = false;
    reasons.push(
      `split_keyword:${componentCount}_yellow_components_expected_1`
    );
  }

  return {
    pass,
    reason: reasons.join("; "),
    isBlank,
    yellowComponentCount: componentCount,
    yellowPixelRatio,
    totalPixels,
    yellowPixels,
    dominantColor,
    dominantColorRatio,
  };
}
