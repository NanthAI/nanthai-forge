// SPDX-License-Identifier: Apache-2.0
import { speedBudgets } from './speed-budgets.js';
import { speedBudgetRows } from './speed-budgets-report.js';
import { calculateSelfMetrics } from './self-metrics.js';
import { calculateWaste } from './self-metrics-waste.js';
import { observations, during, percentile } from './self-metrics-joins.js';
import { flakeList } from './self-metrics-flakes.js';
import { fallbackMetric } from './self-metrics-fallbacks.js';
import { secondCheckMetric } from './self-metrics-second-checks.js';
import { z } from 'zod';
import { invariant } from './errors.js';
import type { MetricPeriod, MetricRecords } from './self-metrics-types.js';
export const metricNames = {
  '5.1': 'Landings by path',
  '5.2': 'Lifecycle errors per 100 finishes',
  '5.3': 'Dropped landings',
  '5.5': 'Interventions per landing',
  '5.6': 'Check minutes per landing and reuse',
  '5.7': 'Authority lag and contradictions',
  '5.8': 'Dollars per landing',
  R: 'Red-main minutes',
  B: 'Proved-reuse back-stop',
};
export function metricPeriod(from?: string, to?: string, now = new Date().toISOString()): MetricPeriod {
  const parse = (value: string) => {
    invariant(
      (/^\d{4}-\d{2}-\d{2}$/.test(value) || z.iso.datetime({ offset: true }).safeParse(value).success) &&
        Number.isFinite(Date.parse(value)),
      'BAD_ARGUMENT',
      'Metric dates must be ISO dates or timestamps.',
    );
    const result = new Date(value).toISOString();
    invariant(
      value.slice(0, 10) === new Date(value.slice(0, 10)).toISOString().slice(0, 10),
      'BAD_ARGUMENT',
      'Invalid metric calendar date.',
    );
    return result;
  };
  const end = parse(to ?? now),
    start = parse(from ?? new Date(Date.parse(end) - 7 * 86400000).toISOString());
  invariant(start < end, 'BAD_ARGUMENT', 'Metrics require from before to; the UTC window is [from,to).');
  return { from: start, to: end, asOf: end };
}
export function metricTotals(
  records: MetricRecords,
  period: MetricPeriod,
  options: { headline?: boolean } = {},
) {
  const result = calculateSelfMetrics(records, period, options),
    events = observations(records);
  const count = <T extends { at: string }>(rows: T[]) => rows.filter(row => during(row.at, period)).length;
  const observed = (...types: string[]) => count(events.filter(row => types.includes(row.type)));
  const globalGaps = records.surfaceGaps ?? [];
  const wrap = <T extends { partial: boolean; gaps: string[] }>(value: T, sourceRecords: number) => ({
    ...value,
    sourceRecords,
    partial: value.partial || !!globalGaps.length,
    gaps: [...value.gaps, ...globalGaps],
  });
  return {
    waste: wrap(calculateWaste(records, period), count(records.submissions)),
    speedBudgets: {
      rows: speedBudgetRows(records, period, speedBudgets),
      sourceRecords: (records.finishTimings ?? []).length,
      partial: false,
      gaps: [] as string[],
    },
    finishToMain: (() => {
      const rows = (records.finishTimings ?? []).filter(row => row.trusted && during(row.at, period));
      const minutes = rows.flatMap(row => (row.minutes === null ? [] : [row.minutes]));
      const admitted = rows.filter(row => row.onAdmissionRun != null);
      return {
        p50Minutes: percentile(minutes, 0.5),
        // The p50 flips on a two-humped distribution (main did not move vs moved): read these with it.
        p90Minutes: percentile(minutes, 0.9),
        meanMinutes: minutes.length ? minutes.reduce((n, m) => n + m, 0) / minutes.length : null,
        /** Share of pre-queue admitted landings that landed on their admission check (no recheck). */
        admissionRunShare: admitted.length
          ? admitted.filter(row => row.onAdmissionRun).length / admitted.length
          : null,
        sourceRecords: rows.length,
        partial: true,
        gaps: [
          ...globalGaps,
          'Finish-to-main uses retained hosted submission and acceptance timestamps under the attempt auto-on-pass policy; native trust/timing and missing submissions remain unknown.',
        ],
      };
    })(),
    '5.1': wrap(
      {
        ...result.metric1,
        landings: records.error ? null : result.landings,
        // Lanes whose first-ever land entry in the window was accepted (src/first-attempt-land-rate.ts).
        firstAttemptLandRate: result.firstAttemptLandRate,
        firstTryShare:
          result.landings &&
          !result.metric1.rows.some(row => row.path === 'unknown' || row.path === 'unresolved')
            ? result.metric1.rows.filter(row => row.path === 'first-try').length / result.landings
            : null,
      },
      count(records.moves),
    ),
    '5.2': wrap(
      {
        ...result.metric2,
        errorsPer100Finishes:
          result.metric2.errors !== null && result.metric2.finishes
            ? (result.metric2.errors * 100) / result.metric2.finishes
            : null,
      },
      count(records.receipts.filter(row => row.kind === 'lifecycle')),
    ),
    '5.3': wrap(result.metric3, count(records.submissions)),
    '5.5': wrap(result.metric5, count(records.receipts.filter(row => row.kind === 'mutation'))),
    '5.6': wrap(
      records.error
        ? {
            ...result.metric6,
            runnerMinutes: null,
            wallMinutes: null,
            checkMinutes: null,
            runnerMinutesPerLanding: null,
            wallMinutesPerLanding: null,
            checkMinutesPerLanding: null,
          }
        : result.metric6,
      count(records.runs) + count(records.checkRequests ?? []),
    ),
    '5.7': wrap(
      {
        ...result.metric7,
        totals: result.metric7.modes.map(mode => ({
          mode: mode.mode,
          revisions: mode.rows.length,
          pending: mode.rows.filter(row => row.seconds === null).length,
          revisionLagP50: percentile(
            mode.rows.flatMap(r => (r.revisionLag === null ? [] : [r.revisionLag])),
            0.5,
          ),
          revisionLagP95: percentile(
            mode.rows.flatMap(r => (r.revisionLag === null ? [] : [r.revisionLag])),
            0.95,
          ),
          secondsP50: percentile(
            mode.rows.flatMap(r => (r.seconds === null ? [] : [r.seconds])),
            0.5,
          ),
          secondsP95: percentile(
            mode.rows.flatMap(r => (r.seconds === null ? [] : [r.seconds])),
            0.95,
          ),
        })),
      },
      observed('revision', 'surface'),
    ),
    '5.8': wrap(
      result.metric8,
      result.metric8.months.reduce((n, month) => n + month.bills.length, 0),
    ),
    R: wrap(
      result.redMain,
      records.moves.filter(r => Date.parse(r.at) <= Date.parse(period.to)).length +
        records.runs.filter(r => r.fullSuite && r.endedAt && Date.parse(r.endedAt) <= Date.parse(period.to))
          .length +
        events.filter(
          e =>
            (e.type === 'full-result' || e.type === 'culprit') && Date.parse(e.at) <= Date.parse(period.to),
        ).length,
    ),
    B: wrap(
      result.backstop,
      records.moves.filter(m => m.reused && during(m.at, period)).length +
        (records.mainAudits?.events.filter(e => during(e.at, period)).length ?? 0),
    ),
    // G4: files that recovered on retry. Counted in the same run rows as 5.6; never a clean pass.
    flakes: wrap(
      {
        ...flakeList(records.runs, period),
        partial: !!records.flakesUnprojected,
        gaps: records.flakesUnprojected
          ? [
              'Hosted runs pages lack the flaky projection: deploy projectSelfMetrics; the flaky list may be incomplete.',
            ]
          : [],
      },
      records.runs.filter(run => run.flaky && during(run.endedAt ?? run.at, period)).length,
    ),
    // Fast-path fallbacks by stage and reason; limitations are flagged (7c2e69e1).
    fallbacks: (() => {
      const value = fallbackMetric(records, period);
      return wrap(value, value.total);
    })(),
    // Second checks by reason class and what became of each; shared-batch failures; agent clients (81d12a32).
    secondChecks: (() => {
      const value = secondCheckMetric(records, period);
      return wrap(value, value.total);
    })(),
    placement: wrap(result.placement, records.placement ? 1 : 0),
    disk: wrap(
      result.disk,
      (records.diskSamples ?? records.receipts.flatMap(r => (r.disk ? [r.disk] : []))).filter(
        s => Date.parse(s.at) <= Date.parse(period.to),
      ).length + observed('storage'),
    ),
  };
}
export function metricsSurface(records: MetricRecords, period: MetricPeriod) {
  const days = [];
  for (let at = Date.parse(period.from); at < Date.parse(period.to);) {
    const day = new Date(at).toISOString().slice(0, 10),
      end = Math.min(Date.parse(`${day}T00:00:00Z`) + 86400000, Date.parse(period.to));
    days.push({
      day,
      metrics: metricTotals(records, {
        from: new Date(at).toISOString(),
        to: new Date(end).toISOString(),
        asOf: new Date(Math.min(end, Date.parse(period.asOf ?? period.to))).toISOString(),
      }),
    });
    at = end;
  }
  return {
    schema: 1,
    period,
    ...(records.error ? { error: records.error } : {}),
    ...(records.source ? { source: records.source } : {}),
    totals: metricTotals(records, period),
    days,
  };
}
export type MetricsSurface = ReturnType<typeof metricsSurface>;
export type MetricTotals = ReturnType<typeof metricTotals>;
