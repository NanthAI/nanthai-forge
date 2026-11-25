// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** A public project's "time to main" (Item 8947a779): the median save-to-main time of this week's landings.
 * Each landing already writes the main summary's seven day buckets; a bucket also keeps a small fixed histogram of
 * its timed landings' whole-second times, so the week's median is the merge of the days in the window: it covers
 * every timed landing, is exact to the bucket width, and needs no extra read, write or timer.
 * Pure: no clock, no I/O. */

/** Upper bounds (whole seconds, exclusive) of every bucket but the last, which is open: <10 s, 10-19 s, 20-39 s,
 * ... doubling to 10,240 s (about 2.8 hours) and above. Twelve counters per day. */
export const TIME_EDGES = [10, 20, 40, 80, 160, 320, 640, 1280, 2560, 5120, 10240] as const;
export const TIME_BINS = TIME_EDGES.length + 1;

/** `hist` is absent until a timed landing is recorded that day; untimed landings never enter it. */
export type WeekDay = { day: number; count: number; hist?: number[] };

const stamp = (iso: string | undefined) => (iso === undefined ? NaN : Date.parse(iso));

/** One landing's save-to-main time in whole seconds: from the submission to the receipt, measured as the Lane page
 * and Stats measure it (`landingStops`). null when the landing row has no usable submission time. */
export function landingToMainSeconds(
  receiptAt: string,
  state: { at?: string; timing?: { submittedAt?: string; committedAt?: string } } | null | undefined,
): number | null {
  const submitted = stamp(state?.timing?.submittedAt) || stamp(state?.at);
  const landed = stamp(state?.timing?.committedAt) || stamp(receiptAt);
  if (!Number.isFinite(submitted) || !Number.isFinite(landed) || landed < submitted) return null;
  return Math.round((landed - submitted) / 1000);
}

const binOf = (seconds: number) => {
  let bin = 0;
  while (bin < TIME_EDGES.length && seconds >= TIME_EDGES[bin]!) bin++;
  return bin;
};

/** Count `landings` into the day's bucket and add each timed landing to its histogram (null leaves a landing
 * untimed). */
export function recordDay(
  days: WeekDay[],
  day: number,
  landings: number,
  times: readonly (number | null)[] = [],
) {
  let bucket = days.find(row => row.day === day);
  if (!bucket) days.push((bucket = { day, count: 0 }));
  for (const time of times) {
    if (time !== null && Number.isSafeInteger(time) && time >= 0) {
      const hist = (bucket.hist ??= Array.from({ length: TIME_BINS }, () => 0));
      hist[binOf(time)]! += 1;
    }
    bucket.count += 1;
  }
  bucket.count += Math.max(landings - times.length, 0);
}

/** The seven days ending `today`, oldest first, as histograms: [] for a day with no timed landing or outside the
 * window. A directory row keeps these so the median can be derived again whenever the window rolls. */
export function weekHistograms(days: readonly WeekDay[] | undefined, today: number): number[][] {
  return Array.from({ length: 7 }, (_, index) => {
    const hist = days?.find(row => row.day === today - 6 + index)?.hist;
    return hist?.length === TIME_BINS ? hist : [];
  });
}

/** Median save-to-main milliseconds of the merged day histograms; undefined when none holds a timed landing
 * (legacy landings stay "not reported" until a new one lands). The median is placed inside its bucket by rank, so
 * it is exact to the bucket width; the open last bucket reports its lower bound. */
export function histogramMedian(histograms: readonly (readonly number[] | undefined)[]): number | undefined {
  const merged = Array.from({ length: TIME_BINS }, () => 0);
  for (const hist of histograms)
    if (hist?.length === TIME_BINS) for (let bin = 0; bin < TIME_BINS; bin++) merged[bin]! += hist[bin]!;
  const total = merged.reduce((sum, n) => sum + n, 0);
  if (!total) return undefined;
  const rank = (total - 1) / 2;
  let before = 0;
  for (let bin = 0; bin < TIME_BINS; bin++) {
    const n = merged[bin]!;
    if (before + n > rank) {
      const low = bin === 0 ? 0 : TIME_EDGES[bin - 1]!;
      const high = TIME_EDGES[bin] ?? low;
      return Math.round((low + (high - low) * Math.min((rank - before + 0.5) / n, 1)) * 1000);
    }
    before += n;
  }
  return undefined;
}
