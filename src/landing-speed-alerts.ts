// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { HostedLandingState } from './hosted-landing.js';
import { digest } from './state/hash.js';
import { percentile } from './self-metrics-joins.js';
import { costGuardSchema, costBudgetSchema, discardedRunnerSeconds } from './cost-budgets.js';

/** Speed budget ratchet (Issue a217b83e), an automatic setting judged inside the landing that already
 * writes the budget row (below); no call, read or timer of its own. It lives in this module so CLI and MCP
 * load no extra module for it (agent-weight ceilings).
 * - Signal: the worst rolling-window value of each landing-judged percentile budget per UTC day.
 * - Formula: after RATCHET_DAYS closed days with landings, every one at or under the line, the line
 *   becomes max(worst held day, today's value so far, median of the held days + band), rounded up to
 *   two significant figures. The band is 3 x 1.4826 x the held days' MAD, never under 15% of the line:
 *   the signal is a smoothed rolling percentile, so its day-to-day MAD understates real spread.
 * - Bounds: never above the file's `max` (a line never loosens past it by itself), never below the
 *   value judged now or the worst held day, so the data that set a line cannot break it.
 * - Undo: a window over a ratcheted line but at or under the file `max` is not a P0. The ratchet is
 *   undone (back to the line before it, or the file `max` when the value is over that too) with a
 *   recorded reason and one message. Only the file `max` opens the P0 Issue.
 * - Override: `"ratchet": false` pins a budget to its file `max` (any ratcheted line is dropped; held
 *   days still count, so the report shows what the automatic line would be); editing `max` in
 *   src/speed-budgets.json, with the data and reason, replaces any ratcheted line and restarts the hold.
 * - Top metric: the budget's own statistic; it interacts with its own break and recovery only. Each undo
 *   also records the shared flow metric it could have moved (lead note on a217b83e, Forge adapts): how
 *   many landings landed while the tighter line held, and how many of their outcomes it changed. That is
 *   0 by construction: no landing, queue or acceptance path reads a speed line, only these alerts do
 *   (tests/speed-budget-ratchet.test.mjs lists every reader of the speed row and fails on a new one). */
const RATCHET_DAYS = 7;
/** Undo records kept per budget, newest last. */
const UNDOS_KEPT = 4;
/** Landing outcomes a speed line can change: none, it only sends alerts (see the reader guard above). */
export const LINE_OUTCOMES_CHANGED = 0;
/** The band's floor as a share of the current line. */
const MIN_BAND = 0.15;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const ratchetEntrySchema = z
  .object({
    /** Today's worst window value so far; it joins `days` once a later day's landing closes it. */
    open: z.tuple([day, z.number()]).optional(),
    /** The worst value of each closed day with landings while the line held, oldest first. */
    days: z.array(z.tuple([day, z.number()])).max(RATCHET_DAYS),
    /** The ratcheted line, the file `max` it tightened (a different file `max` drops it), and the
     * line it replaced (an undo returns there). */
    line: z.number().nonnegative().optional(),
    fromMax: z.number().nonnegative().optional(),
    from: z.number().nonnegative().optional(),
    at: z.iso.datetime().optional(),
    landing: z.string().optional(),
    reason: z.string().max(400).optional(),
    /** Each undo: [day, tightened line, line back to, landings landed while it held (in the retained
     * row, so at most 40), landing outcomes it changed]. Newest last. */
    undos: z
      .array(
        z.tuple([
          day,
          z.number(),
          z.number(),
          z.number().int().nonnegative(),
          z.number().int().nonnegative(),
        ]),
      )
      .max(UNDOS_KEPT)
      .optional(),
  })
  .strict();
type RatchetEntry = z.infer<typeof ratchetEntrySchema>;

/** The line a budget is judged against: the file `max` when pinned, else the ratcheted line while the
 * file `max` it came from stands. */
export const ratchetedLine = (max: number, entry?: RatchetEntry, pinned = false) =>
  !pinned && entry?.line !== undefined && entry.fromMax === max ? Math.min(entry.line, max) : max;

/** Round up to two significant figures, so a line reads as a plain number in any unit. */
function roundUp2(value: number) {
  if (!(value > 0)) return 0;
  const step = 10 ** (Math.floor(Math.log10(value)) - 1);
  return Number((Math.ceil(value / step - 1e-9) * step).toPrecision(2));
}
const ratchetMedian = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b),
    middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const round3 = (n: number) => Number(n.toPrecision(3));
/** The line the held days support: their median plus the noise band, never below the worst held day
 * or the value judged now. */
function ratchetTarget(days: number[], line: number, now: number) {
  const mid = ratchetMedian(days),
    band = Math.max(3 * 1.4826 * ratchetMedian(days.map(value => Math.abs(value - mid))), MIN_BAND * line),
    floor = Math.max(...days, now);
  return { median: mid, band, floor, line: roundUp2(Math.max(floor, mid + band)) };
}

