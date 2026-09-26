// Per-domain capture success scoreboard — Tier C self-healing.
//
// Every capture attempt records its outcome for the publisher's domain in the
// DomainStat table. Discovery uses these stats to RANK candidates before the
// capture worker runs: domains that historically capture successfully are
// tried first; domains that always get blocked/paywalled sink to the end of
// the candidate list (they're still tried — last — because the fallback
// ladder might rescue them via a snapshot route).
//
// This is deliberately simple:
//   - Success rate = successes / attempts.
//   - Unknown domains score 0.5 (neutral) so new sources aren't penalized.
//   - Domains with very few attempts (<3) are pulled toward neutral to avoid
//     a single unlucky sample burying a good domain forever.
//   - Ties keep the original discovery order (stable sort).

import { db } from "@/lib/db";

/**
 * Record one capture attempt outcome for a domain. Never throws — scoreboard
 * updates must never break the capture pipeline.
 */
export async function recordDomainOutcome(
  domain: string | null,
  ok: boolean,
  reason?: string | null
): Promise<void> {
  if (!domain) return;
  const clean = domain.replace(/^www\./i, "").toLowerCase();
  if (!clean || clean.length < 3) return;

  try {
    const now = new Date();
    await db.domainStat.upsert({
      where: { domain: clean },
      create: {
        domain: clean,
        attempts: 1,
        successes: ok ? 1 : 0,
        failures: ok ? 0 : 1,
        lastSuccessAt: ok ? now : null,
        lastFailAt: ok ? null : now,
        lastFailReason: ok ? null : (reason ?? null),
      },
      update: {
        attempts: { increment: 1 },
        successes: ok ? { increment: 1 } : undefined,
        failures: ok ? undefined : { increment: 1 },
        lastSuccessAt: ok ? now : undefined,
        lastFailAt: ok ? undefined : now,
        lastFailReason: ok ? null : (reason ?? undefined),
      },
    });
  } catch (err) {
    console.warn(
      `[domains] failed to record outcome for ${clean}:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}

/** Score of one domain from its stat row (0..1, higher = better). */
function domainScore(row: {
  attempts: number;
  successes: number;
}): number {
  if (row.attempts <= 0) return 0.5;
  const raw = row.successes / row.attempts;
  if (row.attempts >= 3) return raw;
  // Shrink toward neutral (0.5) until we have a meaningful sample.
  const w = row.attempts / 3;
  return raw * w + 0.5 * (1 - w);
}

/**
 * Rank candidate items by their domain's historical capture success.
 *
 * @param items   — any list with a `url` field
 * @param getDomain — optional custom domain extractor (defaults to URL host)
 * @returns the SAME items, best-to-try first (stable for equal scores)
 */
export async function rankByDomainScore<T>(
  items: T[],
  getDomain: (item: T) => string | null
): Promise<T[]> {
  if (items.length === 0) return items;

  const domains = Array.from(
    new Set(
      items
        .map(getDomain)
        .filter((d): d is string => !!d)
        .map((d) => d.replace(/^www\./i, "").toLowerCase())
    )
  ).slice(0, 100); // sanity cap

  let stats: { domain: string; attempts: number; successes: number }[] = [];
  try {
    stats = await db.domainStat.findMany({
      where: { domain: { in: domains } },
      select: { domain: true, attempts: true, successes: true },
    });
  } catch (err) {
    console.warn(
      "[domains] failed to load stats — returning unranked:",
      err instanceof Error ? err.message : String(err)
    );
    return items;
  }

  const scoreByDomain = new Map<string, number>();
  for (const s of stats) scoreByDomain.set(s.domain, domainScore(s));

  // Decorate-sort-undecorate with the original index as a stable tiebreaker.
  const decorated = items.map((item, index) => {
    const d = getDomain(item);
    const clean = d ? d.replace(/^www\./i, "").toLowerCase() : null;
    const score = clean ? (scoreByDomain.get(clean) ?? 0.5) : 0.5;
    return { item, index, score };
  });

  decorated.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  return decorated.map((d) => d.item);
}
