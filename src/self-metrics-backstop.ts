// SPDX-License-Identifier: Apache-2.0
import type { MetricPeriod, MetricRecords } from './self-metrics-types.js';
const time = (at: string) => Date.parse(at);
/** Proved-reuse back-stop (Issue 71767c9b): every acceptance on a cross-head proof
 * and every later failed full main audit is counted, so a broken proof shows up.
 * Derived from receipts and audit events already stored: no writes. */
export function calculateBackstopMetrics(records: MetricRecords, period: MetricPeriod) {
  const from = time(period.from),
    to = Math.min(time(period.to), time(period.asOf ?? period.to));
  const during = (at: string) => time(at) >= from && time(at) < to;
  // Native owner history has no hosted reuse receipts or main-audit events.
  if (records.source?.kind === 'native')
    return {
      partial: false,
      gaps: [] as string[],
      reuseAcceptances: null,
      mainCheckFailures: null,
      failuresAfterReuse: null,
      flakeCleared: null,
      culprits: null,
      reuseCulprits: null,
    };
  const reused = [...new Map(records.moves.filter(m => m.reused).map(m => [m.id, m])).values()];
  const audits = records.mainAudits;
  const events = audits?.events ?? [];
  const of = (kind: string) => events.filter(e => e.kind === kind && during(e.at));
  const red = of('red'),
    culprits = of('culprit');
  const greens = events.filter(e => e.kind === 'green' || e.kind === 'flake');
  const revisions = reused.flatMap(m => (m.revision === undefined ? [] : [m.revision]));
  // A red episode audited every receipt after the last green/flake before it.
  let unbounded = false;
  const afterReuse = red.filter(e => {
    const green = greens.filter(g => g.sequence < e.sequence).map(g => g.sequence);
    if (!green.length && !audits?.complete) unbounded = true;
    const since = green.length ? Math.max(...green) : -1;
    return revisions.some(r => r > since && r <= e.sequence);
  });
  const reuseKnown = !records.reuseUnprojected && !!audits;
  const gaps = [
    ...(audits
      ? []
      : ['Hosted main-audit events need the deployed projectSelfMetrics acceptances projection.']),
    ...(records.reuseUnprojected
      ? ['Hosted acceptances pages lack the reuse projection: deploy projectSelfMetrics.']
      : []),
    ...(unbounded
      ? [
          'A failure older than the newest 100 main-audit events has no bounding green; reuse in its range may be missed.',
        ]
      : []),
    ...(reused.some(m => m.revision === undefined)
      ? ['Some reuse receipts lack a main revision; their audit range is unknown.']
      : []),
  ];
  return {
    partial: !reuseKnown || unbounded,
    gaps,
    reuseAcceptances: records.reuseUnprojected ? null : reused.filter(m => during(m.at)).length,
    mainCheckFailures: audits ? red.length : null,
    failuresAfterReuse: reuseKnown ? afterReuse.length : null,
    flakeCleared: audits ? of('flake').length : null,
    culprits: audits ? culprits.length : null,
    reuseCulprits: reuseKnown
      ? culprits.filter(e => e.culprit && reused.some(m => m.id === e.culprit)).length
      : null,
  };
}