type RatchetStep = {
  entry: RatchetEntry;
  /** The line judged after this landing. */
  line: number;
  /** Set when this landing tightened the line. */
  ratcheted?: { from: number; to: number; reason: string };
  /** Set when this landing's value broke a ratcheted line at or under the file max. */
  undone?: { from: number; to: number; reason: string; landed: number; changed: number };
};
const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10);
/** Pure: fold one landing's window value into the budget's entry. `at` is the landing's time. */
export function stepRatchet(
  previous: RatchetEntry | undefined,
  value: number,
  max: number,
  at: number,
  landing: string,
  pinned = false,
  /** Landings landed since the line tightened (from the retained row), for the undo's flow record. */
  landedSince = 0,
  /** A day budget: `value` is a whole closed day, held (or not) at once instead of on the next day. */
  closedDay = false,
): RatchetStep {
  // A changed file line is a manual override: drop the old ratchet and start a new hold.
  const kept =
    previous && (previous.fromMax === undefined || previous.fromMax === max) ? previous : undefined;
  let line = ratchetedLine(max, kept, pinned);
  const today = isoDay(at);
  let open = kept?.open,
    days: [string, number][] = [...(kept?.days ?? [])];
  if (open && open[0] < today) {
    // A closed day over the line breaks the hold.
    days = open[1] <= line ? [...days, open].slice(-RATCHET_DAYS) : [];
    open = undefined;
  }
  open = open && open[0] === today ? [today, Math.max(open[1], value)] : [today, value];
  if (closedDay) {
    days = open[1] <= line ? [...days, open].slice(-RATCHET_DAYS) : [];
    open = undefined;
  }
  const opened = open ? { open } : {};
  // Pinned: judged at the file max; held days still count for the report's automatic line.
  if (pinned) return { entry: { ...opened, days }, line };
  if (kept?.line !== undefined && line < max && value > line) {
    // Over a ratcheted line: undo the ratchet, never a P0 unless the file max breaks too.
    const back = kept.from !== undefined && kept.from <= max && value <= kept.from ? kept.from : max;
    const since = kept.at ? Math.max(0, Math.floor((at - Date.parse(kept.at)) / 86_400_000)) : null;
    const changed = LINE_OUTCOMES_CHANGED;
    const reason =
      `Ratchet undone: the window reached ${value}, over the ratcheted line ${line}` +
      (since === null ? '' : ` ${since} day${since === 1 ? '' : 's'} after it tightened`) +
      `; line back to ${back}${back === max ? ' (the file max)' : ''}. ` +
      `Flow: ${landedSince} landing${landedSince === 1 ? '' : 's'} landed while it held; it changed ${changed} of their outcomes (a speed line only sends alerts).`;
    const undone = { from: line, to: back, reason, landed: landedSince, changed };
    const undos = [
      ...(kept.undos ?? []),
      [today, line, back, landedSince, changed] as [string, number, number, number, number],
    ].slice(-UNDOS_KEPT);
    line = back;
    return {
      entry:
        back < max
          ? {
              ...opened,
              days: [],
              line: back,
              fromMax: max,
              from: max,
              at: new Date(at).toISOString(),
              landing,
              reason,
              undos,
            }
          : { ...opened, days: [], undos },
      line,
      ...(value <= max ? { undone } : {}),
    };
  }
  const base = {
    ...(kept?.line !== undefined ? { line: kept.line, fromMax: kept.fromMax } : {}),
    ...(kept?.from !== undefined ? { from: kept.from } : {}),
    ...(kept?.at ? { at: kept.at, landing: kept.landing, reason: kept.reason } : {}),
    ...(kept?.undos ? { undos: kept.undos } : {}),
  };
  const entry: RatchetEntry = { ...base, ...opened, days };
  if (days.length < RATCHET_DAYS) return { entry, line };
  const target = ratchetTarget(
    days.map(d => d[1]),
    line,
    open?.[1] ?? value,
  );
  if (!(target.line < line)) return { entry, line };
  const reason =
    `Held at or under ${line} for ${RATCHET_DAYS} closed days, ${days[0]![0]} to ${days.at(-1)![0]}: worst ${round3(target.floor)}, ` +
    `median ${round3(target.median)}, band ${round3(target.band)} (3 x 1.4826 x MAD, at least ${MIN_BAND * 100}% of the line); line ${line} -> ${target.line}.`;
  return {
    entry: {
      ...opened,
      days: [],
      line: target.line,
      fromMax: max,
      from: line,
      at: new Date(at).toISOString(),
      landing,
      reason,
      ...(kept?.undos ? { undos: kept.undos } : {}),
    },
    line: target.line,
    ratcheted: { from: line, to: target.line, reason },
  };
}

/** For the report: the line judged now, what the automatic rule would pick from the held days (a pinned
 * budget included), and the closed held days still needed before the next ratchet can happen. */
export function ratchetStatus(entry: RatchetEntry | undefined, max: number, pinned = false) {
  const line = ratchetedLine(max, entry, pinned);
  const days = entry?.days ?? [];
  const automatic =
    days.length >= RATCHET_DAYS
      ? Math.min(
          ratchetTarget(
            days.map(d => d[1]),
            line,
            entry?.open?.[1] ?? 0,
          ).line,
          line,
        )
      : null;
  return {
    line,
    pinned,
    automatic,
    daysLeft: Math.max(0, RATCHET_DAYS - days.length),
    ...(entry?.line !== undefined && entry.fromMax === max && !pinned
      ? { since: entry.at ?? null, reason: entry.reason ?? null }
      : {}),
  };
}

/** Speed budgets (b7851c44). The numbers, their sources and reasons live in
 * src/speed-budgets.json; this module only judges landings against them. A budget is
 * judged on the last `window.landings` landings, never on one outlier. */
export const speedBudgetSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    area: z.string().min(1),
    /** landing-record: judged on every landing from stamps it already carries. perf-harness: measured
     * by scripts/perf-harness.mjs. build-guard: enforced by a check that fails the build. unrecorded:
     * nothing records the value yet; the report says so and names the gap. */
    measuredBy: z.enum(['landing-record', 'perf-harness', 'build-guard', 'unrecorded']),
    metric: z.string().min(1),
    /** mean: cost budgets, where every landing's share adds up; p50/p90: speed budgets; day: the total
     * of one closed UTC day (the waste tripwire), judged once when the day's last landing is followed. */
    stat: z.enum(['p50', 'p90', 'mean', 'day']).optional(),
    unit: z.enum(['min', 's', 'ms', 'calls', 'bytes', 'attempts', 'writes', 'ops', 'USD']),
    max: z.number().min(0).nullable(),
    source: z.string().min(1),
    reason: z.string().min(1),
    /** The decision Issue (first 8 characters) this budget protects. */
    issue: z
      .string()
      .regex(/^[0-9a-f]{8}$/)
      .optional(),
    /** false pins the budget to its file max: the ratchet (stepRatchet above) never tightens it,
     * and any line it tightened before is dropped. */
    ratchet: z.literal(false).optional(),
  })
  .strict();
export const speedBudgetsSchema = z
  .object({
    schema: z.literal(1),
    window: z.object({ landings: z.number().int().min(5).max(30) }).strict(),
    budgets: z.array(speedBudgetSchema).min(1),
    /** Per-landing cost ledger judged on change by the landing check (src/cost-budgets.ts). */
    costGuard: costGuardSchema,
    costs: z.array(costBudgetSchema).min(1),
  })
  .strict();
export type SpeedBudget = z.infer<typeof speedBudgetSchema>;
export type SpeedBudgets = z.infer<typeof speedBudgetsSchema>;
/** attempts and writes are cost counts (Issue 3e3f9fe6): the landing's attempts (each a compose and a
 * check or a reuse) and its landing-state writes (the mutations of its own landing path). The r2 and
 * runner metrics are its other counts, kept in one `counts` entry of its sample (see COUNT). */
export type LandingMetric =
  | 'saveMs'
  | 'preflightMs'
  | 'toMain'
  | 'check'
  | 'settle'
  | 'passToLand'
  | 'attempts'
  | 'writes'
  | 'r2ClassA'
  | 'r2ClassB'
  | 'r2RequestUsd'
  | 'r2BytesPut'
  | 'runnerAccepted'
  | 'runnerDiscarded'
  | 'runnerAudit'
  | 'runnerFull'
  | 'wasteDaily';
type Stat = 'p50' | 'p90' | 'mean' | 'day';
const INDEX: Partial<Record<LandingMetric, number>> = {
  toMain: 1,
  saveMs: 8,
  preflightMs: 9,
  check: 2,
  settle: 4,
  attempts: 5,
  writes: 6,
  passToLand: 10,
};
/** Position in a sample's `counts` and the divisor into the metric's unit: runner seconds become minutes. */
const COUNT: Partial<Record<LandingMetric, [number, number]>> = {
  r2ClassA: [0, 1],
  r2ClassB: [1, 1],
  r2BytesPut: [2, 1],
  runnerAccepted: [3, 60],
  runnerDiscarded: [4, 60],
  runnerAudit: [5, 60],
  runnerFull: [6, 60],
};
const METRICS = [
  ...Object.keys(INDEX),
  ...Object.keys(COUNT),
  'r2RequestUsd',
  'wasteDaily',
] as LandingMetric[];
const isLanding = (b: SpeedBudget): b is SpeedBudget & { metric: LandingMetric; stat: Stat; max: number } =>
  b.measuredBy === 'landing-record' && !!b.stat && b.max !== null && (METRICS as string[]).includes(b.metric);
