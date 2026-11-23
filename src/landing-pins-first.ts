// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Pins first (Item 13ea93bf, lead decision 2026-11-23 19:20Z): about a quarter of failed landing
// checks were compositions, a Lane that passed preflight on its own base breaking a contract pin
// (a table registration, a read count, a tool list) once composed with what landed before it. The
// landing check found them only after every shard ran (about 8 min wall, 77 runner-minutes). The
// planning job now runs the check's cheap contract pins on the composed Candidate first and, on a
// failure, ends the check there with the same failing-file cause. docs/operations/github-actions-checks.md#pins-first
import { CONTRACT_PIN_SECONDS, contractGuardTest, contractPinWeight } from '../scripts/test-impact.mjs';
import { isBrowserTest } from '../scripts/browser-test-policy.mjs';

/** A pin joins only when its recorded runner time is at most this: a file with no record never joins. */
export const LANDING_PIN_MAX_MS = 10_000;
/** Recorded runner seconds of all pins together: the same room preflight gives contract pins. */
export const LANDING_PINS_BUDGET_MS = CONTRACT_PIN_SECONDS * 1000;
export type LandingPinsFirst = {
  /** Test files to run first, in run order; every one is in a planned shard group. */
  files: string[];
  /** The shard whose result carries the pins' reports when they fail: the group of the first pin. */
  carrier: number;
  /** Their recorded runner time in total (ms). */
  plannedMs: number;
};

/** The cheap contract pins of one planned check, or null when it has none. Pure: reads only the
 * planned groups and the recorded runner timings the plan already holds; no call, no file read.
 * Registration and inventory pins first, then cost and budget pins, then other contract pins;
 * cheapest first within each, while their recorded seconds fit LANDING_PINS_BUDGET_MS. */
export function landingPinsFirst(
  groups: readonly (readonly string[])[],
  timings: Readonly<Record<string, number>>,
): LandingPinsFirst | null {
  const home = new Map<string, number>();
  groups.forEach((group, index) => group.forEach(file => home.has(file) || home.set(file, index)));
  const measured = (file: string) => {
    const ms = timings[file];
    return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : undefined;
  };
  const candidates = [...home.keys()]
    .filter(file => contractGuardTest(file) && !isBrowserTest(file))
    .filter(file => (measured(file) ?? Infinity) <= LANDING_PIN_MAX_MS)
    .sort(
      (a, b) =>
        contractPinWeight(b) - contractPinWeight(a) ||
        measured(a)! - measured(b)! ||
        (a < b ? -1 : a > b ? 1 : 0),
    );
  const files: string[] = [];
  let plannedMs = 0;
  for (const file of candidates) {
    if (plannedMs + measured(file)! > LANDING_PINS_BUDGET_MS) continue;
    plannedMs += measured(file)!;
    files.push(file);
  }
  return files.length ? { files, carrier: home.get(files[0]!)!, plannedMs: Math.round(plannedMs) } : null;
}

/** The file the planning job leaves for its pins step, beside the plan (RUNNER_TEMP). */
export const landingPinsFile = 'forge-actions-pins.json';
/** The env var that hands the pinned pin list to the fixed executor (scripts/github-actions-check.mjs). */
export const LANDING_PINS_ENV = 'FORGE_ACTIONS_PINS';
/** What a shard that never started says, when the pins already failed the check. */
export const pinsFirstNotRun = (carrier: number) =>
  `Not run: the contract pins failed first on the composed Candidate (their report is on shard ${carrier}), so this check stopped before its other jobs. Fix the failing pin, then land again.`;
