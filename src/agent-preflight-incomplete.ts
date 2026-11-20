// SPDX-License-Identifier: Apache-2.0
import { protectedTiers } from '../scripts/test-impact.mjs';
import { AGENT_WAIT_SECONDS } from './agent-operation-wait.js';
import { shellQuote } from './shell-quote.js';

/** A run that did not start every must-run file: not passed, not failed. */
export type PreflightIncomplete = {
  /** Must-run (protected: changed, learned, direct) files the wall-time budget did not start. */
  mustRun: number;
  /** Planned test files that skipped because a runtime they need (a browser) is not installed here:
   * a skip proves nothing, so it is never a pass (Item ad80e037 fix 5). */
  needs?: PreflightNeeds | undefined;
  /** The one command that runs exactly the files this run did not start, with no time budget;
   * offered only when its estimate fits one agent wait (otherwise the landing check runs them). */
  finish?: string | undefined;
  /** About how long `finish` takes here, at the speed this run observed. */
  estimateMinutes: number;
};

export type PreflightNeeds = { runtime: string; files: string[]; next: string };

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

/** NOT COMPLETE details when a clean run left must-run files unstarted or skipped planned files for a
 * missing runtime (NEEDS); undefined otherwise, so a run whose protected tier fits its budget is unchanged. The finish command is `retry` (exactly the
 * stopped files, passes reused) with `trim:false` (no wall-time cap), so one run finishes them. It is
 * offered only when it fits one agent wait (`waitSeconds`): a longer one outlives the agent's own
 * command timeout, so the next step is to land and let the landing check run them. */
export function incompletePreflight(input: {
  root: string;
  laneId: string;
  tierTests: Record<string, string[]> | undefined;
  notRun: string[];
  secondsPerFile: number;
  waitSeconds?: number;
  needs?: PreflightNeeds | undefined;
}): PreflightIncomplete | undefined {
  const mustRun = mustRunNotRun(input.tierTests, input.notRun).length;
  if (!mustRun && !input.needs) return undefined;
  const seconds = input.notRun.length * input.secondsPerFile;
  return {
    mustRun,
    ...(input.needs ? { needs: input.needs } : {}),
    // Rerunning does not install a missing runtime: finish is for files the budget did not start.
    ...(mustRun && seconds <= (input.waitSeconds ?? AGENT_WAIT_SECONDS)
      ? {
          finish: `nforge agent ${shellQuote(input.root)} preflight ${shellQuote(
            JSON.stringify({ laneId: input.laneId, retry: true, trim: false }),
          )}`,
        }
      : {}),
    estimateMinutes: Math.max(1, Math.ceil(seconds / 60)),
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
/** The process exit status of a run with this outcome: 0 passed, 2 failed (as a failed landing),
 * 3 NOT COMPLETE (nothing failed; the reply names what is left, as IN PROGRESS does), 4 environment
 * (this machine, not the change). A script can branch on it without reading the receipt. */
export const preflightExitStatus = (outcome: PreflightOutcome) =>
  ({ passed: 0, failed: 2, incomplete: 3, environment: 4 })[outcome];
const verdictWords = {
  passed: 'passed',
  incomplete: 'NOT COMPLETE',
  environment: 'ENVIRONMENT (not a failed run)',
  failed: 'FAILED',
} satisfies Record<PreflightOutcome, string>;
/** The word a receipt's verdict starts with: a run is passed, NOT COMPLETE, ENVIRONMENT or FAILED. */
export const preflightVerdict = (receipt: Parameters<typeof preflightOutcome>[0]) =>
  verdictWords[preflightOutcome(receipt)];