/** The budgets a landing's own stamps can judge. */
export const landingBudgets = (budgets: SpeedBudgets) => budgets.budgets.filter(isLanding);

const minute = 60_000;
/** Retained samples per project (about 3.7 KB with counts): the window plus gaps where a stamp was missing. */
const MAX_SAMPLES = 40;
/** R2 requests signed by its composes (class A, class B, bytes put), then the shard execution seconds of
 * the accepted check run, of the runs its attempts discarded, and of the main audit run that followed it;
 * last, the accepted run's seconds again when it was a full check (null for a scoped check), absent on
 * rows written before that budget (Issue a217b83e). */
const countsSchema = z.tuple([
  z.number().int().min(0).nullable(),
  z.number().int().min(0).nullable(),
  z.number().int().min(0).nullable(),
  z.number().min(0).nullable(),
  z.number().min(0).nullable(),
  z.number().min(0).nullable(),
  z.number().min(0).nullable().optional(),
]);
export type LandingCounts = z.infer<typeof countsSchema>;
const sampleSchema = z.tuple([
  z.number().int(),
  z.number().nullable(),
  z.number().nullable(),
  z.string(),
  // Seconds from the check result to the commit; absent on rows written before this budget.
  z.number().nullable().optional(),
  // Attempts and landing-state writes (cost counts); absent on rows written before them.
  z.number().nullable().optional(),
  z.number().nullable().optional(),
  // Counts of the landing; absent on rows written before them.
  countsSchema.nullable().optional(),
  z.number().nonnegative().nullable().optional(),
  z.number().nonnegative().nullable().optional(),
  // Minutes from the first passed check to the commit; absent on rows written before it (42200ce4).
  z.number().nonnegative().nullable().optional(),
]);
/** Whole-check shift (Item a217b83e, lead 7c9e5a86): name the landing behind a step in runner minutes per
 * full check. The hosted executor and check runner run from main's control checkout, so a change to them
 * shows only in checks reserved after it landed; the landing whose own check first saw the shift is never
 * blamed. Signal: ln runner minutes of the full checks in the row (counts slot 6), ordered by when each
 * check was reserved (commit time minus settle minus check minutes, all already in the sample).
 * - A split between two consecutive full checks names the landings committed between their reservations.
 * - Before: up to SHIFT_BEFORE full checks reserved earlier, at least SHIFT_BEFORE_MIN. After: the first
 *   SHIFT_AFTER full checks reserved later, at least SHIFT_AFTER_MIN.
 * - Band: 3 x 1.4826 x MAD of the before logs, never under ln(1.15) (the F1 floor of the ratchet).
 * - Named when the after median is beyond the before median by more than the band and every after check
 *   is beyond it in the same direction, so one slow runner never names anyone. The earliest such split
 *   wins. After a named shift, a later split needs a baseline of checks all reserved after it, so the same
 *   shift is never named twice and the next one is judged against the new normal. */
const SHIFT_BEFORE = 10,
  SHIFT_BEFORE_MIN = 8,
  SHIFT_AFTER = 5,
  SHIFT_AFTER_MIN = 3;
export type CheckShift = {
  /** The landings committed between the last check before and the first check after (newest last). */
  landings: string[];
  /** Median runner minutes per full check before and after, and the band in the same log units. */
  before: number;
  after: number;
  band: number;
  checks: { before: number; after: number };
  /** When the first check after the shift was reserved (ms). */
  reservedAt: number;
};
export function wholeCheckShift(
  samples: LandingSpeedState['samples'],
  named?: [number, string],
): CheckShift | null {
  const full = samples
    .flatMap(row => {
      const seconds = row[7]?.[6],
        check = row[2],
        settle = row[4];
      if (seconds == null || !(seconds > 0) || check == null || settle == null) return [];
      return [{ reserved: row[0] - settle * 1000 - check * minute, log: Math.log(seconds / 60) }];
    })
    .sort((a, b) => a.reserved - b.reserved);
  for (let k = SHIFT_BEFORE_MIN; k + SHIFT_AFTER_MIN <= full.length; k++) {
    const first = full[k]!.reserved,
      last = full[k - 1]!.reserved,
      baseline = full.slice(Math.max(0, k - SHIFT_BEFORE), k);
    if (named && (first <= named[0] || baseline[0]!.reserved < named[0])) continue;
    const landings = samples.filter(row => row[0] >= last && row[0] < first).map(row => row[3]);
    if (!landings.length) continue;
    const before = baseline.map(c => c.log),
      after = full.slice(k, k + SHIFT_AFTER).map(c => c.log);
    const mid = ratchetMedian(before),
      band = Math.max(3 * 1.4826 * ratchetMedian(before.map(v => Math.abs(v - mid))), Math.log(1 + MIN_BAND)),
      shift = ratchetMedian(after) - mid,
      sign = Math.sign(shift);
    if (!(Math.abs(shift) > band) || !after.every(v => (v - mid) * sign > band)) continue;
    return {
      landings,
      before: round(Math.exp(mid)),
      after: round(Math.exp(mid + shift)),
      band: round3(band),
      checks: { before: before.length, after: after.length },
      reservedAt: Math.round(first),
    };
  }
  return null;
}

const brokenSchema = z
  .object({
    since: z.iso.datetime(),
    landing: z.string(),
    value: z.number(),
    stage: z.string().optional(),
  })
  .strict();
export const landingSpeedStateSchema = z
  .object({
    schema: z.literal(2),
    /** [settled at ms, time-to-main minutes, check minutes, landing id, settle seconds, attempts,
     * landing-state writes, counts, save ms, preflight ms, pass-to-land minutes], oldest first. */
    samples: z.array(sampleSchema),
    /** Budgets over their limit now, by budget id: one entry means one alert and one Issue. */
    broken: z.record(z.string(), brokenSchema),
    /** Ratchet state by budget id (stepRatchet above); absent on rows written before it. */
    ratchet: z.record(z.string(), ratchetEntrySchema).optional(),
    /** Budgets that cannot be judged although the row is full (too few stamped landings): since when. */
    short: z.record(z.string(), z.iso.datetime()).optional(),
    /** The last whole-check shift named (wholeCheckShift below): [ms the first check after it was
     * reserved, landing id]; absent until one is named. */
    shift: z.tuple([z.number().int(), z.string()]).optional(),
  })
  .strict();
