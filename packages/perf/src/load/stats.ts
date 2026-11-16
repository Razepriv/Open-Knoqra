// Latency statistics for the load runner.

export type Sample = { ms: number; ok: boolean };

export type Summary = {
  count: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  rps: number;
};

/** Nearest-rank percentile of an ascending list; 0 for an empty list. */
export function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const rank = Math.max(1, Math.ceil((p * sortedMs.length) / 100));
  return sortedMs[Math.min(rank, sortedMs.length) - 1] as number;
}

/** Summarizes samples; `rps` is count over `elapsedS` (0 when no duration is given). */
export function summarize(samples: readonly Sample[], elapsedS = 0): Summary {
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  return {
    count: samples.length,
    errors: samples.filter((s) => !s.ok).length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length === 0 ? 0 : (sorted[sorted.length - 1] as number),
    rps: elapsedS > 0 ? samples.length / elapsedS : 0,
  };
}
