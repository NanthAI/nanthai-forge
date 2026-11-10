// SPDX-License-Identifier: Apache-2.0
import type { MetricPeriod, MetricRecords } from './self-metrics-types.js';
import { during } from './self-metrics-joins.js';
import {
  landingBudgets,
  windowValue,
  type LandingMetric,
  type LandingSpeedState,
  type SpeedBudget,
  type SpeedBudgets,
} from './landing-speed-alerts.js';

export type SpeedBudgetRow = {
  id: string;
  area: string;
  measuredBy: SpeedBudget['measuredBy'];
  stat: 'p50' | 'p90' | 'mean' | null;
  unit: SpeedBudget['unit'];
  max: number | null;
  value: number | null;
  status: 'pass' | 'fail' | 'unrun' | 'guarded';
  /** Why a row is unrun or guarded, or which landings the value covers. */
  note: string;
};

const WHERE: Record<Exclude<SpeedBudget['measuredBy'], 'landing-record'>, string> = {
  'perf-harness': 'measured by scripts/perf-harness.mjs, not by a landing',
  'build-guard': 'enforced by a check that fails the build',
  unrecorded: 'nothing records this value yet',
};

/** Values against budgets from rows the metrics read already holds: accepted landings (submit to
 * commit) and check runs. The same rule as the landing path: the statistic over the last
 * `window.landings` landings in the period, so one outlier cannot fail a row. */
export function speedBudgetRows(
  records: MetricRecords,
  period: MetricPeriod,
  budgets: SpeedBudgets,
): SpeedBudgetRow[] {
  const landings = (records.finishTimings ?? []).filter(row => during(row.at, period));
  const runs = (records.runs ?? []).filter(
    run => run.status === 'passed' && run.wallMinutes != null && during(run.at, period),
  );
  // Reconstruct audit attribution by run end from existing runs. The live stamp uses report arrival,
  // so a delayed report can move its share across a window boundary; state that basis in the report.
  const ordered = [...(records.finishTimings ?? [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const audits = new Map<string, number>();
  let latest = -1;
  const terminalAudits = (records.runs ?? [])
    .filter(
      run => run.auditRunnerSeconds != null && run.endedAt && Date.parse(run.endedAt) < Date.parse(period.to),
    )
    .sort((a, b) => Date.parse(a.endedAt!) - Date.parse(b.endedAt!));
  for (const run of terminalAudits) {
    while (latest + 1 < ordered.length && Date.parse(ordered[latest + 1]!.at) <= Date.parse(run.endedAt!))
      latest++;
    const landing = ordered[latest];
    if (landing) audits.set(landing.id, (audits.get(landing.id) ?? 0) + run.auditRunnerSeconds!);
  }
  const auditsProjected =
    (records.runs ?? []).every(run => run.auditRunnerSeconds !== undefined) &&
    !(records.surfaceGaps ?? []).some(gap => gap.includes('hosted runs page'));
  const landingSamples = landings
    .map((row): LandingSpeedState['samples'][number] => {
      const c = row.costs;
      return [
        Date.parse(row.at),
        row.minutes,
        null,
        row.id,
        row.settleSeconds ?? null,
        c?.attempts ?? null,
        c?.writes ?? null,
        [
          c?.r2ClassA ?? null,
          c?.r2ClassB ?? null,
          c?.r2BytesPut ?? null,
          c?.runnerAccepted == null ? null : c.runnerAccepted * 60,
          c?.runnerDiscarded == null ? null : c.runnerDiscarded * 60,
          c?.runnerAccepted == null || !auditsProjected ? null : (audits.get(row.id) ?? 0),
        ],
      ];
    })
    .sort((a, b) => a[0] - b[0]);
  const samples = (metric: LandingMetric): LandingSpeedState['samples'] =>
    metric === 'check'
      ? runs
          .map(
            run =>
              [Date.parse(run.at), null, run.wallMinutes ?? null, ''] as [
                number,
                null,
                number | null,
                string,
              ],
          )
          .sort((a, b) => a[0] - b[0])
      : landingSamples;
  const judged = new Set(landingBudgets(budgets).map(b => b.id));
  return budgets.budgets.map(b => {
    const base = {
      id: b.id,
      area: b.area,
      measuredBy: b.measuredBy,
      stat: b.stat ?? null,
      unit: b.unit,
      max: b.max,
    };
    if (!judged.has(b.id) || b.max === null)
      return {
        ...base,
        value: null,
        status: b.measuredBy === 'build-guard' ? 'guarded' : 'unrun',
        note: WHERE[b.measuredBy as keyof typeof WHERE],
      };
    const rows = samples(b.metric as LandingMetric);
    const value = windowValue(rows, b.metric as LandingMetric, b.stat!, budgets.window.landings);
    return value === null
      ? {
          ...base,
          value,
          status: 'unrun',
          note: `fewer than ${budgets.window.landings} ${b.metric === 'check' ? 'passed check runs' : 'landings with this stamp'} in the period`,
        }
      : {
          ...base,
          value,
          status: value > b.max ? 'fail' : 'pass',
          note: `last ${budgets.window.landings} ${b.metric === 'check' ? 'passed check runs' : 'landings with this stamp'} in the period${b.metric === 'runnerAudit' ? '; audit seconds attributed by run end (delayed reports can shift the live stamp)' : ''}`,
        };
  });
}

const cell = (row: SpeedBudgetRow) => `${row.value ?? 'unrun'} / ${row.max ?? '-'} ${row.unit}`;
/** Text lines for `metrics --text`. */
export function formatSpeedBudgets(rows: SpeedBudgetRow[]) {
  return [
    'Speed budgets (value / budget; docs/agents/speed-budgets.md):',
    ...rows.map(row => `  ${row.status.padEnd(7)} ${row.id}: ${cell(row)} · ${row.note}`),
  ];
}
/** Markdown table for `metrics --report`, which the phase close report includes. */
export function speedBudgetTable(rows: SpeedBudgetRow[]) {
  return [
    '| Speed budget | Area | Value / budget | Status | Basis |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.id} | ${row.area} | ${cell(row)} | ${row.status} | ${row.note} |`),
  ];
}
/** One status line naming each broken budget, or null. */
export function speedBudgetWarning(rows: SpeedBudgetRow[]) {
  const broken = rows.filter(row => row.status === 'fail');
  return broken.length
    ? `speed budget broken: ${broken.map(row => `${row.id} ${row.value}/${row.max} ${row.unit}`).join(', ')}`
    : null;
}