export type LandingSpeedState = z.infer<typeof landingSpeedStateSchema>;
/** What `nforge metrics` reads of the live row: ratcheted lines, held days and too-little-data notes. */
export const landingSpeedSummarySchema = landingSpeedStateSchema.pick({ ratchet: true, short: true });
export type LandingSpeedSample = {
  at: number;
  saveMs?: number | null;
  preflightMs?: number | null;
  /** The landed state's acceptance receipt: names the landing that crossed a budget. */
  id: string;
  toMain: number | null;
  check: number | null;
  /** Seconds from the check result (ciEndedAt) to the commit: the gap the landing supervisor must keep short. */
  settle: number | null;
  /** Minutes from its first passed check to the commit (queue health alarm, 42200ce4): unlike `settle`,
   * a pass discarded by a main move or held behind an older entry still counts from its first pass. */
  passToLand?: number | null;
  /** Attempts this landing took (1 when nothing recomposed or re-ran), and its landing-state writes. */
  attempts?: number | null;
  writes?: number | null;
  /** R2 requests and runner seconds (see countsSchema); the audit slot starts at 0 and the main audit adds to it. */
  counts?: LandingCounts | null;
  /** Minutes in each stage of this landing: waiting and composing, check, settling. */
  stages: { queue: number | null; check: number | null; settle: number | null };
};
export type SpeedBudgetEvent = {
  /** `undone`: a ratcheted line broke at or under the file max and went back (no P0). `short`: the full
   * row holds too few stamped landings to judge the budget (no P0). `shift`: runner minutes per full
   * check stepped after a landing landed (the budget is the runner-full one; no P0, a message). */
  kind: 'broken' | 'recovered' | 'ratcheted' | 'undone' | 'short' | 'shift';
  budget: SpeedBudget;
  /** The statistic over the window now. */
  value: number;
  /** The line judged: the file `max`, or its ratcheted line. */
  line: number;
  /** Ratcheted and undone: the line before, and the recorded one-line reason. */
  from?: number;
  reason?: string;
  /** Short only: stamped landings in the retained row, and how many it holds. */
  stamped?: number;
  retained?: number;
  landing: string;
  since: string;
  /** The longest stage of the landing that crossed (broken only). */
  stage?: string;
  /** Missing stamps in the newest landing window, excluded rather than charged as zero. */
  unknown?: number;
  /** Day budgets: the closed UTC day judged, and its landings. */
  day?: string;
  landings?: number;
  /** Shift only: what changed and the landings it names. */
  shift?: CheckShift;
  /** Undone only: landings landed while the tighter line held, and landing outcomes it changed. */
  flow?: { landed: number; changed: number };
};

const span = (from?: string, to?: string, unit = minute) => {
  if (!from || !to) return null;
  const value = (Date.parse(to) - Date.parse(from)) / unit;
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 10) / 10 : null;
};
type LandingTiming = NonNullable<HostedLandingState['timing']>;
/** The first pass the landed state alone gives: its accepted check's end, never before its own
 * submission (a reused check). */
function stampedPass(timing: LandingTiming): string | undefined {
  return timing.ciEndedAt && Date.parse(timing.ciEndedAt) < Date.parse(timing.submittedAt)
    ? timing.submittedAt
    : timing.ciEndedAt;
}
/** The first-ready stamp of a landing that a person's review or a dependency held after its check
 * passed (review 663e89b0). That wait is not queue health: such a landing gives no pass-to-land
 * sample, and the stamp stays this value through every later write. */
export const PASS_HELD = 0;
/** At landing the request row keeps its first-ready stamp only when that pass came over a minute
 * before what the landed state alone gives (it was held and re-checked after passing); a landing
 * that went straight in drops it, so its stored row does not grow (42200ce4). */
export function keepsPassStamp(state: HostedLandingState, passedAt?: number): boolean {
  if (passedAt === undefined) return false;
  if (passedAt === PASS_HELD) return true;
  const stamped = Date.parse((state.timing && stampedPass(state.timing)) ?? '');
  return !Number.isFinite(stamped) || passedAt < stamped - 60_000;
}
/** Data already on the landed state: no extra read. Missing stamps leave that metric unknown.
 * `attempts` comes from the accepted attempt the accept mutation already holds; `passedAt` from the
 * request row it already holds (first ready, ms). Without it, a landing that never waited ready
 * counts from its accepted check's end, and never from before its own submission (a reused check). */
export function landingSpeedSample(
  state: HostedLandingState,
  attempts: number | null = null,
  passedAt?: number,
): LandingSpeedSample | null {
  const timing = state.timing;
  const at = Date.parse(timing?.committedAt ?? timing?.settledAt ?? '');
  if (!timing || !Number.isFinite(at)) return null;
  const firstPass =
    passedAt === PASS_HELD
      ? undefined
      : passedAt !== undefined
        ? new Date(passedAt).toISOString()
        : stampedPass(timing);
  return {
    at,
    saveMs: timing.ms?.[0] ?? null,
    preflightMs: timing.ms?.[1] ?? null,
    id: state.acceptance?.receiptId ?? state.id,
    toMain: span(timing.submittedAt, timing.committedAt),
    check: span(timing.checkReservedAt, timing.ciEndedAt),
    settle: span(timing.ciEndedAt, timing.committedAt, 1000),
    passToLand: span(firstPass, timing.committedAt),
    attempts,
    // The landing state starts at version 0 and every write adds one (projectHostedLandingStore).
    writes: Number.isSafeInteger(state.version) ? state.version + 1 : null,
    // A count nobody reported stays null, so a gap never reads as zero cost.
    counts: [
      state.counts?.r2?.[0] ?? null,
      state.counts?.r2?.[1] ?? null,
      state.counts?.r2?.[2] ?? null,
      state.counts?.runnerSeconds ?? null,
      discardedRunnerSeconds(state),
      0,
      // Only a full check adds the seventh slot, so other samples keep their shape and bytes.
      ...(state.counts?.runnerFull ? [state.counts.runnerSeconds ?? null] : []),
    ] as LandingCounts,
    stages: {
      queue: span(timing.submittedAt, timing.checkReservedAt),
      check: span(timing.checkReservedAt, timing.ciEndedAt),
      settle: span(timing.ciEndedAt, timing.committedAt),
    },
  };
}

const round = (value: number) => Math.round(value * 10) / 10;
const STAGE_LABEL = { queue: 'queue and compose', check: 'check', settle: 'settle after the check' } as const;
/** The area to look at first: the longest stage of the landing that crossed. */
export function longestStage(stages: LandingSpeedSample['stages']) {
  const known = (Object.entries(stages) as [keyof typeof STAGE_LABEL, number | null][]).filter(
    (entry): entry is [keyof typeof STAGE_LABEL, number] => entry[1] !== null,
  );
  const top = known.sort((a, b) => b[1] - a[1])[0];
  return top ? `${STAGE_LABEL[top[0]]} (${top[1]} min)` : undefined;
}

