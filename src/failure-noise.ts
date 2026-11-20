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
  /** The first failing file's first error, or a static step's first error line, clipped. */
  error?: string;
};
export const FAILURE_FILES_KEPT = 5;
export const FAILURE_FILE_CHARS = 100;
export const FAILURE_ERROR_CHARS = 120;
export const FAILURE_STEP_CHARS = 100;
/** A static step's first error line is the only cause the row keeps (no files), so it may run longer. */
export const FAILURE_STEP_ERROR_CHARS = 200;
/** Landing codes that are a check that did not pass. Others are not listed by `--checks`. */
export const checkFailureCodes = new Set(['CHECK_FAILED', 'CHECK_NOT_PASSED', 'CONTRACT_OVER_BUDGET']);

// A time, CPU or size bar a measurement crossed (agent weight `cliAgentLandCpuMs`, perf-harness timing bars).
const BUDGET =
  /budget|CpuMs|\bCPU\b|timing bar|ceiling|over limit|exceed(?:s|ed)? (?:the )?(?:limit|cap)|slower than/i;
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
  return step ? stepDetail(step[1]!, step[2]!) : {};
}

/** The escape sequences a colored tool prints; they say nothing and fill the row. */
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
export const stripAnsi = (text: string) => text.replace(ansi, '');

/**
 * A failed static step as `step` (the job and the step's name) and `error` (its first error line). The
 * settled excerpt reads `NAME (reproduce: COMMAND)[ (also failed: ...)]: LINE ; LINE` when verify named the
 * failing step, else it is one line, which is the error. A reproduce command is not a cause (smoke:package rows
 * held only that), so it is dropped; the lines are ranked cause-first, so the first one is kept.
 */
export function stepDetail(job: string, excerpt: string): FailureDetail {
  const text = stripAnsi(excerpt);
  const named = /^(.+?) \(reproduce: .*?\)(?: \(also failed: [^)]*\))?(?:: ?(.*))?$/s.exec(text);
  // An excerpt clipped inside its reproduce command or also-failed list still names the step, and no cause.
  const clipped = named ? null : /^(.+?) \(reproduce: /s.exec(text);
  const name = named?.[1] ?? clipped?.[1] ?? '';
  const error = (named ? (named[2] ?? '') : clipped ? '' : text).split(' ; ')[0]!.trim();
  const step = `${stripAnsi(job)}${name ? `: ${name}` : ''}`.slice(0, FAILURE_STEP_CHARS);
  return { step, ...(error ? { error: error.slice(0, FAILURE_STEP_ERROR_CHARS) } : {}) };
}
