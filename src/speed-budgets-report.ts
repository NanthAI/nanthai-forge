// SPDX-License-Identifier: Apache-2.0
import type { MetricPeriod, MetricRecords } from './self-metrics-types.js';
import { during } from './self-metrics-joins.js';
import {
  landingBudgets,
  ratchetStatus,
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
  stat: 'p50' | 'p90' | 'mean' | 'day' | null;
  unit: SpeedBudget['unit'];
  max: number | null;
  value: number | null;
  /** The automatic (ratcheted) line the live row judges, when it is under the file max. */
  line?: number;
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
          c?.runnerFull == null ? null : c.runnerFull * 60,
        ],
        row.saveMs ?? null,
        row.preflightMs ?? null,
        row.passToLandMinutes ?? null,
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
    // The automatic setting beside the file line (Issue a217b83e): live ratchet state, hosted only. A day
    // budget's state lives on the newest Stats day row, never on the landing row (review d2d1a7e8).
    const live = records.landingSpeed;
    if (b.stat === 'day')
      return {
        ...base,
        ...dayRow(landingSamples, period, b.max, records.dayBudgets, b.id, b.ratchet === false),
      };
    const auto =
      live && b.stat !== 'mean' ? ratchetStatus(live.ratchet?.[b.id], b.max, b.ratchet === false) : null;
    const ratchetNote = !auto
      ? ''
      : (auto.line < b.max
          ? `; automatic line ${auto.line} (ratcheted ${auto.since?.slice(0, 10) ?? ''})`
          : '') +
        (auto.pinned
          ? `; pinned to the file max${auto.automatic !== null ? `, automatic would pick ${auto.automatic}` : ''}`
          : auto.daysLeft
            ? `; next ratchet check in ${auto.daysLeft} held day${auto.daysLeft === 1 ? '' : 's'}`
            : '; next ratchet check at the next UTC day');
    const shortNote = live?.short?.[b.id]
      ? `; live row: too few stamped landings since ${live.short[b.id]!.slice(0, 10)}, no alert can fire`
      : '';
    const stamped =
      b.metric === 'runnerFull'
        ? 'full checks'
        : b.metric === 'check'
          ? 'passed check runs'
          : 'landings with this stamp';
    const value = windowValue(rows, b.metric as LandingMetric, b.stat!, budgets.window.landings);
    const unknown = rows
      .slice(-budgets.window.landings)
      .filter(row => windowValue([row], b.metric as LandingMetric, b.stat!, 1) === null).length;
    const coverage = unknown ? `; ${unknown} newest landings have unknown stamps (excluded, never zero)` : '';
    const have = rows.filter(
      row => windowValue([row], b.metric as LandingMetric, b.stat!, 1) !== null,
    ).length;
    const line = auto && auto.line < b.max ? { line: auto.line } : {};
    return value === null
      ? {
          ...base,
          ...line,
          value,
          status: 'unrun',
          note: `not enough data: ${have} ${stamped} in the period, the window needs ${budgets.window.landings}${coverage}${shortNote}${ratchetNote}`,
        }
      : {
          ...base,
          ...line,
          value,
          // Only the file max is a P0: a window over a ratcheted line undoes the ratchet instead.
          status: value > b.max ? 'fail' : 'pass',
          note: `last ${budgets.window.landings} ${stamped} in the period${coverage}${shortNote}${ratchetNote}${b.metric === 'runnerAudit' ? '; audit seconds attributed by run end (delayed reports can shift the live stamp)' : ''}`,
        };
  });
}

/** A day budget (the waste tripwire): the newest UTC day the period holds whole, as the Stats day close judges
 * it; the worst whole day beside it. A day missing more than half its stamps is not judged. The automatic line
 * and its days left come from the Stats day row's state. Status agrees with the close's P0: a day over a
 * tightened line but under the file max undoes the ratchet (a message), so only the file max fails. */
function dayRow(
  samples: LandingSpeedState['samples'],
  period: MetricPeriod,
  max: number,
  kept: MetricRecords['dayBudgets'],
  id: string,
  pinned: boolean,
): Pick<SpeedBudgetRow, 'value' | 'status' | 'note' | 'line'> {
  const entry = kept?.ratchet[id];
  const days = new Map<string, { seconds: number; unknown: number; landings: number }>();
  const end = Date.parse(period.to);
  for (const row of samples) {
    // Whole days only: a day the period cuts off, or today, is still open.
    if (row[0] >= end - (end % 86_400_000)) continue;
    const key = new Date(row[0]).toISOString().slice(0, 10);
    const d = days.get(key) ?? { seconds: 0, unknown: 0, landings: 0 };
    const seconds = row[7]?.[4];
    d.landings++;
    if (seconds == null) d.unknown++;
    else d.seconds += seconds;
    days.set(key, d);
  }
  const judged = [...days]
    .filter(([, d]) => d.unknown * 2 <= d.landings)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const auto = entry || pinned ? ratchetStatus(entry, max, pinned) : null;
  const line = auto && auto.line < max ? { line: auto.line } : {};
  const ratchet = !auto
    ? ''
    : (auto.line < max
        ? `; automatic line ${auto.line} (ratcheted ${auto.since?.slice(0, 10) ?? ''})`
        : auto.pinned
          ? '; pinned to the file max'
          : auto.daysLeft
            ? `; next ratchet check in ${auto.daysLeft} held day${auto.daysLeft === 1 ? '' : 's'}`
            : '') + (entry && kept ? `; kept by the Stats day close through ${kept.day}` : '');
  const newest = judged.at(-1);
  if (!newest)
    return {
      ...line,
      value: null,
      status: 'unrun',
      note: `not enough data: no whole UTC day in the period with at least half its landings stamped (${days.size} day${days.size === 1 ? '' : 's'} seen)${ratchet}`,
    };
  const minutes = (d: { seconds: number }) => Math.round(d.seconds / 6) / 10;
  const worst = judged.reduce((a, b) => (minutes(b[1]) > minutes(a[1]) ? b : a));
  const value = minutes(newest[1]);
  const over =
    auto && auto.line < max && value > auto.line && value <= max
      ? `; over the automatic line: the day close undoes the ratchet (a message, no P0 under the file max)`
      : '';
  return {
    ...line,
    value,
    status: value > max ? 'fail' : 'pass',
    note:
      `UTC day ${newest[0]}: ${newest[1].landings} landings${newest[1].unknown ? `, ${newest[1].unknown} unknown (excluded, never zero)` : ''}; ` +
      `worst whole day in the period ${worst[0]} ${minutes(worst[1])} min over ${judged.length} judged day${judged.length === 1 ? '' : 's'}${ratchet}${over}`,
  };
}

const cell = (row: SpeedBudgetRow) =>
  `${row.value ?? 'unrun'} / ${row.max ?? '-'} ${row.unit}${row.line === undefined ? '' : ` (automatic ${row.line})`}`;
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
