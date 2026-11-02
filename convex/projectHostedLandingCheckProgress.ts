// SPDX-License-Identifier: Apache-2.0
import type { HostedLandingState } from '../src/hosted-landing';
import type { HostedCheckRun } from '../src/hosted-check';
import { digest } from '../src/portable-hash';
import { canonicalPayload } from '../src/hosted-source-operation';

/** Solo and shared runs retain the same observed progress, without changing
 * immutable attempt pins or treating provider activity as acceptance evidence. */
export function retainCheckProgress(state: HostedLandingState, run: HostedCheckRun, now: number) {
  const progress = digest(
    canonicalPayload({
      id: run.id,
      status: run.status,
      counts: run.counts,
      plan: run.planDigest,
      execution: run.executionId,
      terminal: run.terminalDigest,
    }),
  );
  if (state.checkProgress !== progress) {
    state.checkProgress = progress;
    state.timing = { submittedAt: state.at, ...state.timing, ciProgressAt: new Date(now).toISOString() };
  }
  state.timing = {
    submittedAt: state.at,
    ...state.timing,
    checkReservedAt: run.at,
    ...(run.endedAt ? { ciEndedAt: run.endedAt } : {}),
    ...(run.status === 'running' && !state.timing?.ciObservedAt
      ? { ciObservedAt: new Date(now).toISOString() }
      : {}),
  };
  if (run.testFiles) state.testFiles = run.testFiles;
}
