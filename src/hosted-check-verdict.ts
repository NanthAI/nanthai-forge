// SPDX-License-Identifier: Apache-2.0
import { hostedCheckTerminal, type HostedCheckRun } from './hosted-check.js';

/**
 * The CI-neutral pass rule for checks that run on another CI (Issue 432164bf), the same for every
 * adapter: supervisor results say which tests ran, failed or flaked, and a failing one fails the
 * check at once, but they are written from the job that also ran the Candidate. A pass therefore
 * also needs the provider's own record that the run succeeded, received on a channel that job
 * cannot write (a signed provider event, or a provider API read with the adapter's credential).
 * The supervisor exits non-zero whenever it saw a failure, so a provider success means it saw a pass.
 */
export type ProviderVerdict =
  | { status: 'passed' }
  | { status: 'cancelled'; reason: string }
  | { status: 'runner-unavailable'; reason: string };
export function providerVerdict(conclusion: string | null | undefined): ProviderVerdict {
  if (conclusion === 'success') return { status: 'passed' };
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
