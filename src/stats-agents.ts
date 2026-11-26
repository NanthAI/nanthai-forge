// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import { distMedian, distOf, STATS_DIST_SAMPLES, type StatsDist } from './stats-distribution.js';
import type { StatsDay, StatsLanding, StatsTotals } from './stats-estimate.js';
import { readAuthorship } from './work-actor-types.js';

/** Existing summary limits, applied after grouping by setup or person. */
const DAY_GROUPS = 40;
const MONTH_GROUPS = 200;
const MIN_LANDINGS = 5;
const UNKNOWN = 'unattributed';
const LEGACY = 'legacy';
const OVERFLOW = 'overflow';

const count = z.number().int().nonnegative();
/** Key, landings, first tries, known attempts, priced landings, runner seconds, and time to main. */
const groupSchema = z.tuple([
  z.string(),
  count,
  count,
  count,
  count,
  z.number().nonnegative(),
  z.object({ n: count, v: z.array(count) }).strict(),
]);
export const byAgentSchema = z.array(groupSchema);
type Group = z.infer<typeof groupSchema>;
type Aggregate = [...OmitTime<Group>, StatsDist[]];
type OmitTime<T extends unknown[]> = T extends [...infer Values, unknown] ? Values : never;

/** A run name identifies a session, so only the receipt's declared app and model identify its setup. */
export function statsAttribution(receipt: Parameters<typeof readAuthorship>[0]) {
  const { kind, app, model, actor } = readAuthorship(receipt);
  if (kind === 'agent') {
    const recorded = model && model !== 'unknown' && model !== 'not-declared' ? model : '';
    return `agent:${app ?? ''}:${recorded}`;
  }
  return kind === 'person' && actor && !/[\s:/@]/.test(actor) ? `person:${actor}` : UNKNOWN;
}

const empty = (key: string): Aggregate => [key, 0, 0, 0, 0, 0, []];
function add(into: Aggregate, row: Aggregate) {
  into[1] += row[1];
  into[2] += row[2];
  into[3] += row[3];
  into[4] += row[4];
  into[5] += row[5];
  // Some windows summarize many months, so append distributions without a variadic call.
  for (const dist of row[6]) into[6].push(dist);
}
const ranked = (a: Aggregate, b: Aggregate) => b[1] - a[1] || a[0].localeCompare(b[0]);
const named = (key: string) => key.startsWith('agent:') || key.startsWith('person:');
const separateTime = ([key, n, first, counted, priced, seconds, time]: Group): Aggregate => [
  key,
  n,
  first,
  counted,
  priced,
  seconds,
  time.n ? [time] : [],
];

function merge(rows: Iterable<Group>) {
  const groups = new Map<string, Aggregate>();
  for (const row of rows) {
    const group = groups.get(row[0]) ?? empty(row[0]);
    add(group, separateTime(row));
    groups.set(row[0], group);
  }
  return [...groups.values()];
}

function bounded(groups: Aggregate[], limit: number, compress: boolean): Group[] {
  const distinct = groups.filter(([key]) => named(key)).sort(ranked);
  const kept = distinct.slice(0, limit);
  const overflow = empty(OVERFLOW);
  for (const row of distinct.slice(limit)) add(overflow, row);
  for (const row of groups.filter(([key]) => !named(key))) {
    if (row[0] === OVERFLOW) add(overflow, row);
    else kept.push(row);
  }
  if (overflow[1]) kept.push(overflow);
  const total = kept.reduce((sum, row) => sum + row[1], 0);
  return kept.map(([key, n, first, counted, priced, seconds, time]) => {
    const size = compress ? Math.max(1, Math.floor((STATS_DIST_SAMPLES * n) / total)) : n;
    return [key, n, first, counted, priced, seconds, time.length ? distOf(time, size) : { n: 0, v: [] }];
  });
}

/** The contribution shares the landed-path criteria used by the Stats head and late CI accounting. */
export function statsPricedSeconds(landing: StatsLanding) {
  const { runnerSeconds, discardedRunnerSeconds } = landing;
  return runnerSeconds !== null &&
    discardedRunnerSeconds !== null &&
    Number.isFinite(runnerSeconds) &&
    Number.isFinite(discardedRunnerSeconds) &&
    runnerSeconds >= 0 &&
    discardedRunnerSeconds >= 0
    ? runnerSeconds + discardedRunnerSeconds
    : null;
}

