// SPDX-License-Identifier: Apache-2.0
import { protectedTiers } from '../scripts/test-impact.mjs';
import { shellQuote } from './shell-quote.js';

/** A run that did not start every must-run file: not passed, not failed. */
export type PreflightIncomplete = {
  /** Must-run (protected: changed, learned, direct) files the wall-time budget did not start. */
  mustRun: number;
  /** The one command that runs exactly the files this run did not start, with no time budget. */
  finish: string;
  /** About how long `finish` takes here, at the speed this run observed. */
  estimateMinutes: number;
};

/** Must-run files among those a run did not start. Protected tiers are the tests the plan never
 * trims because they exercise the change itself; when the wall clock stops one, the run proved
 * nothing about it, so it cannot be a pass. A rerun of stopped files plans them in these same tiers. */
export function mustRunNotRun(tierTests: Record<string, string[]> | undefined, notRun: string[]) {
  if (!tierTests || !notRun.length) return [];
  const guarded = new Set(
    Object.entries(tierTests)
      .filter(([tier]) => protectedTiers.has(tier))
      .flatMap(([, tests]) => tests),
  );
  return notRun.filter(test => guarded.has(test));
}

/** NOT COMPLETE details when a clean run left must-run files unstarted; undefined otherwise, so a
 * run whose protected tier fits its budget is unchanged. The finish command is `retry` (exactly the
 * stopped files, passes reused) with `trim:false` (no wall-time cap), so one run finishes them. */
export function incompletePreflight(input: {
  root: string;
  laneId: string;
  tierTests: Record<string, string[]> | undefined;
  notRun: string[];
  secondsPerFile: number;
}): PreflightIncomplete | undefined {
  const mustRun = mustRunNotRun(input.tierTests, input.notRun).length;
  if (!mustRun) return undefined;
  return {
    mustRun,
    finish: `nforge agent ${shellQuote(input.root)} preflight ${shellQuote(
      JSON.stringify({ laneId: input.laneId, retry: true, trim: false }),
    )}`,
    estimateMinutes: Math.max(1, Math.ceil((input.notRun.length * input.secondsPerFile) / 60)),
  };
}

/** What a preflight receipt means (SM-C M4): one derive for the summary word, the land gate's
 * advisory and the retry reader. An environment problem (a program missing here, a wedged tool)
 * is never a failed run, and wins over everything else the receipt carries. */
export type PreflightOutcome = 'passed' | 'incomplete' | 'environment' | 'failed';
export const preflightOutcome = (receipt: {
  passed: boolean;
  environment?: unknown;
  incomplete?: PreflightIncomplete | undefined;
}): PreflightOutcome =>
  receipt.environment
    ? 'environment'
    : receipt.incomplete
      ? 'incomplete'
      : receipt.passed
        ? 'passed'
        : 'failed';
const verdictWords = {
  passed: 'passed',
  incomplete: 'NOT COMPLETE',
  environment: 'ENVIRONMENT (not a failed run)',
  failed: 'FAILED',
} satisfies Record<PreflightOutcome, string>;
/** The word a receipt's verdict starts with: a run is passed, NOT COMPLETE, ENVIRONMENT or FAILED. */
export const preflightVerdict = (receipt: Parameters<typeof preflightOutcome>[0]) =>
  verdictWords[preflightOutcome(receipt)];