/** The statistic over the last `window` landings that know the metric; null until a full window exists. */
export function windowValue(
  samples: LandingSpeedState['samples'],
  metric: LandingMetric,
  stat: Stat,
  window: number,
) {
  const index = INDEX[metric],
    count = COUNT[metric];
  const values = samples
    .flatMap(row => {
      // Price the two stamps together: a missing class never becomes free usage.
      if (metric === 'r2RequestUsd') {
        const a = row[7]?.[0],
          b = row[7]?.[1];
        return a == null || b == null ? [] : [(a * 4.5 + b * 0.36) / 1e6];
      }
      const value: number | null | undefined = count ? row[7]?.[count[0]] : (row[index!] as number | null);
      return value == null ? [] : [value / (count?.[1] ?? 1)];
    })
    .slice(-window);
  if (values.length < window) return null;
  const value =
    stat === 'mean'
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : percentile(values, stat === 'p50' ? 0.5 : 0.9)!;
  // Dollar fractions must survive judgment and reporting; other metrics keep their precision.
  return metric === 'r2RequestUsd' ? Math.round(value * 1e12) / 1e12 : round(value);
}

/** Pure: append one landing and report each budget it breaks or recovers. A budget alerts once when
 * it breaks and once when it recovers; while it stays broken nothing repeats. */
export function observeLandingSpeed(
  previous: LandingSpeedState | null,
  sample: LandingSpeedSample,
  budgets: SpeedBudgets,
): { state: LandingSpeedState; events: SpeedBudgetEvent[] } {
  const samples = [
    ...(previous?.samples ?? []),
    [
      sample.at,
      sample.toMain,
      sample.check,
      sample.id,
      sample.settle,
      sample.attempts ?? null,
      sample.writes ?? null,
      sample.counts ?? null,
      ...(sample.passToLand != null
        ? [sample.saveMs ?? null, sample.preflightMs ?? null, sample.passToLand]
        : sample.saveMs == null && sample.preflightMs == null
          ? []
          : [sample.saveMs ?? null, sample.preflightMs ?? null]),
    ] as const,
  ]
    .sort((a, b) => a[0] - b[0])
    .slice(-MAX_SAMPLES)
    .map(
      ([at, toMain, check, id, settle, attempts, writes, counts, ...durations]) =>
        [
          at,
          toMain,
          check,
          id,
          settle ?? null,
          attempts ?? null,
          writes ?? null,
          counts ?? null,
          ...durations,
        ] as Row,
    );
  const judged = landingBudgets(budgets);
  const ids = new Set(judged.map(b => b.id));
  const keep = <T>(record?: Record<string, T>) =>
    Object.fromEntries(Object.entries(record ?? {}).filter(([id]) => ids.has(id)));
  const broken = keep(previous?.broken),
    ratchet = keep(previous?.ratchet),
    short = keep(previous?.short);
  const events: SpeedBudgetEvent[] = [];
  const since = new Date(sample.at).toISOString();
  for (const budget of judged) {
    // Day budgets are judged by the Stats day close (judgeClosedDay below), never per landing.
    if (budget.stat === 'day') continue;
    const value = windowValue(samples, budget.metric, budget.stat, budgets.window.landings);
    if (value === null) {
      // Runner minutes per full check skip batch members and scoped rechecks by design, so a full row
      // can hold too few to judge: it says so once (F5), never silence. Other budgets report missing
      // stamps as `unknown` on their own events. A stamp among the oldest quarter of the full row shows
      // stamps span the whole row, so a row written before the stamp existed never reads as short.
      const has = (row: Row) => windowValue([row], budget.metric, budget.stat, 1) !== null;
      const stamped = samples.filter(has).length;
      if (
        budget.metric === 'runnerFull' &&
        samples.length === MAX_SAMPLES &&
        samples.slice(0, MAX_SAMPLES / 4).some(has) &&
        !short[budget.id]
      ) {
        short[budget.id] = since;
        events.push({
          kind: 'short',
          budget,
          value: stamped,
          line: budget.max,
          stamped,
          retained: samples.length,
          landing: sample.id,
          since,
        });
      }
      continue;
    }
    delete short[budget.id];
    // A scoped check is not missing a full-check stamp; only an unknown runner count is.
    const unknown = samples
      .slice(-budgets.window.landings)
      .filter(row =>
        budget.metric === 'runnerFull'
          ? row[7]?.[3] == null
          : windowValue([row], budget.metric, budget.stat, 1) === null,
      ).length;
    // Speed budgets (percentiles) ratchet here; cost means keep the cost ledger's own ratchet.
    const tightenedAt = Date.parse(ratchet[budget.id]?.at ?? '');
    const step =
      budget.stat === 'mean'
        ? null
        : stepRatchet(
            ratchet[budget.id],
            value,
            budget.max,
            sample.at,
            sample.id,
            budget.ratchet === false,
            Number.isFinite(tightenedAt) ? samples.filter(row => row[0] > tightenedAt).length : 0,
          );
    const line = step?.line ?? budget.max;
    if (step) ratchet[budget.id] = step.entry;
    const change = step?.ratcheted ?? step?.undone;
    if (change)
      events.push({
        kind: step?.ratcheted ? 'ratcheted' : 'undone',
        budget,
        value,
        line: change.to,
        from: change.from,
        reason: change.reason,
        landing: sample.id,
        since,
        ...(step?.undone ? { flow: { landed: step.undone.landed, changed: step.undone.changed } } : {}),
      });
    const open = broken[budget.id];
    if (value > line && !open) {
      const stage = longestStage(sample.stages);
      broken[budget.id] = { since, landing: sample.id, value, ...(stage ? { stage } : {}) };
      events.push({
        kind: 'broken',
        budget,
        value,
        line,
        landing: sample.id,
        since,
        ...(stage ? { stage } : {}),
        ...(unknown ? { unknown } : {}),
      });
    } else if (value <= line && open) {
      delete broken[budget.id];
      events.push({
        kind: 'recovered',
        budget,
        value,
        line,
        landing: open.landing,
        since: open.since,
        ...(unknown ? { unknown } : {}),
      });
    }
  }
  // Name the landing behind a whole-check shift (wholeCheckShift above), once per shift.
  const runnerFull = judged.find(b => b.metric === 'runnerFull');
  let shift = previous?.shift;
  const found = runnerFull ? wholeCheckShift(samples, shift) : null;
  if (runnerFull && found) {
    // The split's reservation time and its last landing (8 characters): about 35 bytes, kept after a shift only.
    shift = [found.reservedAt, found.landings.at(-1)!.slice(0, 8)];
    events.push({
      kind: 'shift',
      budget: runnerFull,
      value: found.after,
      line: found.before,
      landing: found.landings.at(-1)!,
      since,
      shift: found,
    });
  }
  return {
    state: {
      schema: 2,
      samples,
      broken,
      ...(Object.keys(ratchet).length ? { ratchet } : {}),
      ...(Object.keys(short).length ? { short } : {}),
      ...(shift ? { shift } : {}),
    },
    events,
  };
}

/** What a day budget keeps between closed days, on the Stats day row (src/stats-estimate.ts): its open
 * break, ratchet and not-enough-data note, as the landing row keeps them for window budgets, and the
 * landings judged since its line last tightened (the undo's flow record). */