export function statsDayAgents(landings: readonly StatsLanding[]) {
  const groups = new Map<string, Aggregate>();
  for (const landing of landings) {
    const key = landing.attribution ?? UNKNOWN;
    const row = groups.get(key) ?? empty(key);
    row[1]++;
    row[2] += Number(landing.attempts === 1);
    row[3] += Number(landing.attempts !== null);
    const seconds = statsPricedSeconds(landing);
    row[4] += Number(seconds !== null);
    row[5] += seconds ?? 0;
    const time = Math.round((landing.landedAt - landing.submittedAt) / 1000);
    if (landing.landedAt >= landing.submittedAt && landing.submittedAt >= 0 && Number.isFinite(time))
      row[6].push({ n: 1, v: [time] });
    groups.set(key, row);
  }
  return bounded([...groups.values()], DAY_GROUPS, false);
}

export function statsDayAgentRows(day: StatsDay): Group[] {
  const { landings, firstTry, runner, toMain } = day;
  return (
    day.byAgent ??
    (landings
      ? [
          [
            LEGACY,
            landings,
            firstTry.first,
            firstTry.counted,
            runner.priced,
            runner.acceptedSeconds + runner.discardedSeconds,
            { n: toMain.length, v: toMain },
          ],
        ]
      : [])
  );
}

export function statsMonthAgents(days: readonly StatsDay[]) {
  return bounded(merge(days.flatMap(statsDayAgentRows)), MONTH_GROUPS, true);
}

export function statsMonthAgentRows(
  totals: Omit<StatsTotals, 'tokens'> & { byAgent?: Group[] | undefined },
): Group[] {
  const { landings, first, counted, priced, acceptedSeconds, discardedSeconds, toMain } = totals;
  return (
    totals.byAgent ??
    (landings
      ? [
          [
            LEGACY,
            landings,
            first,
            counted,
            priced,
            acceptedSeconds + discardedSeconds,
            toMain[0] ?? { n: 0, v: [] },
          ],
        ]
      : [])
  );
}

/** Keep the row's own CI and first-try counts in step with a late provider report. */
export function adjustAgentStats(rows: Group[], before: StatsLanding, after: StatsLanding): Group[] {
  const key = after.attribution ?? UNKNOWN;
  const stored = rows.some(([name]) => name === key) ? key : OVERFLOW;
  const previous = statsPricedSeconds(before);
  const current = statsPricedSeconds(after);
  return rows.map(row => {
    if (row[0] !== stored) return row;
    const [name, n, first, counted, priced, seconds, time] = row;
    return [
      name,
      n,
      first + Number(after.attempts === 1) - Number(before.attempts === 1),
      counted + Number(after.attempts !== null) - Number(before.attempts !== null),
      priced + Number(current !== null) - Number(previous !== null),
      Math.max(0, seconds + (current ?? 0) - (previous ?? 0)),
      time,
    ];
  });
}

export function statsAgentFigures(rows: Iterable<Group>, projectRate: number | null) {
  const other = empty('other');
  const reasons = { small: 0, legacy: 0, overflow: 0, unattributed: 0 };
  const visible: Aggregate[] = [];
  for (const row of merge(rows)) {
    const [key, n] = row;
    if (named(key) && n >= MIN_LANDINGS) {
      visible.push(row);
    } else {
      reasons[key === LEGACY || key === OVERFLOW || key === UNKNOWN ? key : 'small'] += n;
      add(other, row);
    }
  }
  if (other[1]) visible.push(other);
  return {
    minimum: MIN_LANDINGS,
    agentRows: visible.sort(ranked).map(([key, landings, first, counted, priced, seconds, time]) => {
      const person = key.startsWith('person:');
      const [, app, model] = key.split(':');
      const firstTryRate = counted ? first / counted : null;
      return {
        identity:
          key === 'other'
            ? { kind: 'other' as const, reasons }
            : person
              ? { kind: 'person' as const, person: key.slice('person:'.length) }
              : { kind: 'agent' as const, app: app || null, model: model || null },
        landings,
        firstTryRate,
        counted,
        priced,
        toMainSeconds: distMedian(time),
        timed: time.reduce((sum, dist) => sum + dist.n, 0),
        approximate: time.some(dist => dist.n > dist.v.length),
        ciMinutesPerLanding: priced ? seconds / priced / 60 : null,
        firstTryGap:
          key !== 'other' &&
          counted >= MIN_LANDINGS &&
          projectRate !== null &&
          firstTryRate !== null &&
          projectRate - firstTryRate >= 0.2
            ? Math.round((projectRate - firstTryRate) * 100)
            : null,
      };
    }),
  };
}
