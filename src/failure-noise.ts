// SPDX-License-Identifier: Apache-2.0
// Pure: runs in the Convex non-Node runtime and the CLI.
/**
 * What a failed check names, and whether it was noise (Item 44f2b109). `nforge metrics ROOT --failures
 * --checks` lists failed landings with their failing files or static step and one tag, so a flaky gate
 * and a real failure are told apart without one read per failure. The tag is read from the stored row, so
 * rows written before the detail fields existed are tagged from their clipped message too.
 */

/** `runner`: the CI or machine, not the code. `budget`: a time or size budget test or guard. `flake`: a
 * transient signature (timeout, browser or port). `real`: a named file or step with none of those.
 * `unknown`: nothing was retained that names a cause. */
export const failureNoises = ['runner', 'budget', 'flake', 'real', 'unknown'] as const;
export type FailureNoise = (typeof failureNoises)[number];

/** The bounded detail one failed-check row keeps. */
export type FailureDetail = {
  /** Failing test file names, at most FAILURE_FILES_KEPT. */
  files?: string[];
  /** Further failed files not listed. */
  more?: number;
  /** A failed check that named no test file: its failing job and line. */
  step?: string;
  /** The first failing file's first error, clipped. */
  error?: string;
};
export const FAILURE_FILES_KEPT = 5;
export const FAILURE_FILE_CHARS = 100;
export const FAILURE_ERROR_CHARS = 120;
export const FAILURE_STEP_CHARS = 100;
/** Landing codes that are a check that did not pass. Others are not listed by `--checks`. */
export const checkFailureCodes = new Set(['CHECK_FAILED', 'CHECK_NOT_PASSED', 'CONTRACT_OVER_BUDGET']);

const BUDGET = /budget|CpuMs|over limit|exceed(?:s|ed)? (?:the )?(?:limit|cap)|slower than/i;
const RUNNER =
  /ENOSPC|No space left|ECONNRESET|EAI_AGAIN|socket hang up|runner|lost communication|shutdown signal|was canceled|terminated|out of memory|\bkilled\b|rate limit/i;
const FLAKE = /timed? ?out|timeout|EADDRINUSE|ECONNREFUSED|Target closed|browser has been closed|page\.goto/i;

/** The noise tag of one failed check, from retained fields only. */
export function failureNoise(row: { code: string } & FailureDetail): FailureNoise {
  if (row.code === 'CHECK_NOT_PASSED') return 'runner';
  if (row.code === 'CONTRACT_OVER_BUDGET') return 'budget';
  const text = `${row.step ?? ''} ${row.error ?? ''}`;
  if (!row.files?.length && !row.step) return 'unknown';
  if (BUDGET.test(text)) return 'budget';
  if (RUNNER.test(text)) return 'runner';
  if (FLAKE.test(text)) return 'flake';
  return 'real';
}

const filePath = /^(?=.*[./])[\w@.+/-]{1,200}$/;
/**
 * Detail read back from a row written before the detail fields: the settled message begins
 * "...Failing: A (error); B; +N more failed files." or "...Failing JOB: line", clipped at 240 characters.
 * Best effort: a clipped tail loses files; only path-shaped words (with a dot or slash) count as files.
 */
export function messageDetail(message: string): FailureDetail {
  // The sentence ends at the next sentence of the message (a flaky note, the next step) or at its end.
  const named = /Failing: (.+?)(?:\. Flaky, passed on retry:| Fix it in this Lane|$)/s.exec(message);
  if (named) {
    const parts = named[1]!.replace(/\.$/, '').split('; ');
    const files = parts
      .map(part => part.replace(/ \(.*$/s, '').trim())
      .filter(file => filePath.test(file))
      .slice(0, FAILURE_FILES_KEPT);
    const error = /^\S+ \((.*?)\)?$/s.exec(parts[0]!)?.[1];
    if (files.length) return { files, ...(error ? { error: error.slice(0, FAILURE_ERROR_CHARS) } : {}) };
  }
  const step = /Failing ([^:]{1,60}): (.+?)(?:\.? Flaky, passed on retry:| Fix it in this Lane|$)/s.exec(
    message,
  );
  return step ? { step: `${step[1]}: ${step[2]}`.slice(0, FAILURE_STEP_CHARS) } : {};
}
