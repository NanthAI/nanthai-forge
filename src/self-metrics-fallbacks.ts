// SPDX-License-Identifier: Apache-2.0
import { countFallbacks, type FallbackStage } from './fallback-reasons.js';
import { during } from './self-metrics-joins.js';
import type { MetricPeriod, MetricRecords } from './self-metrics-types.js';

/** Fallback reasons per stage in the window (Issue 7c2e69e1), from fields the metric pages
 * already return: receipts (`first-check`), attempts (`main-race`, `scoped-recheck`) and
 * check runs (`selection`, `contract-gate`). No extra read. */
export function fallbackMetric(records: MetricRecords, period: MetricPeriod) {
  const events: { stage: FallbackStage; reason: string }[] = [];
  for (const move of records.moves)
    if (move.firstCheckRecheck && during(move.at, period))
      events.push({ stage: 'first-check', reason: move.firstCheckRecheck });
  for (const row of records.submissions) {
    if (!during(row.at, period)) continue;
    // Only an attempt on a moved main is a race; a same-main copy never counts again.
    if (row.recheck === false) continue;
    if (row.recheckReason) events.push({ stage: 'main-race', reason: row.recheckReason });
    if (row.scopedFallback) events.push({ stage: 'scoped-recheck', reason: row.scopedFallback });
  }
  for (const run of records.runs) {
    if (!during(run.at, period)) continue;
    if (run.selectionFallback) events.push({ stage: 'selection', reason: run.selectionFallback });
    if (run.gateFallback) events.push({ stage: 'contract-gate', reason: run.gateFallback });
  }
  const counted = countFallbacks(events);
  const gaps = records.fallbacksUnprojected
    ? [
        'Some hosted metric pages predate the fallback-reason projection: deploy projectSelfMetrics; earlier fallbacks are uncounted.',
      ]
    : [];
  return { ...counted, total: events.length, partial: gaps.length > 0, gaps };
}
