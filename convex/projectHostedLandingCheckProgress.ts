// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx, MutationCtx } from './server';
import type { Doc } from './_generated/dataModel';
import { loadHostedCheck } from './projectHostedCheckStore';
import type { HostedLandingState } from '../src/hosted-landing';
import type { HostedCheckRun } from '../src/hosted-check';
import { digest } from '../src/state/hash';
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
      ...(run.failureReason?.startsWith('provider-delayed:') ? { providerDelay: run.failureReason } : {}),
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
  // Shard execution seconds of the ended run, from the run row already in hand (Issue 3e3f9fe6).
  if (run.endedAt && run.execution)
    state.counts = { ...state.counts, runnerSeconds: Math.round(run.execution.seconds) };
  if (run.testFiles) state.testFiles = run.testFiles;
  if (run.fallbackReason) state.ranInFull = run.fallbackReason;
}

/** Read only for an affected check, on the observer's existing subscription. Healthy
 * status adds zero reads. The reason uses the existing run record, no new stored shape. */
export async function readProviderDelay(
  ctx: QueryCtx | MutationCtx,
  row: Doc<'projectHostedLandingRequests'>,
  state: HostedLandingState,
) {
  if (state.observation.pendingReason !== 'pending-infra' || !row.runId) return {};
  const { run } = await loadHostedCheck(ctx, { projectId: row.projectId, runId: row.runId }, false);
  return run.failureReason ? { providerDelay: run.failureReason } : {};
}
