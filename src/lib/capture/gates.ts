/**
 * Gate settings — controls which quality checks are enabled per job.
 *
 * Gates:
 *   g1 — Keyword discovery: is the keyword in the article's main content?
 *   g2 — Frame selection: is the keyword single-line, visible, normal shape?
 *   g3 — Pixel validation: does the yellow highlight appear in the screenshot?
 *   g4 — Final quota: do we have enough frames (15)?
 *
 * Stored as JSON string in the Job.gates column.
 * Default: all gates enabled.
 */

export interface GateSettings {
  g1: boolean; // Keyword discovery
  g2: boolean; // Frame selection (multi-line + tall-highlight checks)
  g3: boolean; // Pixel validation (blank frame + yellow detection)
  g4: boolean; // Final quota (backfill passes)
}

export const DEFAULT_GATES: GateSettings = {
  g1: true,
  g2: true,
  g3: true,
  g4: true,
};

export const GATE_LABELS: Record<keyof GateSettings, { name: string; description: string }> = {
  g1: {
    name: "Gate 1 — Keyword Discovery",
    description: "Checks if the article contains the keyword in its main content (not sidebars/ads). Disabling may accept articles without the keyword.",
  },
  g2: {
    name: "Gate 2 — Frame Selection",
    description: "Checks if the keyword is on a single line, visible, and not in a stretched container. Disabling allows multi-line and tall highlights.",
  },
  g3: {
    name: "Gate 3 — Pixel Validation",
    description: "Checks if the yellow highlight actually appears in the captured screenshot. Disabling accepts frames even if the highlight is missing or the frame is blank.",
  },
  g4: {
    name: "Gate 4 — Final Quota",
    description: "Runs backfill passes to reach 15 frames if not enough articles succeeded. Disabling skips backfill — you may get fewer than 15 frames.",
  },
};

/**
 * Parse gate settings from the JSON string stored in the database.
 * Returns defaults if parsing fails.
 */
export function parseGates(json: string | null | undefined): GateSettings {
  if (!json) return { ...DEFAULT_GATES };
  try {
    const parsed = JSON.parse(json);
    return {
      g1: parsed.g1 ?? true,
      g2: parsed.g2 ?? true,
      g3: parsed.g3 ?? true,
      g4: parsed.g4 ?? true,
    };
  } catch {
    return { ...DEFAULT_GATES };
  }
}

/**
 * Serialize gate settings to a JSON string for database storage.
 */
export function serializeGates(gates: GateSettings): string {
  return JSON.stringify(gates);
}