export const dayBudgetStateSchema = landingSpeedStateSchema
  .pick({ broken: true, ratchet: true, short: true })
  .extend({ landed: z.record(z.string(), z.number().int().nonnegative()).optional() })
  .partial()
  .strict();
export type DayBudgetState = z.infer<typeof dayBudgetStateSchema>;
/** One closed UTC day, as the Stats day close counts it from the receipts and landing rows it already
 * reads: known discarded runner seconds, landings with an unknown stamp, landings, and the landing with
 * the most discarded seconds. */
export type ClosedDay = {
  day: string;
  seconds: number;
  unknown: number;
  landings: number;
  top: string | null;
};
/** One closed day from the Stats close's landings (src/stats-estimate.ts StatsLanding): known discarded
 * runner seconds, landings whose discarded time is not known yet (usage still pending, or `unread`: past the
 * close's read cap), and the landing that discarded the most (first 8 characters of its receipt id). */
export function closedDay(
  day: string,
  landings: ReadonlyArray<{ id: string; discardedRunnerSeconds: number | null }>,
  unread = 0,
): ClosedDay {
  let seconds = 0,
    unknown = unread,
    top: { id: string; discardedRunnerSeconds: number | null } | null = null;
  for (const landing of landings) {
    const discarded = landing.discardedRunnerSeconds;
    if (discarded === null) unknown++;
    else {
      seconds += discarded;
      if (discarded > (top?.discardedRunnerSeconds ?? 0)) top = landing;
    }
  }
  return { day, seconds, unknown, landings: landings.length + unread, top: top ? top.id.slice(0, 8) : null };
}
/** Pure: judge the day budgets (stat `day`) on one closed day: the same break, recovery, P0 Issue, F1
 * ratchet (one closed day per step) and not-enough-data note as a window budget. A day where more than
 * half the landings have an unknown stamp cannot be compared with a line set from whole days: it says so
 * once and is not judged. Daily waste tripwire (Item a217b83e, lead 20b27f1d). */
export function judgeClosedDay(
  previous: DayBudgetState | undefined,
  closed: ClosedDay,
  budgets: SpeedBudgets,
) {
  const judged = landingBudgets(budgets).filter(b => b.stat === 'day');
  const ids = new Set(judged.map(b => b.id));
  const keep = <T>(record?: Record<string, T>) =>
    Object.fromEntries(Object.entries(record ?? {}).filter(([id]) => ids.has(id)));
  const broken = keep(previous?.broken),
    ratchet = keep(previous?.ratchet),
    short = keep(previous?.short),
    landed = keep(previous?.landed);
  const events: SpeedBudgetEvent[] = [];
  const value = round(closed.seconds / 60),
    since = `${closed.day}T23:59:59.999Z`;
  for (const budget of judged) {
    const landing = closed.top ?? closed.day,
      common = {
        budget,
        landing,
        since,
        day: closed.day,
        landings: closed.landings,
        ...(closed.unknown ? { unknown: closed.unknown } : {}),
      };
    if (closed.unknown * 2 > closed.landings || !closed.landings) {
      if (!short[budget.id]) {
        short[budget.id] = since;
        const stamped = closed.landings - closed.unknown;
        events.push({
          ...common,
          kind: 'short',
          value: stamped,
          line: budget.max,
          stamped,
          retained: closed.landings,
        });
      }
      continue;
    }
    delete short[budget.id];
    const step = stepRatchet(
      ratchet[budget.id],
      value,
      budget.max,
      Date.parse(`${closed.day}T12:00:00.000Z`),
      landing,
      budget.ratchet === false,
      (landed[budget.id] ?? 0) + closed.landings,
      true,
    );
    ratchet[budget.id] = step.entry;
    // Landings judged since the line last tightened; a tighten or an undo restarts the count.
    if (step.ratcheted || step.undone || step.entry.line === undefined) delete landed[budget.id];
    else landed[budget.id] = (landed[budget.id] ?? 0) + closed.landings;
    const change = step.ratcheted ?? step.undone;
    if (change)
      events.push({
        ...common,
        kind: step.ratcheted ? 'ratcheted' : 'undone',
        value,
        line: change.to,
        from: change.from,
        reason: change.reason,
        ...(step.undone ? { flow: { landed: step.undone.landed, changed: step.undone.changed } } : {}),
      });
    const open = broken[budget.id];
    if (value > step.line && !open) {
      broken[budget.id] = { since, landing, value };
      events.push({ ...common, kind: 'broken', value, line: step.line });
    } else if (value <= step.line && open) {
      delete broken[budget.id];
      events.push({
        ...common,
        kind: 'recovered',
        value,
        line: step.line,
        landing: open.landing,
        since: open.since,
      });
    }
  }
  const state: DayBudgetState = {
    ...(Object.keys(broken).length ? { broken } : {}),
    ...(Object.keys(ratchet).length ? { ratchet } : {}),
    ...(Object.keys(short).length ? { short } : {}),
    ...(Object.keys(landed).length ? { landed } : {}),
  };
  return { state, events };
}
type Row = [
  number,
  number | null,
  number | null,
  string,
  number | null,
  number | null,
  number | null,
  LandingCounts | null,
  (number | null)?,
  (number | null)?,
  (number | null)?,
];

const R2_NEXT =
  "Next: R2 requests signed by the landing's composes rose: compare `forge-source-step` log lines of the crossing landing " +
  '(objects, bytes per step) and the latest change to the source steps (convex/projectConvexSource*, src/hosted-source-step*); ' +
  'the landing check cost guard counts the same requests on a fixture.';
const NAME: Record<LandingMetric, string> = {
  toMain: 'landing to main',
  saveMs: 'save',
  preflightMs: 'preflight',
  check: 'check',
  settle: 'check result to commit',
  passToLand: 'first passed check to commit',
  attempts: 'attempts per landing',
  writes: 'landing-state writes per landing',
  r2ClassA: 'R2 class A requests per landing',
  r2ClassB: 'R2 class B requests per landing',
  r2RequestUsd: 'R2 request dollars per landing',
  r2BytesPut: 'R2 bytes put per landing',
  runnerAccepted: 'runner minutes of the accepted check per landing',
  runnerDiscarded: 'runner minutes of discarded checks per landing',
  runnerAudit: 'runner minutes of main audits per landing',
  runnerFull: 'runner minutes per full check',
  wasteDaily: 'cancelled or discarded runner minutes per UTC day',
};
const describe = (b: SpeedBudget) =>
  b.stat === 'day' ? NAME[b.metric as LandingMetric] : `${NAME[b.metric as LandingMetric]} ${b.stat}`;
