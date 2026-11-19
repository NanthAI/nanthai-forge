// SPDX-License-Identifier: Apache-2.0
import { checkTimeSchema, type CheckTime, type CheckTimeEvidence } from './hosted-check.js';

/** Name the landing that adds check time (Issue a217b83e). When a check run's per-file timings join the
 * planner's timing history (the same mutation that already reads and writes that row), the run keeps a
 * small `checkTime` record: the seconds of each test file that is new to the history, after dividing out
 * the run's own speed (runner hardware), and the history seconds of files it no longer runs. Only whole
 * runs get one: a scoped recheck skips files on purpose, so it cannot tell a deleted file from one it
 * did not select, and a landing accepted on one is not named (the runner-minutes budget still sees it). Acceptance, which already holds the run and the change's paths, names the change's new test files
 * when they add seconds beyond timing noise, net of test files it deletes or renames. A change that only
 * deletes test files is not named. It never blocks.
 *
 * Only new files are named. An edited file's per-file change is too noisy to attribute: with 30 or 100
 * edited files some are always the run's random outliers (review F2 on a217b83e). A file the history
 * has timed in fewer than YOUNG_RUNS runs counts as new, so a change's own earlier attempts and scoped
 * rechecks, which also feed the history, do not hide its new file (F4).
 *
 * A whole-check speed shift is not named here: the hosted executor runs from main's control checkout, so a
 * change to it shows first in checks dispatched after it lands, and blaming the landing whose check saw the
 * shift would name the wrong landing. The runner-minutes-per-full-check budget catches that class. */
/** Files kept per side; the evidence schema (src/hosted-check.ts) allows twice this. */
const CHECK_TIME_FILES = 12;
/** Established files needed to measure a run's own speed and spread. */
const MIN_MATCHED = 5;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b),
    middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const r3 = (value: number) => Math.round(value * 1000) / 1000;

type PriorFile = { durationMs: number; updatedAt: string; n?: number };
/** Pure. `prior` is the history's files before this run (an entry with `n` is young); `durations` the
 * milliseconds of a whole run, whose missing files left the test set. Null when the run has too few
 * established timed files to tell its speed from noise. */
export function checkTimeEvidence(
  prior: Record<string, PriorFile>,
  durations: Record<string, number>,
): CheckTimeEvidence | null {
  const timed = Object.entries(durations).filter(([, ms]) => Number.isFinite(ms) && ms > 0);
  const known = (file: string) => prior[file]!.durationMs > 0 && prior[file]!.n === undefined;
  const matched = timed.filter(([file]) => Object.hasOwn(prior, file) && known(file));
  if (matched.length < MIN_MATCHED) return null;
  const logs = matched.map(([file, ms]) => Math.log(ms / prior[file]!.durationMs));
  const factor = median(logs),
    spread = 1.4826 * median(logs.map(value => Math.abs(value - factor)));
  const speed = Math.exp(factor);
  const fresh = timed
    .filter(([file]) => !Object.hasOwn(prior, file) || !known(file))
    .map(([file, ms]): [string, number, null] => [file, r3(ms / speed / 1000), null])
    .sort((a, b) => b[1] - a[1])
    .slice(0, CHECK_TIME_FILES);
  const gone = Object.entries(prior)
    .filter(([file, item]) => !Object.hasOwn(durations, file) && item.durationMs > 0)
    .sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt) || a[0].localeCompare(b[0]))
    .slice(0, CHECK_TIME_FILES)
    .map(([file, item]): [string, number, number] => {
      const base = r3(item.durationMs / 1000);
      return [file, -base, base];
    });
  return {
    factor: r3(factor),
    spread: r3(spread),
    typical: r3(median(matched.map(([file]) => prior[file]!.durationMs)) / 1000),
    files: [...fresh, ...gone],
  };
}

/** Pure: the receipt's `checkTime` for a change with these paths, or null unless the test files it adds,
 * net of the ones it deletes or renames, move check time by more than three standard deviations of their
 * timing noise and more than three typical files' noise. Acceptance calls it: a malformed record names
 * nothing and never fails a landing. */
export function attributeCheckTime(
  evidence: CheckTimeEvidence | undefined,
  paths: readonly string[] | null,
): CheckTime | null {
  try {
    if (!evidence || !paths?.length) return null;
    const changed = new Set(paths);
    const tests = evidence.files.filter(([file]) => changed.has(file));
    // Deleted or renamed files only net out the change's new ones (a rename or split adds nothing).
    if (!tests.some(([, , base]) => base === null)) return null;
    const total = tests.reduce((sum, [, delta]) => sum + delta, 0);
    const noise = Math.sqrt(
      tests.reduce((sum, [, delta, base]) => sum + (evidence.spread * (base ?? Math.abs(delta))) ** 2, 0),
    );
    if (!(Math.abs(total) > 3 * noise) || Math.abs(total) < 3 * evidence.spread * evidence.typical)
      return null;
    const time = {
      seconds: Math.round(total),
      noise: Math.round(noise),
      tests: tests
        .filter(([, delta]) => Math.sign(delta) === Math.sign(total))
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 5)
        .map(([file, delta]): [string, number] => [file, Math.round(delta)]),
    };
    return checkTimeSchema.safeParse(time).success ? time : null;
  } catch {
    return null;
  }
}
