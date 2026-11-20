// SPDX-License-Identifier: Apache-2.0
/**
 * The Flow view's running day (Item 85f456c1): a few small counts in the line feed's per-project summary row
 * (convex/projectLiveLineStore.ts), stepped only by writes that already rewrite that row or a line mark. No
 * read, timer or per-second feed: the browser and the agent's `flow` text work out "today" and elapsed times
 * from these hour buckets and timestamps when they show them. Pure and read-free.
 */

export const HOUR_MS = 3_600_000;
/** Hours kept: one rolling day, so "today" in any time zone is inside it. */
export const FLOW_HOURS = 24;
/** Land-to-main samples kept, newest last. Enough for a middle and a 9-in-10 of the recent landings. */
export const FLOW_TOOK = 48;

/** One hour of the project's day: [hour (ms / HOUR_MS), landed, needs fix, reverted, fixed on top, CI seconds,
 * CI seconds on checks that did not land]. A tuple, because the summary rides on every line read. */
export type FlowHour = [number, number, number, number, number, number, number];
export type FlowDay = {
  hours: FlowHour[];
  /** [hour, seconds from submission to main] per landing, newest last. */
  took: Array<[number, number]>;
  /** main's audit verdict as the line last heard it: failing or passing, and since when (ms). */
  main?: { red: boolean; since: number };
  /** [hour, first-try landings, landings judged] (Item 32e8de50): a landing is judged when its landing write
   * knows whether it was a first try (docs/concepts.md#first-try). Hours before this field have none, so the share
   * covers only the landings judged, never counts an unjudged one as a first try. */
  first?: Array<[number, number, number]>;
};
export type FlowStep = Partial<{
  landed: number;
  fix: number;
  reverted: number;
  fixedOnTop: number;
  ciSeconds: number;
  lostSeconds: number;
  /** Seconds from submission to main of one landing. */
  took: number;
  /** A landing (with `landed`) that was a first try (true) or not (false). */
  first: boolean;
}>;

const hourOf = (at: number) => Math.floor(at / HOUR_MS);
const numbers = (row: unknown, length: number) =>
  Array.isArray(row) && row.length === length && row.every(n => Number.isFinite(n));
const empty = (): FlowDay => ({ hours: [], took: [] });

/** A stored value that is missing or from another shape reads as an empty day, never a failure. */
export function flowDay(value: unknown): FlowDay {
  const day = value as Partial<FlowDay> | null | undefined;
  if (!day || !Array.isArray(day.hours) || !Array.isArray(day.took)) return empty();
  return {
    hours: day.hours.filter(row => numbers(row, 7)) as FlowHour[],
    took: day.took.filter(row => numbers(row, 2)) as Array<[number, number]>,
    ...(day.main && typeof day.main.since === 'number'
      ? { main: { red: !!day.main.red, since: day.main.since } }
      : {}),
    ...(Array.isArray(day.first)
      ? { first: day.first.filter(row => numbers(row, 3)) as Array<[number, number, number]> }
      : {}),
  };
}

/** The day after one event at `at` (ms): its counts added to that hour; hours and samples older than a day go. */
export function stepFlow(value: unknown, at: number, step: FlowStep): FlowDay {
  const day = flowDay(value);
  const hour = hourOf(at);
  const keep = hour - FLOW_HOURS;
  const hours = day.hours.filter(row => row[0] > keep).map(row => [...row] as FlowHour);
  let row = hours.find(entry => entry[0] === hour);
  if (!row) {
    row = [hour, 0, 0, 0, 0, 0, 0];
    hours.push(row);
    hours.sort((a, b) => a[0] - b[0]);
  }
  const add = (index: number, n: number | undefined) => {
    if (n && Number.isFinite(n) && n > 0) row![index] = row![index]! + (index >= 5 ? Math.round(n) : n);
  };
  add(1, step.landed);
  add(2, step.fix);
  add(3, step.reverted);
  add(4, step.fixedOnTop);
  add(5, step.ciSeconds);
  add(6, step.lostSeconds);
  const took = day.took.filter(sample => sample[0] > keep);
  if (step.took !== undefined && Number.isFinite(step.took) && step.took >= 0)
    took.push([hour, Math.round(step.took)]);
  const first = (day.first ?? [])
    .filter(row => row[0] > keep)
    .map(row => [...row] as [number, number, number]);
  if (step.landed && step.first !== undefined) {
    let tries = first.find(entry => entry[0] === hour);
    if (!tries) first.push((tries = [hour, 0, 0]));
    if (step.first) tries[1]++;
    tries[2]++;
  }
  return {
    hours: hours.filter(entry => entry.slice(1).some(n => n > 0)),
    took: took.slice(-FLOW_TOOK),
    ...(day.main ? { main: day.main } : {}),
    ...(first.length ? { first: first.sort((a, b) => a[0] - b[0]) } : {}),
  };
}

