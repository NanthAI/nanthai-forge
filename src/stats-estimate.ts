// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import {
  DISCARD_CAUSES,
  classifyRuns,
  mergeQueueReplay,
  type DiscardCause,
  type QueueEntry,
} from './stats-runs.js';

/** Stats estimates contract (Issue a61d3c91; docs/run-evidence.md#stats). Owners compare what Forge measured in
 * their project with the same project's own history replayed through two GitHub setups: one change at a time on
 * an up-to-date branch, and a merge queue building 5 at once. Never a benchmark ratio, and never a per-project token
 * saving. Pure: no clock, no I/O, display-only. */

/** One accepted landing, from fields its receipt and landing row already hold. Times are epoch ms. */
export type StatsLanding = {
  id: string;
  /** Public agent handle or person handle that sent it to land; null when unknown. */
  who: string | null;
  submittedAt: number;
  landedAt: number;
  /** Queue -> check -> landing stops, when the row recorded them. */
  checkStartedAt: number | null;
  checkEndedAt: number | null;
  /** Shard execution seconds of the accepted check (a batch member's share) and of the checks its
   * earlier attempts discarded. null is unknown: such a landing leaves the CI figures and is counted. */
  runnerSeconds: number | null;
  discardedRunnerSeconds: number | null;
  /** Attempts to land: 1 is a first try. null when the row has no count. */
  attempts: number | null;
  /** The accepted check ran the project's whole check command (the replay's cost per run). */
  ranInFull: boolean;
  /** Tokens the agent reported for this landing (`land` tokens); absent or null when it reported none. */
  tokens?: number | null;
};

/** A replay of a window this small moves too much between days to be worth a headline. */
export const STATS_COMPARE_MIN_LANDINGS = 50;
/** Landings a day close reads; a busier day is marked partial, never silently truncated. */
export const STATS_DAY_MAX_LANDINGS = 1_000;
/** People and agents listed per day; the rest add up under `others`. */
export const STATS_DAY_MAX_WHO = 40;

