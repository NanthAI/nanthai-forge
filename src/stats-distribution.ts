// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Sorted seconds standing for `n` values: every value while `n` is `v.length`, else evenly spaced quantiles of them (a
 * month's rollup keeps at most STATS_DIST_SAMPLES), each sample standing for n / v.length values. */
export type StatsDist = { n: number; v: number[] };
/** Samples a month rollup keeps per distribution: its medians stay within one sample's share of the exact one. */
export const STATS_DIST_SAMPLES = 400;
export const exactDist = (v: readonly number[] | null): StatsDist[] =>
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