/** main's verdict changed: record it with its time. The same verdict again keeps its first time. */
export function flowMain(value: unknown, red: boolean, at: number): FlowDay {
  const day = flowDay(value);
  if (day.main && day.main.red === red) return day;
  return { ...day, main: { red, since: at } };
}

/** The value at a rank (0 to 1) of sorted numbers, nearest rank. */
const rank = (sorted: readonly number[], q: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]! : null;

export type FlowToday = {
  /** Landings per hour from the day's start to now, oldest first; the last is this hour. */
  byHour: number[];
  landed: number;
  thisHour: number;
  /** Seconds from submission to main: the middle and 9 in 10 of today's samples, null with none. */
  middle: number | null;
  nineInTen: number | null;
  samples: number;
  fix: number;
  reverted: number;
  fixedOnTop: number;
  ciMinutes: number;
  lostMinutes: number;
  /** First-try landings of the landings judged today, and their share (0 to 1); null with none judged. */
  firstTry: number;
  judged: number;
  firstTryShare: number | null;
};

/** Today's figures from `dayStart` (the reader's local midnight, ms) to `now`. */
export function flowToday(value: unknown, now: number, dayStart: number): FlowToday {
  const day = flowDay(value);
  const first = hourOf(dayStart),
    last = hourOf(now);
  const span = Math.max(1, Math.min(FLOW_HOURS, last - first + 1));
  const from = last - span + 1;
  const byHour = Array.from({ length: span }, () => 0);
  const sum = [0, 0, 0, 0, 0, 0, 0];
  for (const row of day.hours) {
    if (row[0] < from || row[0] > last) continue;
    byHour[row[0] - from] = row[1];
    for (let i = 1; i < 7; i++) sum[i] = sum[i]! + row[i]!;
  }
  let firstTry = 0,
    judged = 0;
  for (const [hour, ok, of] of day.first ?? [])
    if (hour >= from && hour <= last) {
      firstTry += ok;
      judged += of;
    }
  const took = day.took
    .filter(([hour]) => hour >= from && hour <= last)
    .map(([, seconds]) => seconds)
    .sort((a, b) => a - b);
  return {
    byHour,
    landed: sum[1]!,
    thisHour: byHour.at(-1) ?? 0,
    middle: rank(took, 0.5),
    nineInTen: rank(took, 0.9),
    samples: took.length,
    fix: sum[2]!,
    reverted: sum[3]!,
    fixedOnTop: sum[4]!,
    ciMinutes: Math.round(sum[5]! / 60),
    lostMinutes: Math.round(sum[6]! / 60),
    firstTry,
    judged,
    firstTryShare: judged ? firstTry / judged : null,
  };
}

/** The project day is the UTC day, as on Stats: its start (ms) for a time. */
export const utcDayStart = (now: number) => Math.floor(now / 86_400_000) * 86_400_000;

/** The top bar's main figure and the one agents read (Item 32e8de50): landings on main today (the UTC project day)
 * and the share of today's judged landings that were a first try. One source: the line feed's Flow day. */
export type MainToday = { landed: number; firstTry: number; judged: number; share: number | null };
export function mainToday(value: unknown, now: number): MainToday & { words: string } {
  const today = flowToday(value, now, utcDayStart(now));
  const figure = {
    landed: today.landed,
    firstTry: today.firstTry,
    judged: today.judged,
    share: today.firstTryShare,
  };
  return { ...figure, words: mainTodayWords(figure) };
}

/** Whole percent, never rounded up to 100 % or down to 0 % unless every or no judged landing was a first try. */
export function firstTryPercent(today: Pick<MainToday, 'firstTry' | 'judged'>): number | null {
  if (!today.judged) return null;
  if (today.firstTry === today.judged) return 100;
  if (!today.firstTry) return 0;
  return Math.min(99, Math.max(1, Math.round((today.firstTry / today.judged) * 100)));
}
/** "N today · X% first try", or "N today" when no landing today was judged. */
export function mainTodayWords(today: MainToday): string {
  const n = today.landed.toLocaleString('en-US');
  const pct = firstTryPercent(today);
  return pct === null ? `${n} today` : `${n} today · ${pct}% first try`;
}
