// SPDX-License-Identifier: Apache-2.0
// Node-free: bundled into the Convex check backend and read by the fixed executor.
// The shard pool (work stealing, Issue 0ea17a29). Runner speed differs between jobs of one
// check (the same file ran 98 s on one runner and 183 s on another), so a perfect static plan
// still finishes on its slowest runner. Each shard keeps the front of its LPT-ordered group and
// offers the tail (its shortest files) as numbered units; a shard that finishes early claims
// other shards' units from the back with a create-only write. The static groups stay the plan of
// record: a runner without the pool runs its whole group. docs/operations/github-actions-checks.md#shard-pool
import { shardDuration } from './test-shards.mjs';

/** Share of a shard's planned time offered to the pool. The slowest shard runs about 15% (p50)
 * above the mean, so it must be able to shed a bit more than that. */
export const poolFraction = 0.2;
/** Planned wall time of one unit: one claim and one executor start per unit (~1 s). */
export const poolUnitMs = 20_000;
/** Shorter shards gain less than a claim round costs. */
export const poolMinShardMs = 60_000;
export const maxPoolUnits = 128;

/** Cut indices per group (ascending start index of each unit; [] = no units), or undefined. */
export function planPool(groups, durations = {}, options = {}) {
  const {
    fraction = poolFraction,
    unitMs = poolUnitMs,
    minShardMs = poolMinShardMs,
    maxUnits = maxPoolUnits,
  } = options;
  const pool = groups.map(group => {
    const planned = shardDuration(group, durations);
    if (group.length < 2 || planned < minShardMs) return [];
    let start = group.length;
    while (start > 1 && shardDuration(group.slice(start), durations) < planned * fraction) start--;
    const cuts = [];
    let unit = start;
    for (let end = start + 1; end <= group.length; end++) {
      if (shardDuration(group.slice(unit, end), durations) < unitMs) continue;
      cuts.push(unit);
      unit = end;
    }
    // A short remainder joins the previous unit; a tail shorter than one unit is one unit.
    if (unit < group.length && !cuts.length) cuts.push(unit);
    return cuts;
  });
  const total = pool.reduce((sum, cuts) => sum + cuts.length, 0);
  return total > 0 && total <= maxUnits ? pool : undefined;
}

/** Structural check used by the recipe schema: one cut list per group, each cut strictly
 * inside its group (the kept front is never empty), ascending, at most maxPoolUnits units. */
export function validPool(groups, pool) {
  if (!Array.isArray(pool) || pool.length !== groups.length) return false;
  let total = 0;
  for (const [index, cuts] of pool.entries()) {
    if (!Array.isArray(cuts)) return false;
    for (const [at, cut] of cuts.entries())
      if (!Number.isSafeInteger(cut) || cut < 1 || cut >= groups[index].length || (at && cut <= cuts[at - 1]))
        return false;
    total += cuts.length;
  }
  return total > 0 && total <= maxPoolUnits;
}

/** Units in home-major order: [{ unit, home, files }]. Every grouped file is in exactly one of
 * the kept fronts or units. */
export function poolUnits(groups, pool) {
  const units = [];
  pool.forEach((cuts, home) =>
    cuts.forEach((cut, at) =>
      units.push({ unit: units.length, home, files: groups[home].slice(cut, cuts[at + 1]) }),
    ),
  );
  return units;
}

export const keptFiles = (groups, pool, index) =>
  groups[index].slice(0, pool[index][0] ?? groups[index].length);

/** FORGE_ACTIONS_POOL_MODE: on (default), off, or ab (interleaved measurement: the pool runs
 * when the run id's last hex digit is odd; run ids are random UUIDs). Unknown values are off. */
export function poolArm(mode, runId) {
  if (mode === undefined || mode === '' || mode === 'on') return true;
  if (mode !== 'ab') return false;
  const last = /([0-9a-f])$/i.exec(String(runId))?.[1];
  return last !== undefined && parseInt(last, 16) % 2 === 1;
}
