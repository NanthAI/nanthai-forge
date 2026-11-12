// SPDX-License-Identifier: Apache-2.0
import { hostedCheckTerminal, type HostedCheckRun } from './hosted-check.js';

/**
 * The CI-neutral pass rule for checks that run on another CI (Issue 432164bf), the same for every
 * adapter: supervisor results say which tests ran, failed or flaked, and a failing one fails the
 * check at once, but they are written from the job that also ran the Candidate. A pass therefore
 * also needs the provider's own record that the run succeeded, received on a channel that job
 * cannot write (a signed provider event, or a provider API read with the adapter's credential).
 * The supervisor exits non-zero whenever it saw a failure, so a provider success means it saw a pass.
 * A lagged run may instead be confirmed by the bounded, signed-shards-plus-steps rule
 * in ci-provider-recovery.ts; supervisor results alone still never pass.
 */
export type ProviderVerdict =
  | { status: 'passed' }
  | { status: 'failed'; reason: string }
  | { status: 'cancelled'; reason: string }
  | { status: 'runner-unavailable'; reason: string };
export function providerVerdict(conclusion: string | null | undefined): ProviderVerdict {
  if (conclusion === 'success') return { status: 'passed' };
  if (['failure', 'failed', 'timed_out', 'action_required'].includes(conclusion ?? ''))
    return { status: 'failed', reason: `The CI provider concluded the run ${conclusion}.` };
  if (conclusion === 'cancelled')
    return { status: 'cancelled', reason: 'The CI provider cancelled the run after every shard reported.' };
  return {
    status: 'runner-unavailable',
    reason: `The CI provider concluded the run ${conclusion ?? 'unknown'} although every shard reported passing; Forge counts a pass only with the provider's success.`,
  };
}

/** The run's output can be finalized: settled, or every shard reported and only the provider's
 * conclusion is outstanding. */
export const hostedCheckOutputSettled = (run: Pick<HostedCheckRun, 'status' | 'actions'>) =>
  hostedCheckTerminal(run) || run.actions?.verdictPending === true;

/** The optional source-pack job's name in forge-check.yml: continue-on-error, so the run's conclusion
 * never depends on it, but the conclusion still waits for it to finish (friction 0064c3b2). */
export const OPTIONAL_PROOF_JOB = 'Collect optional Forge landing proof';
export const OPTIONAL_PACK_JOB = 'Refresh optional Forge source pack';

/**
 * The run's conclusion without the optional pack job, from GitHub's own job list (a provider API
 * read with the adapter's credential, which the Candidate's job cannot write): `success` once every
 * other job completed as success or skipped; another conclusion once they all completed and one did
 * not succeed; null while one is still running or the page is incomplete (the run's own conclusion
 * then decides). A pass therefore needs the same provider record as before, for every job that
 * could have written results.
 */
export function requiredJobsConclusion(body: unknown): string | null {
  const page = body as {
    total_count?: unknown;
    jobs?: { name?: unknown; status?: unknown; conclusion?: unknown }[];
  };
  if (!Array.isArray(page?.jobs) || page.total_count !== page.jobs.length) return null;
  const required = page.jobs.filter(job => job.name !== OPTIONAL_PACK_JOB && job.name !== OPTIONAL_PROOF_JOB);
  if (!required.length) return null;
  const failed = required.find(
    job => job.status === 'completed' && job.conclusion !== 'success' && job.conclusion !== 'skipped',
  );
  if (failed) return typeof failed.conclusion === 'string' ? failed.conclusion.slice(0, 40) : 'unknown';
  if (required.some(job => job.status !== 'completed')) return null;
  return required.some(job => job.conclusion === 'success') ? 'success' : null;
}
