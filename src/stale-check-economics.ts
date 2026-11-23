// SPDX-License-Identifier: Apache-2.0
/** Keep the run (Item fa2c1383): the project's own measured check costs, for the scoped-recheck keep
 * (`StaleCheckEconomics`). Pure: it reads the landing-speed samples the sweep loads once, and the
 * run's first shard start.
 *
 * - Whole: accepted checks that ran the whole suite on their own (`full`).
 * - Scoped: accepted main-race rechecks (`scoped`), plus the ones that fell back to the whole suite
 *   (`scoped-full`) at what they really cost, so the share is not optimistic by the fallback rate
 *   (review 563c595b). Only rechecks reserved on the current selector (`currentRecheckSample`), from
 *   the window and the row's recheck reserve, so a few a day add up instead of rotating out (53c9a388).
 *   The seed is every recheck after a pass that main moved under: the same scoped recheck a kept pass
 *   seeds, so measuring it costs no kept run, call or read.
 * - Elapsed (review 563c595b F2): from the first test shard's start (its runner's first session after
 *   the plan), never from when the run was queued or planned, so waiting for runners is not progress.
 *   Before any shard starts, elapsed is 0. The whole-check median it is divided by includes the
 *   runner wait, which can only understate elapsed: it never over-keeps.
 * - redShare stays 0 (never over-keeps); the first-check red share is a later refinement. */
import { currentRecheckSample, speedWindow, type LandingSpeedState } from './landing-speed-alerts.js';
import type { StaleCheckEconomics } from './stale-check-keep.js';

/** Fewer samples of either kind than this: unmeasured, so no scoped keep. */
export const ECONOMICS_MIN_SAMPLES = 3;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.ceil((n - 1) / 2)]!) / 2;
};

/** The whole-check wall median (minutes) and the scoped shares, or null when unmeasured. */
export function measuredCheckCosts(samples: LandingSpeedState['samples'] | null | undefined) {
  const whole: { wall: number; jobs: number }[] = [];
  const scoped: { wall: number; jobs: number }[] = [];
  const window = new Set(speedWindow(samples ?? []));
  for (const row of samples ?? []) {
    const wall = row[2];
    const jobs = row[7]?.[3];
    if (wall == null || jobs == null || wall <= 0 || jobs <= 0) continue;
    if (row[11] === 'full' && window.has(row)) whole.push({ wall, jobs });
    else if (currentRecheckSample(row)) scoped.push({ wall, jobs });
  }
  if (whole.length < ECONOMICS_MIN_SAMPLES || scoped.length < ECONOMICS_MIN_SAMPLES) return null;
  const wall = median(whole.map(w => w.wall));
  const jobs = median(whole.map(w => w.jobs));
  return {
    wholeWallMinutes: wall,
    scopedShare: {
      jobs: median(scoped.map(w => w.jobs)) / jobs,
      wall: median(scoped.map(w => w.wall)) / wall,
    },
  };
}

/** The keep rule's economics input for one run, or null when unmeasured. */
export function checkEconomics(
  costs: ReturnType<typeof measuredCheckCosts>,
  shardStartedAt: number | undefined,
  now: number,
): StaleCheckEconomics | null {
  if (!costs) return null;
  const elapsed =
    shardStartedAt === undefined ? 0 : Math.max(0, now - shardStartedAt) / 60_000 / costs.wholeWallMinutes;
  return { elapsed, scopedShare: costs.scopedShare, redShare: 0 };
}
