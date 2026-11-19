// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** Stats estimates contract (Issue a61d3c91; docs/run-evidence.md#stats). Owners compare what Forge measured in
 * their project with the same project's own history replayed through a GitHub-style flow: a pull
 * request check plus a merge-queue check per change, and one-at-a-time merging. Never a benchmark
 * ratio, and never a per-project token saving. Pure: no clock, no I/O, display-only. */

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
};

/** A replay of a window this small moves too much between days to be worth a headline. */
export const STATS_COMPARE_MIN_LANDINGS = 50;
/** Rows kept per day; a busier day is marked partial, never silently truncated. */
export const STATS_DAY_MAX_LANDINGS = 2_000;
/** People and agents listed per day; the rest add up under `others`. */
export const STATS_DAY_MAX_WHO = 40;

/** The project's own full check: what one replayed pull-request or merge-queue run costs and takes. */
export type FullCheck = {
  /** Median billed runner seconds per run, and median wall seconds from check start to end. */
  runnerSeconds: number | null;
  wallSeconds: number | null;
  /** `full`: medians of checks that ran the whole command. `scoped`: no full run in the window, so
   * medians of the scoped checks Forge ran, which can only understate a GitHub run (lower bound stays
   * a lower bound). */
  basis: 'full' | 'scoped' | 'none';
  runs: number;
};