const NEXT: Record<LandingMetric, string> = {
  saveMs:
    'Next: compare the crossing landing save receipt durationMs and its CLI capture, upload and server step timings; inspect the latest save path change.',
  preflightMs:
    'Next: compare the crossing landing preflight receipt durationMs, buildMs, testMs and slowest files; inspect the latest preflight selection or runner change.',
  toMain:
    'Next: run `nforge metrics ROOT --text` for waste by cause and main-race re-checks; ' +
    'if queue or compose gaps grew, run the landing-loop dry micro-bench (regression ladder rung 2) on the latest landing-loop change.',
  settle:
    'Next: read the landing supervisor path (settle step, finish wake, order waits) on the crossing landing with ' +
    '`nforge agent ROOT landings` (heldAfterCheck) and compare with the latest change to convex/projectHostedLanding* ' +
    'or the acceptance publish; the gap was 300 s before fix caa934a7 and about 8.5 s after.',
  passToLand:
    'Queue health alarm: pause new landings until pass-to-land recovers, and fix the queue first; ' +
    'let landings already checking finish (withdrawing them only loses their checks). ' +
    'Next: run `nforge agent ROOT queue` for ready entries and what each waits on (orderWait), and ' +
    '`nforge agent ROOT landings` for the window (heldAfterCheck, orderWaits, recomposeCount); compare with the latest change ' +
    'to queue, wake or acceptance paths and the queue incident replays (tests/hosted-landing-queue-sim.test.mjs; incident 5e3c3a3c).',
  attempts:
    'Next: run `nforge agent ROOT landings` for the window and look at recomposeCount and checkRunIds; ' +
    'more attempts per landing means recompose or re-check loops (incident 10d253c6), each a compose and a check.',
  writes:
    'Next: compare the landing-state writes of the crossing landing with its attempts; writes rising with flat ' +
    'attempts means the landing path writes its state more often per step: read the latest change to ' +
    'convex/projectHostedLanding* (the landing check cost guard counts the same path on a fixture).',
  check:
    'Next: run `nforge metrics ROOT --text` for check minutes and flaky files; ' +
    'compare the slowest test files with the previous week and the latest change to the verify script or check runner.',
  r2ClassA: R2_NEXT,
  r2ClassB: R2_NEXT,
  r2RequestUsd: R2_NEXT,
  r2BytesPut: R2_NEXT,
  runnerAccepted:
    'Next: shard execution seconds of the accepted check rose: run `nforge agent ROOT status {"runId":"RUN","summary":true}` ' +
    'on the crossing landing (timings.executionSeconds, shards, slowest files) and compare with the latest change to the test set or the shard plan. ' +
    'These are shard test seconds from the run row; a private repository pays about $0.008 per GitHub runner minute.',
  runnerDiscarded:
    'Next: runs its attempts threw away rose: read `nforge agent ROOT landings` for the window (checkRunIds, recomposeCount); ' +
    'each main race that cannot reuse its check costs a whole run (incident 10d253c6).',
  runnerAudit:
    'Next: audits ran longer or more often: read the main audit state (`nforge agent ROOT status`, audit) and the audit cadence setting.',
  runnerFull:
    "Next: full checks burn more runner minutes: read the `checkTime` line of the window's receipts (`nforge agent ROOT landings`), which names " +
    'a landing whose new test files added seconds to every check (whole and contract-selected runs; edited files are never named), ' +
    'then compare `status {"runId":"RUN","summary":true}` slowest files and executionSeconds on a full check before and after the crossing landing. ' +
    'A shift on every file points at the check runner or executor, which shows first on checks reserved after its landing: ' +
    'Forge names that landing in a separate "Full checks slower since landing" message. ' +
    'Parallel shards hide this from check wall time (Issue d5de1c98: coverage collection on every shard).',
  wasteDaily:
    'Next: read `nforge metrics ROOT --text` for waste by cause on that day (main-race rechecks, cancels, supersedes) and ' +
    '`nforge agent ROOT landings` for the named landing (checkRunIds, recomposeCount, heldAfterCheck). Runs thrown away when main ' +
    'moved are the usual cause (incident 5e3c3a3c on 2026-11-17: 6,613 minutes); a cancel loop or a stalled queue is the other. ' +
    'Counts accepted landings only, as the Stats day close does.',
};
const lastLandings = (budgets: SpeedBudgets) => `the last ${budgets.window.landings} landings`;

/** The owner-facing message: which budget, which landing crossed it, where to look, the next step. */
export function speedBudgetMessage(event: SpeedBudgetEvent, project: string, budgets: SpeedBudgets) {
  const b = event.budget;
  const line = event.line ?? b.max;
  const over = event.day
    ? `on UTC day ${event.day} (${event.landings ?? 0} landings) was`
    : `over ${lastLandings(budgets)} is`;
  const head =
    `${describe(b)} ${over} ${event.value} ${b.unit}; budget ${line} ${b.unit}` +
    (line < (b.max ?? line) ? ` (ratcheted from ${b.max})` : '') +
    '.' +
    (event.unknown
      ? event.day
        ? ` ${event.unknown} of that day's landings have an unknown ${b.metric} stamp; excluded, never counted as zero.`
        : ` ${event.unknown} of the newest ${budgets.window.landings} landings have an unknown ${b.metric} stamp; excluded, never counted as zero.`
      : '');
  if (event.kind === 'ratcheted')
    return {
      subject: `[Forge] Speed budget tightened: ${describe(b)}: ${project}`,
      text: `Speed budget ${b.id} ratcheted on ${project}: ${event.from} -> ${event.line} ${b.unit} at landing ${event.landing.slice(0, 8)}. ${event.reason} A window over it but at or under the file max ${b.max} undoes it (a message, not a P0). To opt out, pin the budget to its file max with "ratchet": false in src/speed-budgets.json.`,
    };
  if (event.kind === 'undone')
    return {
      subject: `[Forge] Speed budget ratchet undone: ${describe(b)}: ${project}`,
      text: `Speed budget ${b.id} ratchet undone on ${project} at landing ${event.landing.slice(0, 8)}: ${event.reason} Still within the file max ${b.max} ${b.unit}, so no P0 Issue; the hold restarts.`,
    };
  if (event.kind === 'shift' && event.shift) {
    const sh = event.shift,
      slower = sh.after > sh.before,
      ids = sh.landings.map(id => id.slice(0, 8)),
      shown = ids.slice(0, 10).join(', ') + (ids.length > 10 ? ` and ${ids.length - 10} more` : '');
    return {
      subject: `[Forge] Full checks ${slower ? 'slower' : 'faster'} since landing ${ids.length === 1 ? ids[0] : `${ids[0]}..${ids.at(-1)}`}: ${project}`,
      text:
        `Runner minutes per full check went from ${sh.before} to ${sh.after} min on ${project} (median of ${sh.checks.before} full checks reserved before, ` +
        `${sh.checks.after} after), beyond the noise band (ln ${sh.band}), and every check after it moved the same way. ` +
        `The check runner runs from main, so the change landed before the first slower check was reserved, never in the landing whose own check saw it: ` +
        (ids.length === 1
          ? `landing ${ids[0]}.`
          : `one of the ${ids.length} landings committed between the last full check before and the first after, oldest first: ${shown}.`) +
        ' ' +
        (slower
          ? `It adds about ${round(sh.after - sh.before)} runner minutes to every full check. Next: read their changes to the check runner, executor, test setup or shard plan, and compare \`status {"runId":"RUN","summary":true}\` on a full check before and after. `
          : 'Credit, not a fault: nothing to do. ') +
        `Budget ${b.id} (file max ${b.max} ${b.unit}) judges the window; this message names the cause once per shift and opens no Issue.`,
    };
  }
  if (event.kind === 'short' && event.day)
    return {
      subject: `[Forge] Speed budget has too little data: ${describe(b)}: ${project}`,
      text:
        `Speed budget ${b.id} cannot judge UTC day ${event.day} on ${project}: ${event.unknown ?? 0} of its ${event.landings ?? 0} landings have an unknown ${b.metric} stamp (cancelled usage not reported yet, or written before the stamp). ` +
        'Not enough data: a day missing more than half its landings cannot be compared with its line, so that day neither breaks nor recovers it. ' +
        'This message does not repeat until a day has been judged again.',
    };
  if (event.kind === 'short')
    return {
      subject: `[Forge] Speed budget has too little data: ${describe(b)}: ${project}`,
      text:
        `Speed budget ${b.id} cannot be judged on ${project}: only ${event.stamped} of the ${event.retained} retained landings carry its ${b.metric} stamp` +
        (b.metric === 'runnerFull' ? ' (full checks; batch members and scoped rechecks do not count)' : '') +
        `, and its window needs ${budgets.window.landings}. Not enough data: it cannot break or recover until ${budgets.window.landings} do. ` +
        'This message does not repeat until the budget has been judged again.',
    };
  return event.kind === 'broken'
    ? {
        subject: `[Forge] Speed budget broken: ${describe(b)}: ${project}`,
        text: [
          `Speed budget ${b.id} broke on ${project}: ${head}`,
          event.day
            ? `Most of that day's waste came from landing ${event.landing.slice(0, 8)} (${b.area}).`
            : `Crossed by landing ${event.landing.slice(0, 8)} (${b.area})${event.stage ? `; its longest stage was ${event.stage}` : ''}.`,
          `Budget source: ${b.source}`,
          NEXT[b.metric as LandingMetric],
          'One P0 Issue tracks this budget; this alert does not repeat while it stays broken, and a recovery message follows.',
        ].join('\n'),
      }
    : {
        subject: `[Forge] Speed budget recovered: ${describe(b)}: ${project}`,
        text: `Speed budget ${b.id} is back within budget on ${project}: ${head} It had been broken since ${event.since} (landing ${event.landing.slice(0, 8)}).`,
      };
}

