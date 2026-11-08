// SPDX-License-Identifier: Apache-2.0
/** Per-reason fast-path fallback counts of one Forge cell (Issue 7c2e69e1), taken from the
 * `metrics` reply the cell already reads for forge-metrics.json: no extra read. */
export function cellFallbacks(reply) {
  const value = reply?.result?.totals?.fallbacks;
  if (!value || !Array.isArray(value.byReason))
    return { error: 'metrics reply has no totals.fallbacks (Forge CLI or projectSelfMetrics predates it)' };
  return {
    total: value.total,
    limitations: value.limitations,
    partial: value.partial,
    byReason: value.byReason.map(({ stage, reason, kind, count }) => ({ stage, reason, kind, count })),
  };
}
