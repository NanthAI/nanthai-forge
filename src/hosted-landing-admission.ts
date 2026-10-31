// SPDX-License-Identifier: Apache-2.0
import type { AutonomyPolicy } from './autonomy-policy.js';
import { HOSTED_BATCH_MEMBERS, hostedBatching } from './hosted-landing-batch.js';

/** Off by default: per-member admission runs add Convex work to a clean cohort
 * (see docs/operations/landing-batches.md). `acceptance.admissionCheck: true` opts in. */
export const hostedAdmission = (policy: AutonomyPolicy) =>
  hostedBatching(policy) && policy.acceptance.admissionCheck === true;
/** A cohort check that ends without a failing test (runner unavailable, Actions
 * 403 or server error, cancelled, timeout) retries the same cohort this often. */
export const HOSTED_PLATFORM_RETRIES = 2;
/** Recent outcomes kept per queue, newest last: `1` passed, `0` a test failed. */
export const HOSTED_OUTCOME_WINDOW = 20;
// Priors from the 2026-10-30 dogfood baseline (first checks fail about 30% of the
// time). Admitted members already passed alone, so only interactions remain.
const PRIOR = { first: 0.3, admitted: 0.05 } as const;
const PRIOR_WEIGHT = 4;

export type OutcomeHistory = { first?: string | undefined; admitted?: string | undefined };
export function recordOutcome(history: string | undefined, passed: boolean) {
  return ((history ?? '') + (passed ? '1' : '0')).slice(-HOSTED_OUTCOME_WINDOW);
}
/** Smoothed failure rate: the prior counts as PRIOR_WEIGHT observations. */
export function failureRate(history: string | undefined, kind: keyof typeof PRIOR) {
  const seen = history ?? '';
  const failed = [...seen].filter(c => c === '0').length;
  return (failed + PRIOR[kind] * PRIOR_WEIGHT) / (seen.length + PRIOR_WEIGHT);
}
/** Dorfman group testing: expected checks per member are 1/k + 1 - (1-p)^k.
 * Returns the cheapest k in [1, cap]; k=1 means members check alone. */
export function cohortSizeFor(p: number, cap = HOSTED_BATCH_MEMBERS) {
  let best = 1,
    cost = 1;
  for (let k = 2; k <= cap; k++) {
    const next = 1 / k + 1 - (1 - p) ** k;
    if (next < cost) [best, cost] = [k, next];
  }
  return best;
}
export function cohortSize(policy: AutonomyPolicy, history: OutcomeHistory | undefined, admitted: boolean) {
  const fixed = policy.acceptance.batchMaxSize;
  if (fixed) return Math.min(fixed, HOSTED_BATCH_MEMBERS);
  const kind = admitted ? 'admitted' : 'first';
  return cohortSizeFor(failureRate(history?.[kind], kind));
}
type FailureRun = {
  status: string;
  testFiles?: { failed: unknown[] } | undefined;
  contractReports?: Record<string, { failed: boolean }> | undefined;
};
/** Members go solo only when tests failed. A run that ended without a failing
 * test file or report is a platform failure, whatever its exit status. */
export function checkFailureKind(
  run: FailureRun,
  semantic: { conflicts: unknown[]; overBudget?: unknown },
): 'passed' | 'tests' | 'platform' {
  const failedTests =
    Boolean(run.testFiles?.failed.length) ||
    Object.values(run.contractReports ?? {}).some(report => report.failed);
  if (failedTests || semantic.conflicts.length || Boolean(semantic.overBudget)) return 'tests';
  return run.status === 'passed' ? 'passed' : 'platform';
}
/** Halves for parallel bisection, in queue order. */
export function halves<T>(members: readonly T[]): [T[], T[]] {
  const middle = Math.ceil(members.length / 2);
  return [members.slice(0, middle), members.slice(middle)];
}
/** Groups that recheck at once after a failed cohort. Members the retained
 * evidence names as likely recheck alone and the rest together; with no
 * attribution, halves. */
export function splitGroups<T>(members: readonly T[], likely: (member: T) => boolean): T[][] {
  const suspects = members.filter(likely);
  const groups = suspects.length
    ? [members.filter(member => !likely(member)), ...suspects.map(member => [member])]
    : halves(members);
  return groups.filter(group => group.length);
}
