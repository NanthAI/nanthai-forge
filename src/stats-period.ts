// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import {
  STATS_COMPARE_MIN_LANDINGS,
  addTotals,
  dayTotals,
  distOf,
  noTotals,
  statsFigures,
  statsWindow,
  type StatsDay,
  type StatsTotals,
} from './stats-estimate.js';

/** Stats for one chosen period (Item a61d3c91): the screen asks for a range of closed UTC days and the read
 * (convex/projectStats.ts) re-aggregates every figure from those day rows only. A range holds at most
 * STATS_RANGE_MAX_DAYS days, so a read is at most that many rows; the figures' methods stay statsWindow's. All time
 * reads one stored rollup per closed month (statsMonth) and the day rows of the months not rolled up yet. */
export const STATS_RANGE_MAX_DAYS = 92;
/** Today so far (Item 580b1a1a): a Stats open refreshes the open UTC day's row at most once in this long. */
export const STATS_TODAY_REFRESH_MS = 60 * 60_000;
export type StatsRange = { from: string; to: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const at = (day: string) => Date.parse(`${day}T00:00:00Z`);
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const real = (day: string) => DAY.test(day) && new Date(at(day)).toISOString().slice(0, 10) === day;
/** Days in a range, both ends included; 0 for a range that is not a real, ordered pair of days. */
export function rangeDays({ from, to }: StatsRange) {
  if (!real(from) || !real(to) || to < from) return 0;
  return Math.round((at(to) - at(from)) / 86_400_000) + 1;
}
export const validRange = (range: StatsRange) => {
  const n = rangeDays(range);
  return n > 0 && n <= STATS_RANGE_MAX_DAYS;
};
/** The self-trend's baseline (owner 2026-11-19): the same number of days just before the range. */
export function previousRange(range: StatsRange): StatsRange {
  const n = rangeDays(range);
  return { from: utc(at(range.from) - n * 86_400_000), to: utc(at(range.from) - 86_400_000) };
}

/** First-try buckets for "By agent": a fixed four, so the list never grows with the number of agents. */
export const FIRST_TRY_BUCKETS = [
  { label: '100%', min: 1 },
  { label: '75–99%', min: 0.75 },
  { label: '50–74%', min: 0.5 },
  { label: 'Under 50%', min: 0 },
] as const;
type Who = ReturnType<typeof statsWindow>['who'];
export function firstTryBuckets(who: Who) {
  const buckets = FIRST_TRY_BUCKETS.map(b => ({ label: b.label, agents: 0, landings: 0 }));
  const notCounted = { agents: 0, landings: 0 };
  for (const row of who) {
    const rate = row.firstTryRate;
    const into = rate === null ? notCounted : buckets[FIRST_TRY_BUCKETS.findIndex(b => rate >= b.min)]!;
    into.agents++;
    into.landings += row.landings;
  }
  return { buckets, notCounted };
}

/** What one read returns: `head` (opened with the page: the headline figures and landings per day) or one fold,
 * fetched only once that fold is opened. Every part reads the same day rows; each returns only its own figures.
 * `trend` (a range only) also reads the range just before it. */
export const STATS_PARTS = ['head', 'waited', 'agents', 'months', 'trend'] as const;
export type StatsPart = (typeof STATS_PARTS)[number];

/** A day whose close did not finish: in no figure, and not a closed day (src/stats-estimate.ts#statsFailedDay). */
export const notMeasured = (d: StatsDay) => d.schema === 2 && d.failed !== undefined;
/** Until when a day row counts so far (src/stats-estimate.ts `provisional`, Item 580b1a1a), or null for a closed day. */
export const provisionalAt = (d: StatsDay | undefined) => (d?.schema === 2 ? (d.provisional ?? null) : null);
/** The closed days a read covers: the first and newest measured day, how many were measured and how many were not.
 * A day not measured is never a closed day here. */
export type StatsCover = { first: string | null; last: string | null; closed: number; notMeasured: number };
export function coverOf(rows: readonly StatsDay[]): StatsCover {
  const measured = rows.filter(d => !notMeasured(d));
  return {
    first: measured[0]?.day ?? null,
    last: measured.at(-1)?.day ?? null,
    closed: measured.length,
    notMeasured: rows.length - measured.length,
  };
}
const joinCover = (a: StatsCover, b: StatsCover): StatsCover => ({
  first: a.first ?? b.first,
  last: b.last ?? a.last,
  closed: a.closed + b.closed,
  notMeasured: a.notMeasured + b.notMeasured,
});

/** People and agents a month rollup lists by name; the rest add up under `others`. */
export const STATS_MONTH_MAX_WHO = 200;
const int = z.number().int().nonnegative();
const ints = z.array(int);
const dists = z.array(z.object({ n: int, v: ints }).strict()).max(1);
const tally = z.object({ runs: int, seconds: z.number().nonnegative(), unknown: int }).strict();
const causes = z.object({ mainMoved: tally, failed: tally, cancelled: tally, superseded: tally }).strict();
const totalsSchema = z
  .object({
    days: int,
    landings: int,
    partialLandings: z.boolean(),
    partialRuns: z.boolean(),
    counted: int,
    first: int,
    priced: int,
    acceptedSeconds: z.number().nonnegative(),
    discardedSeconds: z.number().nonnegative(),
    who: z.array(z.tuple([z.string(), int, int, int])).max(STATS_MONTH_MAX_WHO),
    others: int,
    tokens: z.object({ reported: int, total: int }).strict().optional(),
    toMain: dists,
    stops: z.object({ queue: dists, check: dists, land: dists }).strict(),
    ci: z.object({ days: int, landings: int, all: tally, unlinked: tally, discarded: causes }).strict(),
    cmp: z
      .object({
        days: int,
        landings: int,
        forgeSeconds: z.number().nonnegative(),
        unknownRuns: int,
        toMain: dists,
        failed: tally,
        failedInQueue: tally,
        notLanded: z.object({ runs: int, seconds: z.number().nonnegative() }).strict(),
        unlinked: tally,
        soloRunner: dists,
        soloWall: dists,
        soloRuns: int,
        asked: z.number().nonnegative(),
        oneRuns: z.number().nonnegative(),
        queueRuns: z.number().nonnegative(),
        one: dists,
        queue: dists,
        fast: dists,
        slow: dists,
      })
      .strict(),
  })
  .strict();
/** One closed month of a project (convex/projectStats.ts#rollMonth): the totals of its measured days, each sorted
 * distribution kept as at most STATS_DIST_SAMPLES quantiles, and which days it covers. Written once the month has
 * closed (at the first close of a later month), so All time reads about 12 rows a year. */
export const statsMonthSchema = z
  .object({
    schema: z.literal(1),
    month: z.string().regex(/^\d{4}-\d{2}$/),
    cover: z
      .object({
        first: z.string().regex(DAY).nullable(),
        last: z.string().regex(DAY).nullable(),
        closed: int,
        notMeasured: int,
      })
      .strict(),
    totals: totalsSchema,
  })
  .strict();
export type StatsMonth = z.infer<typeof statsMonthSchema>;

const one = (list: StatsTotals['toMain']) => (list.length ? [distOf(list)] : []);
/** A month's rollup from its day rows (oldest first). */
export function statsMonth(month: string, rows: readonly StatsDay[]): StatsMonth {
  const days = rows.filter(d => d.day.startsWith(month));
  const t = days.filter(d => !notMeasured(d)).reduce((s, d) => addTotals(s, dayTotals(d)), noTotals());
  const ranked = [...t.who].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const { cmp, tokens, ...rest } = t;
  return statsMonthSchema.parse({
    schema: 1,
    month,
    cover: coverOf(days),
    totals: {
      ...rest,
      // A month without reports stores nothing more, as a day does (review 23927f12 finding 2).
      ...(tokens?.reported ? { tokens } : {}),
      who: ranked.slice(0, STATS_MONTH_MAX_WHO),
      others: t.others + ranked.slice(STATS_MONTH_MAX_WHO).reduce((s, [, n]) => s + n, 0),
      toMain: one(t.toMain),
      stops: { queue: one(t.stops.queue), check: one(t.stops.check), land: one(t.stops.land) },
      cmp: {
        ...cmp,
        toMain: one(cmp.toMain),
        soloRunner: one(cmp.soloRunner),
        soloWall: one(cmp.soloWall),
        one: one(cmp.one),
        queue: one(cmp.queue),
        fast: one(cmp.fast),
        slow: one(cmp.slow),
      },
    },
  });
}

/** One month's line of the By month fold. */
function monthLine(month: string, m: ReturnType<typeof statsFigures>, missing: number) {
  return {
    month,
    landings: m.landings,
    toMainSeconds: m.measured.toMainSeconds,
    ciMinutes: m.measured.ciMinutes,
    savedVsQueue: m.comparison?.mergeQueue.savedMinutes ?? null,
    compare: m.compare,
    daysWithoutRuns: m.daysWithoutRuns,
    /** A day of this month was read only in part (src/stats-estimate.ts#statsWindow), and which reads. */
    partial: m.partial,
    partialLandings: m.partialLandings,
    partialRuns: m.partialRuns,
    /** Days of this month whose close did not finish: left out of its figures. */
    notMeasured: missing,
  };
}

/** The figures the self-trend sets side by side: rates and medians, and landings per closed day, so ranges of one
 * length compare fairly however many of their days have closed. */
function trendLine(rows: readonly StatsDay[], range: StatsRange) {
  const cover = coverOf(rows);
  const w = statsWindow(rows.filter(d => !notMeasured(d)));
  return {
    ...range,
    cover,
    landings: w.landings,
    landingsPerDay: cover.closed ? w.landings / cover.closed : null,
    firstTryRate: w.measured.firstTryRate,
    toMainSeconds: w.measured.toMainSeconds,
    ciMinutesPerLanding: w.measured.ciMinutesPerLanding,
  };
}

/** A reply's parts from a window's figures. */
function reply(
  base: {
    kind: 'range' | 'all';
    from: string;
    to: string;
    through: string | null;
    cover: StatsCover;
    /** The newest row is today so far, up to this time (epoch ms); null when every row is a closed day. */
    todayUpTo: number | null;
  },
  part: StatsPart,
  figures: ReturnType<typeof statsFigures>,
  bars: { perDay: Array<[string, number | null]>; perMonth: Array<[string, number]> | null },
  months: () => ReturnType<typeof monthLine>[],
) {
  const { who, measured, ...window } = figures;
  const { stops, ...headline } = measured;
  const head = { schema: 2 as const, part, ...base, landings: window.landings };
  if (part === 'waited') return { ...head, stops };
  if (part === 'agents')
    return { ...head, agents: who.length, others: window.others, ...firstTryBuckets(who) };
  if (part === 'months') return { ...head, months: months() };
  return {
    ...head,
    compareFrom: STATS_COMPARE_MIN_LANDINGS,
    /** Landings per closed day; null for a day whose close did not finish (not measured, never zero). All time draws
     * months instead (`perMonth`). */
    ...bars,
    window: { ...window, measured: headline },
  };
}

/** The read's reply for one range of closed days (oldest first) and one part. `previous`: the day rows of the range
 * just before it, read only for `trend`. */
export function statsRangeReply(
  rows: readonly StatsDay[],
  range: StatsRange,
  part: StatsPart = 'head',
  previous: readonly StatsDay[] = [],
) {
  // A day whose close did not finish is in no figure: the per-day chart and By month show it as not measured.
  const days = rows.filter(d => !notMeasured(d));
  const base = {
    kind: 'range' as const,
    from: range.from,
    to: range.to,
    /** The newest closed day in the range, or null when none has closed. */
    through: rows.at(-1)?.day ?? null,
    cover: coverOf(rows),
    todayUpTo: provisionalAt(rows.at(-1)),
  };
  if (part === 'trend')
    return {
      schema: 2 as const,
      part,
      ...base,
      landings: days.reduce((s, d) => s + d.landings, 0),
      current: trendLine(rows, range),
      previous: trendLine(previous, previousRange(range)),
    };
  return reply(
    base,
    part,
    statsWindow(days),
    { perDay: rows.map(d => [d.day, notMeasured(d) ? null : d.landings]), perMonth: null },
    () =>
      [...new Set(rows.map(d => d.day.slice(0, 7)))].map(month =>
        monthLine(
          month,
          statsWindow(days.filter(d => d.day.startsWith(month))),
          rows.filter(d => d.day.startsWith(month) && notMeasured(d)).length,
        ),
      ),
  );
}

/** All time: every closed month's rollup (oldest first) and the day rows after the newest one. */
export function statsAllReply(
  months: readonly StatsMonth[],
  tail: readonly StatsDay[],
  part: StatsPart = 'head',
) {
  const tailMonths = [...new Set(tail.map(d => d.day.slice(0, 7)))]
    .filter(month => !months.some(m => m.month === month))
    .map(month => statsMonth(month, tail));
  const all = [...months, ...tailMonths];
  const cover = all.reduce((c, m) => joinCover(c, m.cover), coverOf([]));
  const totals = all.reduce((t, m) => addTotals(t, m.totals), noTotals());
  const base = {
    kind: 'all' as const,
    from: cover.first ?? '',
    to: cover.last ?? '',
    through: cover.last,
    cover,
    todayUpTo: provisionalAt(tail.at(-1)),
  };
  // All time has no previous period to set beside it: a trend read gets the head.
  const p = part === 'trend' ? 'head' : part;
  return reply(
    base,
    p,
    statsFigures(totals),
    { perDay: [], perMonth: all.map(m => [m.month, m.totals.landings]) },
    () => all.map(m => monthLine(m.month, statsFigures(m.totals), m.cover.notMeasured)),
  );
}
export type StatsHead = Extract<ReturnType<typeof statsRangeReply>, { perDay: unknown }>;
export type StatsWaited = Extract<ReturnType<typeof statsRangeReply>, { stops: unknown }>;
export type StatsAgents = Extract<ReturnType<typeof statsRangeReply>, { buckets: unknown }>;
export type StatsMonths = Extract<ReturnType<typeof statsRangeReply>, { months: unknown }>;
export type StatsTrend = Extract<ReturnType<typeof statsRangeReply>, { current: unknown }>;
