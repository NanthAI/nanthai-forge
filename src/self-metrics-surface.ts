// SPDX-License-Identifier: Apache-2.0
import { calculateSelfMetrics } from './self-metrics.js';
import { observations, during, percentile } from './self-metrics-joins.js';
import { z } from 'zod';
import { invariant } from './errors.js';
import type { MetricPeriod, MetricRecords } from './self-metrics-types.js';
export const metricNames = {
  '5.1': 'Landings by path',
  '5.2': 'Lifecycle errors per 100 finishes',
  '5.3': 'Dropped landings',
  '5.4': 'Overlap delivery and acknowledgement',
  '5.5': 'Interventions per landing',
  '5.6': 'Check minutes per landing and reuse',
  '5.7': 'Authority lag and contradictions',
  '5.8': 'Dollars per landing',
  R: 'Red-main minutes',
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
    '5.1': wrap(
      {
        ...result.metric1,
        landings: result.landings,
        firstTryShare: result.landings
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
    '5.4': wrap(result.metric4, observed('save', 'overlap-delivery', 'overlap-answer')),
    '5.5': wrap(result.metric5, count(records.receipts.filter(row => row.kind === 'mutation'))),
    '5.6': wrap(result.metric6, count(records.runs) + count(records.checkRequests ?? [])),
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
    ...(records.source ? { source: records.source } : {}),
    totals: metricTotals(records, period),
    days,
  };
}
export type MetricsSurface = ReturnType<typeof metricsSurface>;
export type MetricTotals = ReturnType<typeof metricTotals>;