const uuid = (seed: string) => {
  const hex = digest(seed).slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '8';
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20, 32).join('')}`;
};
export const speedBudgetIssueSchema = z
  .object({
    itemId: z.uuid(),
    putOperationId: z.uuid(),
    commentOperationId: z.uuid(),
    title: z.string(),
    body: z.string(),
    comment: z.string(),
    reopen: z.boolean(),
  })
  .strict();
/** One P0 Issue per budget, found again by its fixed id: a repeat break reopens it, never duplicates it.
 * Operation ids name the transition, so a retried write reconciles. */
export function speedBudgetIssue(event: SpeedBudgetEvent, projectId: string, budgets: SpeedBudgets) {
  const b = event.budget;
  const operation = (what: string) =>
    uuid(`speed-budget:${projectId}:${b.id}:${event.kind}:${event.landing}:${what}`);
  return speedBudgetIssueSchema.parse({
    itemId: uuid(`speed-budget:${projectId}:${b.id}`),
    putOperationId: operation('put'),
    commentOperationId: operation('comment'),
    title: `P0 speed budget broken: ${describe(b)} (${b.area})`,
    body: [
      `Opened by Forge. Budget \`${b.id}\`: ${describe(b)} ${b.stat === 'day' ? 'on each closed UTC day' : `over ${lastLandings(budgets)}`} must stay at or under ${event.line ?? b.max} ${b.unit}${(event.line ?? b.max) < (b.max ?? event.line) ? ` (ratcheted from ${b.max})` : ''}.`,
      '',
      event.day
        ? `Crossed on UTC day ${event.day}; most of its waste came from landing \`${event.landing}\`. Area: ${b.area}.`
        : `Crossed by landing \`${event.landing}\` at ${event.since}. Area: ${b.area}.`,
      `Budget source: ${b.source}`,
      `Reason: ${b.reason}`,
      ...(b.issue ? [`Decision it protects: Issue ${b.issue}.`] : []),
      '',
      'Fix the cause, not the budget. Forge comments here when the budget recovers; close the Issue once the fix is verified.',
    ].join('\n'),
    comment: speedBudgetMessage(event, 'this project', budgets).text,
    reopen: event.kind === 'broken',
  });
}

type Counts = LandingSpeedState['samples'][number][7];
/** What a new attempt carries over from the one before it (Issue 3e3f9fe6): the R2 requests of every
 * compose so far, and the shard execution seconds of runs it discards. An attempt that reuses the
 * earlier check keeps that run as its own evidence, so those seconds are not discarded. */
export function carriedCostCounts(
  counts: HostedLandingState['counts'],
  composed: readonly [number, number, number] | undefined,
  reused: boolean,
  keepKnownDiscardZero = false,
): HostedLandingState['counts'] {
  const so = counts?.r2 ?? [0, 0, 0],
    added = composed ?? [0, 0, 0],
    r2 = so.map((n, i) => n + added[i]!) as [number, number, number],
    discarded = (counts?.discardedRunnerSeconds ?? 0) + (reused ? 0 : (counts?.runnerSeconds ?? 0));
  const carried = {
    ...(r2.some(Boolean) ? { r2 } : {}),
    ...(reused && counts?.runnerSeconds !== undefined
      ? { runnerSeconds: counts.runnerSeconds, ...(counts.runnerFull ? { runnerFull: true as const } : {}) }
      : {}),
    ...(discarded > 0 || (keepKnownDiscardZero && counts?.discardedRunnerSeconds === 0)
      ? { discardedRunnerSeconds: discarded }
      : {}),
    ...(counts?.discardedRunnerUnknown ? { discardedRunnerUnknown: counts.discardedRunnerUnknown } : {}),
  };
  return Object.keys(carried).length ? carried : undefined;
}
/** The main audit's runner seconds join the newest landing's sample (the landing it followed), once. */
export function addAuditSeconds(state: LandingSpeedState, seconds: number): LandingSpeedState {
  const last = state.samples.at(-1);
  if (!last || !(seconds > 0)) return state;
  const counts: NonNullable<Counts> = [
    ...(last[7] ?? [null, null, null, null, null, 0]),
  ] as NonNullable<Counts>;
  counts[5] = (counts[5] ?? 0) + seconds;
  const [at, toMain, check, id, settle, attempts, writes, , ...durations] = last;
  return {
    ...state,
    samples: [
      ...state.samples.slice(0, -1),
      [at, toMain, check, id, settle, attempts, writes, counts, ...durations],
    ],
  };
}