export function median(values: readonly number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const known = (n: number | null): n is number => n !== null && Number.isFinite(n) && n >= 0;
/** Landings that reached main while this one waited (between its "land" and its own arrival on
 * main), from Forge's recorded times: each is one rerun when branches must be up to date. */
export function rerunsWhileWaiting(landings: readonly StatsLanding[]) {
  const landed = landings.map(l => l.landedAt).sort((a, b) => a - b);
  const below = (t: number) => {
    let lo = 0,
      hi = landed.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (landed[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // Strictly inside (submittedAt, landedAt): the landing itself is excluded by the open upper end.
  return landings.map(l => Math.max(0, below(l.landedAt) - below(l.submittedAt + 1)));
}

const ints = z.array(z.number().int().nonnegative());
/** A day closed by the first method (before the all-runs method, 2026-11-19): kept readable; its CI and replay figures
 * are not shown, and a re-close (convex/projectStats.ts#recloseDays) rebuilds it. */
const statsDayV1Schema = z
  .object({
    schema: z.literal(1),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    landings: z.number().int().nonnegative(),
    partial: z.boolean(),
    planningPartial: z.literal(true).optional(),
    runner: z
      .object({
        priced: z.number().int().nonnegative(),
        unknown: z.number().int().nonnegative(),
        acceptedSeconds: z.number().nonnegative(),
        discardedSeconds: z.number().nonnegative(),
      })
      .strict(),
    firstTry: z
      .object({ counted: z.number().int().nonnegative(), first: z.number().int().nonnegative() })
      .strict(),
    toMain: ints,
    stops: z.object({ queue: ints, check: ints, land: ints }).strict(),
    replay: z.object({}).passthrough(),
    who: z.array(z.tuple([z.string(), z.number().int(), z.number().int(), z.number().int()])),
    others: z.number().int().nonnegative(),
  })
  .strict();
const tallySchema = z
  .object({
    runs: z.number().int().nonnegative(),
    seconds: z.number().nonnegative(),
    unknown: z.number().int().nonnegative(),
  })
  .strict();
const tails = z
  .object({ one: ints, queue: ints, fast: ints, slow: ints })
  .strict()
  .describe('Merge times of each replayed queue’s last entries (epoch ms): the next day starts behind them.');
/** One closed UTC day of a project, stored by the daily close (convex/projectStats.ts). */
const statsDayV2Schema = statsDayV1Schema
  .extend({
    schema: z.literal(2),
    /** Every check run started this day (src/stats-runs.ts#classifyRuns); null when the close could not read them. */
    ci: z
      .object({
        all: tallySchema,
        accepted: tallySchema,
        pending: tallySchema,
        unlinked: tallySchema,
        audits: tallySchema,
        discarded: z
          .object({
            mainMoved: tallySchema,
            failed: tallySchema,
            cancelled: tallySchema,
            superseded: tallySchema,
          })
          .strict(),
        /** Of the failed runs: rechecks after main moved, which a GitHub merge queue meets as ejections. */
        failedInQueue: tallySchema,
        /** More runs, attempts or landing lookups than the close reads in one day. */
        partial: z.boolean(),
      })
      .strict()
      .nullable(),
    /** Solo full checks this day, sorted: what one GitHub run of this project costs (runner s) and takes (wall s). */
    solo: z.object({ runnerSeconds: ints, wallSeconds: ints }).strict(),
    replay: z
      .object({
        /** The check time the replays used: the day's solo median, else the last day's. */
        wallSeconds: z.number().nonnegative().nullable(),
        /** Queue entries: the day's landings plus its failed rechecks (ejected). */
        arrivals: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        /** Landings that reached main while each waited: one rerun each when branches must be up to date. */
        reruns: z.number().int().nonnegative(),
        /** Merge-queue builds at 5 at a time, as full-build equivalents: restarts and failing builds count their
         * share of a full check. */
        builds: z.number().nonnegative(),
        /** Replayed seconds to main, sorted, per setup; null with no check time. Fast/slow: check time -/+10%. */
        oneAtATime: ints.nullable(),
        mergeQueue: ints.nullable(),
        mergeQueueFast: ints.nullable(),
        mergeQueueSlow: ints.nullable(),
        tails,
      })
      .strict(),
    /** The close did not finish (convex/projectStats.ts#closeDay): the day is not measured. It holds no figures,
     * only what the previous closed day hands on, and the page shows it as missing, never as zero. */
    failed: z
      .object({
        tries: z.number().int().positive(),
        reason: z.string(),
        /** The first day of the person work this day's close would have counted (convex/statsLanes.ts
         * #laneWindowStart): a later close past this day counts from there, so the day keeps its Lanes and planning
         * work. Absent on marks written before it was kept. */
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .strict()
      .optional(),
    /** The close stopped writing people's days before it had written them all (the transaction's meter): some people's
     * work of this close's window is not on their profile. */
    peoplePartial: z.literal(true).optional(),
    /** Agent-reported tokens (Item a61d3c91): how many of the day's landings reported and their sum. Absent when none
     * did, so a day without reports stores nothing more. */
    tokens: z
      .object({ reported: z.number().int().positive(), total: z.number().int().nonnegative() })
      .strict()
      .optional(),
  })
  .strict();
/** Forge's one "first try" (owner 2026-11-19, Item a61d3c91): a change landed with no resubmission and no discarded
 * check. Stats (convex/projectStats.ts#statsLanding) and metrics 5.1 (src/self-metrics.ts#FIRST_TRY_PATHS) both use it.
 * - Resubmission: an earlier submission of the same Intent ended without landing (failed, cancelled, interrupted or
 *   replaced by a new save) before this one, or this one supersedes another.
 * - Discarded check: a check of this change ran and was thrown away (main moved and Forge rechecked, or a recheck
 *   replaced it). A batch join, or a recompose before any check ran, discards nothing.
 * Returns the attempt count Stats stores: 1 for a first try, 2 for anything else, null when unknown. */
export function firstTry(input: { resubmitted: boolean; discardedCheck: boolean; known: boolean }) {
  if (input.resubmitted || input.discardedCheck) return 2;
  return input.known ? 1 : null;
}

export const statsDaySchema = z.union([statsDayV2Schema, statsDayV1Schema]);
export type StatsDay = z.infer<typeof statsDaySchema>;
export type StatsDayV2 = z.infer<typeof statsDayV2Schema>;

const sortedInts = (values: Array<number | null>) =>
  values
    .filter(known)
    .map(v => Math.round(v))
    .sort((a, b) => a - b);
const span = (from: number | null, to: number | null) =>
  known(from) && known(to) && to >= from ? (to - from) / 1000 : null;
/** One landing's own stops, in seconds (null when not recorded), measured as a closed day measures them: what its
 * Lane page shows beside the medians on Stats. */
export const landingStops = (l: StatsLanding) => ({
  toMain: span(l.submittedAt, l.landedAt),
  queue: span(l.submittedAt, l.checkStartedAt),
  check: span(l.checkStartedAt, l.checkEndedAt),
  land: span(l.checkEndedAt, l.landedAt),
});

/** Merge-queue replays build this many entries at once (owner 2026-11-19): a busy GitHub project's setting, not the
 * one-at-a-time worst case. */
export const MERGE_QUEUE_CONCURRENCY = 5;
/** What the previous closed day hands on: its check time and where each replayed queue ended. */
export type StatsCarry = { wallSeconds: number | null; tails: z.infer<typeof tails> };
export const NO_CARRY: StatsCarry = { wallSeconds: null, tails: { one: [], queue: [], fast: [], slow: [] } };
export function statsCarry(previous: StatsDay | null): StatsCarry {
  if (!previous || previous.schema !== 2) return NO_CARRY;
  return { wallSeconds: previous.replay.wallSeconds, tails: previous.replay.tails };
}

/** Tries a later day's close gives an earlier day whose close did not finish, before leaving it as not measured. */
export const STATS_CLOSE_TRIES = 3;
/** A day whose close has not finished: no figures, the previous day's carry handed on (src/stats-period.ts leaves it out
 * of every figure and shows it as missing). */
export function statsFailedDay(day: string, carry: StatsCarry, tries = 1, since?: string): StatsDayV2 {
  return {
    ...statsDay(day, [], null, carry),
    failed: {
      tries,
      reason: 'The day close did not finish, so this day is not measured.',
      ...(since ? { since } : {}),
    },
  };
}

/** Close one UTC day: the landings that reached main that day, every check run started that day (null when they
 * could not be read) and what the previous closed day hands on.
 * - One at a time: each change's own check is its run on an up-to-date branch; it joins at "land".
 * - Merge queue: each change first runs its pull-request check (one check time), then joins the queue; its time to
 *   main runs from the “land” request to merged. A failed recheck after main moved joins as a failing entry and is ejected; a
 *   change's own failed check fails its pull-request run and never joins. */
export function statsDay(
  day: string,
  input: readonly StatsLanding[],
  runs: ReturnType<typeof classifyRuns> | null = null,
  carry: StatsCarry = NO_CARRY,
): StatsDayV2 {
  const landings = [...input].sort((a, b) => a.landedAt - b.landedAt).slice(0, STATS_DAY_MAX_LANDINGS);
  const tally = new Map<string, [number, number, number]>();
  for (const l of landings) {
    const row = tally.get(l.who ?? '') ?? [0, 0, 0];
    row[0]++;
    if (l.attempts !== null) {
      row[2]++;
      if (l.attempts === 1) row[1]++;
    }
    tally.set(l.who ?? '', row);
  }
  const ranked = [...tally].sort((a, b) => b[1][0] - a[1][0] || a[0].localeCompare(b[0]));
  const counted = landings.filter(l => l.attempts !== null);
  const priced = landings.filter(l => known(l.runnerSeconds) && known(l.discardedRunnerSeconds));
  const reported = landings.filter(l => known(l.tokens ?? null)).map(l => Math.round(l.tokens!));
  const solo = runs?.solo ?? { runnerSeconds: [], wallSeconds: [] };
  const wallSeconds = median(solo.wallSeconds) ?? carry.wallSeconds;
  const failures = runs?.queueFailures ?? [];
  const entries = (scale: number, pullRequestFirst: boolean): QueueEntry[] => [
    ...landings.map(l => ({
      at: l.submittedAt + (pullRequestFirst ? wallSeconds! * scale * 1000 : 0),
      from: l.submittedAt,
      fails: false,
    })),
    ...failures.map(f => ({ at: f.at, fails: true, seconds: f.seconds === null ? null : f.seconds * scale })),
  ];
  const replay = (concurrency: number, scale: number, tail: number[]) =>
    wallSeconds === null
      ? null
      : mergeQueueReplay(entries(scale, concurrency > 1), wallSeconds * scale, concurrency, tail);
  const one = replay(1, 1, carry.tails.one),
    queue = replay(MERGE_QUEUE_CONCURRENCY, 1, carry.tails.queue),
    fast = replay(MERGE_QUEUE_CONCURRENCY, 0.9, carry.tails.fast),
    slow = replay(MERGE_QUEUE_CONCURRENCY, 1.1, carry.tails.slow);
  const ci = runs
    ? {
        all: runs.all,
        accepted: runs.accepted,
        pending: runs.pending,
        unlinked: runs.unlinked,
        audits: runs.audits,
        discarded: runs.discarded,
        failedInQueue: runs.failedInQueue,
        partial: runs.partial,
      }
    : null;
  return statsDaySchema.parse({
    schema: 2,
    day,
    landings: landings.length,
    partial: input.length > landings.length,
    runner: {
      priced: priced.length,
      unknown: landings.length - priced.length,
      acceptedSeconds: priced.reduce((s, l) => s + l.runnerSeconds!, 0),
      discardedSeconds: priced.reduce((s, l) => s + l.discardedRunnerSeconds!, 0),
    },
    firstTry: { counted: counted.length, first: counted.filter(l => l.attempts === 1).length },
    toMain: sortedInts(landings.map(l => span(l.submittedAt, l.landedAt))),
    stops: {
      queue: sortedInts(landings.map(l => span(l.submittedAt, l.checkStartedAt))),
      check: sortedInts(landings.map(l => span(l.checkStartedAt, l.checkEndedAt))),
      land: sortedInts(landings.map(l => span(l.checkEndedAt, l.landedAt))),
    },
    ci,
    solo,
    replay: {
      wallSeconds,
      arrivals: landings.length + failures.length,
      failed: failures.length,
      reruns: rerunsWhileWaiting(landings).reduce((s, n) => s + n, 0),
      builds: queue?.builds ?? 0,
      oneAtATime: one ? sortedInts(one.toMainSeconds) : null,
      mergeQueue: queue ? sortedInts(queue.toMainSeconds) : null,
      mergeQueueFast: fast ? sortedInts(fast.toMainSeconds) : null,
      mergeQueueSlow: slow ? sortedInts(slow.toMainSeconds) : null,
      tails: {
        one: (one?.tail ?? carry.tails.one).map(Math.round),
        queue: (queue?.tail ?? carry.tails.queue).map(Math.round),
        fast: (fast?.tail ?? carry.tails.fast).map(Math.round),
        slow: (slow?.tail ?? carry.tails.slow).map(Math.round),
      },
    },
    who: ranked.slice(0, STATS_DAY_MAX_WHO).map(([who, [n, first, counted]]) => [who, n, first, counted]),
    others: ranked.slice(STATS_DAY_MAX_WHO).reduce((s, [, [n]]) => s + n, 0),
    ...(reported.length
      ? { tokens: { reported: reported.length, total: reported.reduce((s, n) => s + n, 0) } }
      : {}),
  }) as StatsDayV2;
}

const minutesOf = (t: { runs: number; seconds: number; unknown: number }) => ({
  runs: t.runs,
  minutes: t.seconds / 60,
  unknown: t.unknown,
});
/** Why a window shows no comparison: too few landings yet, days closed before every run was recorded (or whose runs
 * could not be read), or no solo full check to price a GitHub run. */
export type CompareGap = 'landings' | 'not-recorded' | 'no-solo';

/** Sorted seconds standing for `n` values: every value while `n` is `v.length`, else evenly spaced quantiles of them (a
 * month's rollup keeps at most STATS_DIST_SAMPLES), each sample standing for n / v.length values. */
export type StatsDist = { n: number; v: number[] };
/** Samples a month rollup keeps per distribution: its medians stay within one sample's share of the exact one. */
export const STATS_DIST_SAMPLES = 400;
const exactDist = (v: readonly number[] | null): StatsDist[] =>
  v?.length ? [{ n: v.length, v: [...v] }] : [];
/** Each sample with its weight, sorted by value. */
const weighted = (parts: readonly StatsDist[]) => {
  const pairs: Array<[number, number]> = [];
  for (const p of parts) if (p.v.length) for (const x of p.v) pairs.push([x, p.n / p.v.length]);
  return pairs.sort((a, b) => a[0] - b[0]);
};
/** The median of several distributions, each sample weighted by the values it stands for: the plain median (the mean
 * of the two middle values for an even count) when every part holds every value. */
export function distMedian(parts: readonly StatsDist[]) {
  const pairs = weighted(parts);
  if (!pairs.length) return null;
  const half = pairs.reduce((s, [, w]) => s + w, 0) / 2;
  let at = 0;
  for (let i = 0; i < pairs.length; i++) {
    at += pairs[i]![1];
    if (at > half + 1e-9) return pairs[i]![0];
    if (at >= half - 1e-9) return i + 1 < pairs.length ? (pairs[i]![0] + pairs[i + 1]![0]) / 2 : pairs[i]![0];
  }
  return pairs.at(-1)![0];
}
/** One stored distribution for several: every value while they fit in `samples`, else `samples` evenly spaced
 * quantiles. */
export function distOf(parts: readonly StatsDist[], samples = STATS_DIST_SAMPLES): StatsDist {
  const pairs = weighted(parts);
  const n = parts.reduce((s, p) => s + (p.v.length ? p.n : 0), 0);
  if (pairs.length <= samples && pairs.every(([, w]) => w === 1)) return { n, v: pairs.map(([x]) => x) };
  const v: number[] = [];
  let at = 0,
    i = 0;
  for (let k = 0; k < samples; k++) {
    const rank = ((k + 0.5) * n) / samples;
    while (i < pairs.length - 1 && at + pairs[i]![1] <= rank) at += pairs[i++]![1];
    v.push(pairs[i]![0]);
  }
  return { n, v };
}

type Tally = { runs: number; seconds: number; unknown: number };
const tally = (): Tally => ({ runs: 0, seconds: 0, unknown: 0 });
const addTally = (a: Tally, b: Tally): Tally => ({
  runs: a.runs + b.runs,
  seconds: a.seconds + b.seconds,
  unknown: a.unknown + b.unknown,
});
/** What a window of closed days adds up to, before its figures are worked out (statsFigures): sums, the days' sorted
 * seconds and who landed. A day gives its own (dayTotals); a month rollup (src/stats-period.ts) stores the sum of its
 * days, so All time reads one row a month. Every figure of statsWindow comes from these alone. */
export type StatsTotals = {
  days: number;
  landings: number;
  partialLandings: boolean;
  partialRuns: boolean;
  counted: number;
  first: number;
  priced: number;
  acceptedSeconds: number;
  discardedSeconds: number;
  who: Array<[string, number, number, number]>;
  others: number;
  /** Landings that reported agent tokens, and their sum. Optional: month rollups written before it lack it. */
  tokens?: { reported: number; total: number } | undefined;
  toMain: StatsDist[];
  stops: { queue: StatsDist[]; check: StatsDist[]; land: StatsDist[] };
  /** Days closed by this method with every run read (`d.ci`). */
  ci: { days: number; landings: number; all: Tally; unlinked: Tally; discarded: Record<DiscardCause, Tally> };
  /** Of those, days with a check time to replay: the comparison's days. */
  cmp: {
    days: number;
    landings: number;
    forgeSeconds: number;
    /** Runs of these days that reported no minutes. */
    unknownRuns: number;
    toMain: StatsDist[];
    failed: Tally;
    failedInQueue: Tally;
    notLanded: { runs: number; seconds: number };
    unlinked: Tally;
    soloRunner: StatsDist[];
    soloWall: StatsDist[];
    soloRuns: number;
    /** Sum of arrivals × check seconds, for the queue's load. */
    asked: number;
    oneRuns: number;
    queueRuns: number;
    one: StatsDist[];
    queue: StatsDist[];
    fast: StatsDist[];
    slow: StatsDist[];
  };
};
const causes = () => Object.fromEntries(DISCARD_CAUSES.map(c => [c, tally()])) as Record<DiscardCause, Tally>;
export const noTotals = (): StatsTotals => ({
  days: 0,
  landings: 0,
  partialLandings: false,
  partialRuns: false,
  counted: 0,
  first: 0,
  priced: 0,
  acceptedSeconds: 0,
  discardedSeconds: 0,
  who: [],
  others: 0,
  tokens: { reported: 0, total: 0 },
  toMain: [],
  stops: { queue: [], check: [], land: [] },
  ci: { days: 0, landings: 0, all: tally(), unlinked: tally(), discarded: causes() },
  cmp: {
    days: 0,
    landings: 0,
    forgeSeconds: 0,
    unknownRuns: 0,
    toMain: [],
    failed: tally(),
    failedInQueue: tally(),
    notLanded: { runs: 0, seconds: 0 },
    unlinked: tally(),
    soloRunner: [],
    soloWall: [],
    soloRuns: 0,
    asked: 0,
    oneRuns: 0,
    queueRuns: 0,
    one: [],
    queue: [],
    fast: [],
    slow: [],
  },
});
/** One closed day's totals. */
export function dayTotals(d: StatsDay): StatsTotals {
  const t = noTotals();
  t.days = 1;
  t.landings = d.landings;
  t.partialLandings = d.partial;
  t.counted = d.firstTry.counted;
  t.first = d.firstTry.first;
  t.priced = d.runner.priced;
  t.acceptedSeconds = d.runner.acceptedSeconds;
  t.discardedSeconds = d.runner.discardedSeconds;
  t.who = d.who.map(row => [...row]);
  t.others = d.others;
  if (d.schema === 2 && d.tokens) t.tokens = { ...d.tokens };
  t.toMain = exactDist(d.toMain);
  t.stops = {
    queue: exactDist(d.stops.queue),
    check: exactDist(d.stops.check),
    land: exactDist(d.stops.land),
  };
  if (d.schema !== 2 || d.ci === null) return t;
  const ci = d.ci;
  t.partialRuns = ci.partial;
  t.ci = {
    days: 1,
    landings: d.landings,
    all: { ...ci.all },
    unlinked: { ...ci.unlinked },
    discarded: Object.fromEntries(DISCARD_CAUSES.map(c => [c, { ...ci.discarded[c] }])) as Record<
      DiscardCause,
      Tally
    >,
  };
  if (d.replay.wallSeconds === null) return t;
  t.cmp = {
    days: 1,
    landings: d.landings,
    forgeSeconds: ci.all.seconds,
    unknownRuns: ci.all.unknown,
    toMain: exactDist(d.toMain),
    failed: { ...ci.discarded.failed },
    failedInQueue: { ...ci.failedInQueue },
    notLanded: {
      runs: ci.discarded.superseded.runs + ci.discarded.cancelled.runs,
      seconds: ci.discarded.superseded.seconds + ci.discarded.cancelled.seconds,
    },
    unlinked: { ...ci.unlinked },
    soloRunner: exactDist(d.solo.runnerSeconds),
    soloWall: exactDist(d.solo.wallSeconds),
    soloRuns: d.solo.runnerSeconds.length,
    asked: d.replay.arrivals * d.replay.wallSeconds,
    oneRuns: d.landings + d.replay.reruns,
    queueRuns: d.landings + d.replay.builds,
    one: exactDist(d.replay.oneAtATime),
    queue: exactDist(d.replay.mergeQueue),
    fast: exactDist(d.replay.mergeQueueFast),
    slow: exactDist(d.replay.mergeQueueSlow),
  };
  return t;
}
/** Two windows' totals as one (sums in order, so a window of days adds exactly as its days do). */
export function addTotals(a: StatsTotals, b: StatsTotals): StatsTotals {
  const who = new Map<string, [number, number, number]>();
  for (const [name, n, first, c] of [...a.who, ...b.who]) {
    const row = who.get(name) ?? [0, 0, 0];
    who.set(name, [row[0] + n, row[1] + first, row[2] + c]);
  }
  return {
    days: a.days + b.days,
    landings: a.landings + b.landings,
    partialLandings: a.partialLandings || b.partialLandings,
    partialRuns: a.partialRuns || b.partialRuns,
    counted: a.counted + b.counted,
    first: a.first + b.first,
    priced: a.priced + b.priced,
    acceptedSeconds: a.acceptedSeconds + b.acceptedSeconds,
    discardedSeconds: a.discardedSeconds + b.discardedSeconds,
    who: [...who].map(([name, row]) => [name, ...row]),
    others: a.others + b.others,
    tokens: {
      reported: (a.tokens?.reported ?? 0) + (b.tokens?.reported ?? 0),
      total: (a.tokens?.total ?? 0) + (b.tokens?.total ?? 0),
    },
    toMain: [...a.toMain, ...b.toMain],
    stops: {
      queue: [...a.stops.queue, ...b.stops.queue],
      check: [...a.stops.check, ...b.stops.check],
      land: [...a.stops.land, ...b.stops.land],
    },
    ci: {
      days: a.ci.days + b.ci.days,
      landings: a.ci.landings + b.ci.landings,
      all: addTally(a.ci.all, b.ci.all),
      unlinked: addTally(a.ci.unlinked, b.ci.unlinked),
      discarded: Object.fromEntries(
        DISCARD_CAUSES.map(c => [c, addTally(a.ci.discarded[c], b.ci.discarded[c])]),
      ) as Record<DiscardCause, Tally>,
    },
    cmp: {
      days: a.cmp.days + b.cmp.days,
      landings: a.cmp.landings + b.cmp.landings,
      forgeSeconds: a.cmp.forgeSeconds + b.cmp.forgeSeconds,
      unknownRuns: a.cmp.unknownRuns + b.cmp.unknownRuns,
      toMain: [...a.cmp.toMain, ...b.cmp.toMain],
      failed: addTally(a.cmp.failed, b.cmp.failed),
      failedInQueue: addTally(a.cmp.failedInQueue, b.cmp.failedInQueue),
      notLanded: {
        runs: a.cmp.notLanded.runs + b.cmp.notLanded.runs,
        seconds: a.cmp.notLanded.seconds + b.cmp.notLanded.seconds,
      },
      unlinked: addTally(a.cmp.unlinked, b.cmp.unlinked),
      soloRunner: [...a.cmp.soloRunner, ...b.cmp.soloRunner],
      soloWall: [...a.cmp.soloWall, ...b.cmp.soloWall],
      soloRuns: a.cmp.soloRuns + b.cmp.soloRuns,
      asked: a.cmp.asked + b.cmp.asked,
      oneRuns: a.cmp.oneRuns + b.cmp.oneRuns,
      queueRuns: a.cmp.queueRuns + b.cmp.queueRuns,
      one: [...a.cmp.one, ...b.cmp.one],
      queue: [...a.cmp.queue, ...b.cmp.queue],
      fast: [...a.cmp.fast, ...b.cmp.fast],
      slow: [...a.cmp.slow, ...b.cmp.slow],
    },
  };
}

/** What Stats shows for a window of closed days. Measured figures are facts. `comparison` replays the same days
 * through two GitHub setups, null until the window holds STATS_COMPARE_MIN_LANDINGS landings on days closed by this
 * method with a solo full check to price them (`compare` says why not):
 * - One at a time ("Require branches to be up to date before merging"): one run per change plus a rerun each time
 *   another change reached main while it waited; changes reach main one by one.
 * - Merge queue, 5 at a time ("Require merge queue", "Build concurrency" 5, "Maximum pull requests to merge" 1): a
 *   pull-request run per change plus every queue build, failed rechecks ejected and the builds behind them restarted.
 * Runs are priced at the window's median solo full check. Work Forge ran that a GitHub flow runs the same way costs
 * the same on both sides, at its recorded minutes: failed checks (on GitHub, pull-request runs; in a queue, failing
 * builds instead), and checks of work that was replaced, withdrawn or stopped. Forge's side is every check run
 * (audits apart); checks no landing attempt names are counted on Forge's side only. */
export function statsWindow(days: readonly StatsDay[]) {
  return statsFigures(days.reduce((t, d) => addTotals(t, dayTotals(d)), noTotals()));
}

/** statsWindow's figures from a window's totals: its days, or its months' rollups (All time). */
export function statsFigures(t: StatsTotals) {
  const { ci, cmp } = t;
  const discarded = {
    runs: DISCARD_CAUSES.reduce((s, c) => s + ci.discarded[c].runs, 0),
    minutes: DISCARD_CAUSES.reduce((s, c) => s + ci.discarded[c].seconds / 60, 0),
    unknown: DISCARD_CAUSES.reduce((s, c) => s + ci.discarded[c].unknown, 0),
    byCause: Object.fromEntries(DISCARD_CAUSES.map(c => [c, minutesOf(ci.discarded[c])])) as Record<
      DiscardCause,
      ReturnType<typeof minutesOf>
    >,
  };
  // The comparison: days closed by this method with every run read and a check time to replay.
  const perRun = distMedian(cmp.soloRunner);
  const forgeMinutes = cmp.forgeSeconds / 60;
  const forgeToMain = distMedian(cmp.toMain);
  const baseline = (runs: number, recorded: { runs: number; seconds: number }, replayed: StatsDist[]) => {
    const ciMinutes = (runs * perRun! + recorded.seconds) / 60;
    const toMainSeconds = distMedian(replayed);
    return {
      /** Runs priced at the solo check (full-build equivalents), and runs taken at their recorded minutes. */
      runs,
      recordedRuns: recorded.runs,
      ciMinutes,
      /** Baseline minus Forge over the same days: positive is fewer with Forge. */
      savedMinutes: ciMinutes - forgeMinutes,
      toMainSeconds,
      sooner: toMainSeconds === null || forgeToMain === null ? null : toMainSeconds - forgeToMain,
    };
  };
  const daysWithoutRuns = t.days - ci.days;
  const daysWithoutSolo = ci.days - cmp.days;
  const gap: CompareGap | null =
    cmp.landings >= STATS_COMPARE_MIN_LANDINGS
      ? perRun === null
        ? 'no-solo'
        : null
      : t.landings >= STATS_COMPARE_MIN_LANDINGS
        ? daysWithoutRuns
          ? 'not-recorded'
          : 'no-solo'
        : 'landings';
  return {
    days: t.days,
    landings: t.landings,
    partial: t.partialLandings || t.partialRuns,
    /** Some day's close read only part of its landings (the replays cover fewer than landed) or of its check runs
     * (Forge's minutes are short): which way the comparison may be off depends on which (web/src/app/stats/model.ts). */
    partialLandings: t.partialLandings,
    partialRuns: t.partialRuns,
    /** Days closed by the first method, or whose runs could not be read: left out of the CI figures. */
    daysWithoutRuns,
    /** Days with runs read but no solo full check yet (none that day or before): left out of the comparison. */
    daysWithoutSolo,
    /** Why `comparison` is null, and the landings still needed when it is only too few. */
    compare: {
      gap,
      toGo: gap === 'landings' ? STATS_COMPARE_MIN_LANDINGS - cmp.landings : 0,
    },
    measured: {
      /** Every check run started on these days, audits apart; null when no day recorded its runs. Runs with no
       * recorded minutes are counted in `unknownRuns` and add nothing. */
      ciMinutes: ci.days ? ci.all.seconds / 60 : null,
      runs: ci.all.runs,
      unknownRuns: ci.all.unknown,
      ciMinutesPerLanding: ci.landings ? ci.all.seconds / 60 / ci.landings : null,
      /** The landed path alone: a landing's own accepted check and the checks it discarded. */
      landedPathMinutesPerLanding: t.priced ? (t.acceptedSeconds + t.discardedSeconds) / 60 / t.priced : null,
      /** Checks no landing attempt names: counted on Forge's side, never discarded. */
      unlinked: minutesOf(ci.unlinked),
      /** null when no day recorded its runs. */
      discarded: ci.days ? discarded : null,
      firstTryRate: t.counted ? t.first / t.counted : null,
      firstTryCounted: t.counted,
      /** Agent-reported tokens (Item a61d3c91), measured from `reported` of `landings`; null until one reports. Never a
       * GitHub comparison: the page links the published benchmark for that. */
      tokens: t.tokens?.reported
        ? {
            reported: t.tokens.reported,
            landings: t.landings,
            total: t.tokens.total,
            perLanding: t.tokens.total / t.tokens.reported,
          }
        : null,
      toMainSeconds: distMedian(t.toMain),
      stops: {
        queue: distMedian(t.stops.queue),
        check: distMedian(t.stops.check),
        land: distMedian(t.stops.land),
      },
    },
    comparison:
      gap !== null
        ? null
        : {
            days: cmp.days,
            landings: cmp.landings,
            forgeMinutes,
            /** Forge's median over the same days as the replays. */
            forgeToMainSeconds: forgeToMain,
            unknownRuns: cmp.unknownRuns,
            check: {
              runnerSeconds: perRun!,
              wallSeconds: distMedian(cmp.soloWall),
              runs: cmp.soloRuns,
            },
            /** Failed checks: rechecks after main moved fail in the queue; the rest fail pull-request runs. */
            failed: {
              inQueue: cmp.failedInQueue.runs,
              pullRequest: cmp.failed.runs - cmp.failedInQueue.runs,
            },
            /** Checks of work that was replaced, withdrawn or stopped: the same on both sides. */
            notLanded: { runs: cmp.notLanded.runs, minutes: cmp.notLanded.seconds / 60 },
            unlinked: minutesOf(cmp.unlinked),
            /** Check time asked of one queue as a share of the window: above 1, one at a time cannot keep up. */
            load: cmp.asked / (cmp.days * 86_400),
            oneAtATime: baseline(
              cmp.oneRuns,
              {
                runs: cmp.failed.runs + cmp.notLanded.runs,
                seconds: cmp.failed.seconds + cmp.notLanded.seconds,
              },
              cmp.one,
            ),
            mergeQueue: {
              concurrency: MERGE_QUEUE_CONCURRENCY,
              maxToMerge: 1,
              ...baseline(
                cmp.queueRuns,
                {
                  runs: cmp.failed.runs - cmp.failedInQueue.runs + cmp.notLanded.runs,
                  seconds: cmp.failed.seconds - cmp.failedInQueue.seconds + cmp.notLanded.seconds,
                },
                cmp.queue,
              ),
              /** Replayed median with the check 10% faster and 10% slower, each carried day to day on its own. */
              sensitivity: { fast: distMedian(cmp.fast), slow: distMedian(cmp.slow) },
            },
          },
    who: [...t.who]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, n, first, c]) => ({
        who: name || null,
        landings: n,
        firstTryRate: c ? first / c : null,
      })),
    others: t.others,
  };
}