export function median(values: readonly number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const known = (n: number | null): n is number => n !== null && Number.isFinite(n) && n >= 0;
const wall = (l: StatsLanding) =>
  known(l.checkStartedAt) && known(l.checkEndedAt) && l.checkEndedAt >= l.checkStartedAt
    ? (l.checkEndedAt - l.checkStartedAt) / 1000
    : null;

export function fullCheck(landings: readonly StatsLanding[]): FullCheck {
  const full = landings.filter(l => l.ranInFull && known(l.runnerSeconds));
  const pool = full.length ? full : landings.filter(l => known(l.runnerSeconds));
  const walls = pool.map(wall).filter(known);
  return {
    runnerSeconds: median(pool.map(l => l.runnerSeconds!)),
    wallSeconds: median(walls),
    basis: full.length ? 'full' : pool.length ? 'scoped' : 'none',
    runs: pool.length,
  };
}

/** One-at-a-time merge queue over the same arrivals, each run taking `serviceSeconds`. `freeAt` carries
 * the queue across windows (the previous day's last finish); one pass, arrivals oldest first. */
export function replayQueue(arrivals: readonly number[], serviceSeconds: number, freeAt = 0) {
  const sorted = [...arrivals].sort((a, b) => a - b),
    toMain: number[] = [];
  let free = freeAt;
  for (const at of sorted) {
    const done = Math.max(at, free) + serviceSeconds * 1000;
    toMain.push((done - at) / 1000);
    free = done;
  }
  return { toMainSeconds: toMain, freeAt: free };
}

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

/** The CI range and replayed time to main for one window of landings. Landings with unknown runner
 * minutes leave the CI figures (both measured and replayed) and are counted in `unknownRunner`. */
export function replayEstimate(landings: readonly StatsLanding[], freeAt = 0) {
  const priced = landings.filter(l => known(l.runnerSeconds) && known(l.discardedRunnerSeconds));
  const check = fullCheck(landings);
  const reruns = rerunsWhileWaiting(landings);
  const pricedSet = new Set(priced);
  const pricedReruns = landings.reduce((sum, l, i) => sum + (pricedSet.has(l) ? reruns[i]! : 0), 0);
  const runs = priced.length * 2;
  const perRun = check.runnerSeconds;
  const queue =
    check.wallSeconds === null
      ? null
      : replayQueue(
          landings.map(l => l.submittedAt),
          check.wallSeconds,
          freeAt,
        );
  return {
    landings: landings.length,
    priced: priced.length,
    unknownRunner: landings.length - priced.length,
    fullCheck: check,
    measuredRunnerSeconds: priced.reduce((s, l) => s + l.runnerSeconds! + l.discardedRunnerSeconds!, 0),
    runs,
    reruns: pricedReruns,
    replayRunnerSeconds:
      perRun === null ? null : { low: runs * perRun, high: (runs + pricedReruns) * perRun },
    replayToMainSeconds: queue?.toMainSeconds ?? null,
    freeAt: queue?.freeAt ?? freeAt,
  };
}

const ints = z.array(z.number().int().nonnegative());
/** One closed UTC day of a project, stored by the daily close (convex/projectStats.ts). */
export const statsDaySchema = z
  .object({
    schema: z.literal(1),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    landings: z.number().int().nonnegative(),
    partial: z.boolean(),
    /** The close stopped counting people's planning work (Items closed, comments) at a cap, or some was already
     * archived (convex/personWork.ts); the person-day entries it touched are marked too. */
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
    /** Seconds, sorted: measured "land" to on main, and the stops on the way when recorded. */
    toMain: ints,
    stops: z.object({ queue: ints, check: ints, land: ints }).strict(),
    replay: z
      .object({
        fullCheck: z
          .object({
            runnerSeconds: z.number().nonnegative().nullable(),
            wallSeconds: z.number().nonnegative().nullable(),
            basis: z.enum(['full', 'scoped', 'none']),
            runs: z.number().int().nonnegative(),
          })
          .strict(),
        runs: z.number().int().nonnegative(),
        reruns: z.number().int().nonnegative(),
        runnerSeconds: z
          .object({ low: z.number().nonnegative(), high: z.number().nonnegative() })
          .strict()
          .nullable(),
        /** Replayed seconds to main, sorted; null when no check time was recorded that day. */
        toMain: ints.nullable(),
        /** When the replayed queue frees up (epoch ms): the next day's replay starts behind it. */
        freeAt: z.number().nonnegative(),
      })
      .strict(),
    /** [who, landings, first tries, landings with an attempt count], most landings first. */
    who: z.array(z.tuple([z.string(), z.number().int(), z.number().int(), z.number().int()])),
    others: z.number().int().nonnegative(),
  })
  .strict();
export type StatsDay = z.infer<typeof statsDaySchema>;

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

/** Close one UTC day: the landings that reached main that day, oldest first, and the replayed
 * queue's `freeAt` from the day before (0 for the first day). */
export function statsDay(day: string, input: readonly StatsLanding[], freeAt = 0): StatsDay {
  const landings = [...input].sort((a, b) => a.landedAt - b.landedAt).slice(0, STATS_DAY_MAX_LANDINGS);
  const estimate = replayEstimate(landings, freeAt);
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
  return statsDaySchema.parse({
    schema: 1,
    day,
    landings: landings.length,
    partial: input.length > landings.length,
    runner: {
      priced: estimate.priced,
      unknown: estimate.unknownRunner,
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
    replay: {
      fullCheck: estimate.fullCheck,
      runs: estimate.runs,
      reruns: estimate.reruns,
      runnerSeconds: estimate.replayRunnerSeconds,
      toMain: estimate.replayToMainSeconds === null ? null : sortedInts(estimate.replayToMainSeconds),
      freeAt: estimate.freeAt,
    },
    who: ranked.slice(0, STATS_DAY_MAX_WHO).map(([who, [n, first, counted]]) => [who, n, first, counted]),
    others: ranked.slice(STATS_DAY_MAX_WHO).reduce((s, [, [n]]) => s + n, 0),
  });
}

/** What Stats shows for a window of closed days. Measured figures are facts; `comparison` is the
 * own-history replay, null until the window holds STATS_COMPARE_MIN_LANDINGS landings. */
export function statsWindow(days: readonly StatsDay[]) {
  const sum = (pick: (d: StatsDay) => number) => days.reduce((s, d) => s + pick(d), 0);
  const merged = (pick: (d: StatsDay) => number[] | null) => days.flatMap(d => pick(d) ?? []);
  const landings = sum(d => d.landings);
  const priced = sum(d => d.runner.priced);
  const ciMinutes = (sum(d => d.runner.acceptedSeconds) + sum(d => d.runner.discardedSeconds)) / 60;
  const counted = sum(d => d.firstTry.counted);
  const toMain = median(merged(d => d.toMain));
  const replayDays = days.filter(d => d.replay.runnerSeconds !== null);
  // A day with no priced full check cannot be replayed; its landings are counted as unpriced.
  const replayPriced = replayDays.reduce((s, d) => s + d.runner.priced, 0);
  const measuredReplayed =
    replayDays.reduce((s, d) => s + d.runner.acceptedSeconds + d.runner.discardedSeconds, 0) / 60;
  const low = replayDays.reduce((s, d) => s + d.replay.runnerSeconds!.low, 0) / 60;
  const high = replayDays.reduce((s, d) => s + d.replay.runnerSeconds!.high, 0) / 60;
  const replayToMain = median(merged(d => d.replay.toMain));
  const who = new Map<string, [number, number, number]>();
  for (const d of days)
    for (const [name, n, first, c] of d.who) {
      const row = who.get(name) ?? [0, 0, 0];
      who.set(name, [row[0] + n, row[1] + first, row[2] + c]);
    }
  return {
    days: days.length,
    landings,
    partial: days.some(d => d.partial),
    measured: {
      ciMinutes,
      pricedLandings: priced,
      unknownRunner: sum(d => d.runner.unknown),
      ciMinutesPerLanding: priced ? ciMinutes / priced : null,
      wastedMinutes: sum(d => d.runner.discardedSeconds) / 60,
      firstTryRate: counted ? sum(d => d.firstTry.first) / counted : null,
      firstTryCounted: counted,
      toMainSeconds: toMain,
      stops: {
        queue: median(merged(d => d.stops.queue)),
        check: median(merged(d => d.stops.check)),
        land: median(merged(d => d.stops.land)),
      },
    },
    comparison:
      landings < STATS_COMPARE_MIN_LANDINGS || !replayDays.length
        ? null
        : {
            pricedLandings: replayPriced,
            runs: replayDays.reduce((s, d) => s + d.replay.runs, 0),
            reruns: replayDays.reduce((s, d) => s + d.replay.reruns, 0),
            ciMinutes: { low, high },
            /** Replayed minus measured, over the same priced landings: positive is fewer with Forge. */
            savedMinutes: { atLeast: low - measuredReplayed, upTo: high - measuredReplayed },
            toMainSeconds: replayToMain,
            sooner: toMain === null || replayToMain === null ? null : replayToMain - toMain,
            fullCheck: {
              runnerSeconds: median(replayDays.map(d => d.replay.fullCheck.runnerSeconds!).filter(known)),
              wallSeconds: median(replayDays.map(d => d.replay.fullCheck.wallSeconds).filter(known)),
              basis: replayDays.every(d => d.replay.fullCheck.basis === 'full') ? 'full' : 'scoped',
            },
          },
    who: [...who]
      .sort((a, b) => b[1][0] - a[1][0] || a[0].localeCompare(b[0]))
      .map(([name, [n, first, c]]) => ({
        who: name || null,
        landings: n,
        firstTryRate: c ? first / c : null,
      })),
    others: sum(d => d.others),
  };
}
