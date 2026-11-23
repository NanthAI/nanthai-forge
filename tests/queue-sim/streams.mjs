// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Mixed landing streams for the queue sim (Items 1018d0f8, 273650ab): the same stream for every arm,
// a measurement run (doomed-check-shapes.mjs) and a regression replay (hosted-landing-wait-circle).
const risky = i => `.github/actions/w${i}/action.yml`;
// Deterministic pseudo-random stream (mulberry32), so a mixed stream is the same for every arm.
export const rng = seed => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let v = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  v ^= v + Math.imul(v ^ (v >>> 7), 61 | v);
  return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
};
/** `count` changes arriving about every `gap` ticks; `riskShare` of them change a CI action or the
 * schema (order-sensitive), the rest a plain source file. A check takes `check` ticks +-20%. */
export function stream(seed, count, gap, riskShare, mode = 'fast', check = 150) {
  const r = rng(seed);
  const paths = [],
    at = [],
    dur = [];
  let tick = 0;
  for (let i = 0; i < count; i++) {
    const kind = r();
    paths.push(
      kind < riskShare / 2
        ? i % 2
          ? 'convex/schema.ts'
          : risky(i)
        : kind < riskShare
          ? risky(i)
          : `src/m${i}.ts`,
    );
    at.push(tick);
    tick += Math.floor(r() * gap * 2);
    dur.push(Math.round(check * (0.8 + r() * 0.4)));
  }
  // At most one schema change in flight at a time is not required: the queue must cope.
  const unique = paths.map((p, i) => (p === 'convex/schema.ts' && paths.indexOf(p) !== i ? risky(i) : p));
  return {
    memberPaths: unique,
    fixture: { landingMode: mode },
    arrives: i => at[i],
    duration: i => dur[i],
  };
}
