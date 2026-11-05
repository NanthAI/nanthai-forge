// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './server';
import type { HostedCheckRun } from '../src/hosted-check';
import type { BatchFailure } from '../src/hosted-batch-diagnosis';
import { landingObservation, type HostedLandingAttempt } from '../src/hosted-landing';
import { failedGroupAction } from '../src/hosted-landing-suspect';
import { settleBatchConflicts } from './projectHostedLandingCohortConflicts';
import {
  retryLandingBatch,
  writeBatch,
  type BatchIdentity,
  type LandingBatch,
} from './projectHostedLandingBatchStore';
import { loadLanding, settleLandingOperation, writeLanding } from './projectHostedLandingStore';
import { predecessorStatus } from './projectHostedLandingPipeline';
import { hostedStartMain } from './projectHostedChannels';

/** Queue throughput after a failed combined generation (51bbbd00). Runs inside
 * the existing failure transition of the queue tick: no extra Convex call, no
 * timer, no poll. Reads are bounded by one cohort (<= 8 members) plus main and
 * one predecessor, and happen only after a shared check failed tests.
 *
 * - settle: a one-member group with no predecessor on exact current main is its
 *   member's own exact check. Re-running the same tree alone only repeats it,
 *   so the member settles CHECK_FAILED now and descendants retire once.
 * - unstack: a stacked group whose own changes explain no failing file, below a
 *   predecessor that has not passed yet, recomposes once on current main without
 *   that predecessor instead of splitting into solos that restack on it. Its
 *   descendants retire through the existing generation path. Nobody is blamed
 *   without evidence; the predecessor's own check still decides its fate.
 * Returns false when the existing attributed split applies. */
export async function isolateFailedBatch(
  ctx: MutationCtx,
  key: BatchIdentity,
  batch: LandingBatch,
  failure: BatchFailure,
  shared: HostedLandingAttempt,
  run: HostedCheckRun,
  semanticOrBudget: boolean,
) {
  const included = batch.members.filter(m => !batch.included || batch.included.includes(m.submissionId));
  const pending = (
    await Promise.all(
      included.map(async original => ({
        original,
        ...(await loadLanding(ctx, { projectId: key.projectId, submissionId: original.submissionId })),
      })),
    )
  ).filter(member => member.state.phase !== 'landed' && member.state.phase !== 'terminal-failed');
  if (!pending.length) return false;
  const main = await hostedStartMain(ctx, key.projectId);
  const exactMain = main.head === shared.main.head && main.receipt.id === shared.main.receiptId;
  let predecessorPending = false;
  if (batch.predecessor && (await predecessorStatus(ctx, key, batch)) === 'pending') {
    const below = await loadLanding(ctx, {
      projectId: key.projectId,
      submissionId: batch.predecessor.submissionId,
    });
    predecessorPending = below.state.phase !== 'ready';
  }
  const action = failedGroupAction({
    members: pending.length,
    suspects: failure.suspects.length,
    semanticOrBudget,
    stacked: Boolean(batch.predecessor),
    exactMain,
    predecessorPending,
    previouslyFailed: pending.some(
      member =>
        member.state.batchDiagnostic?.sharedRunId !== undefined &&
        member.state.batchDiagnostic.sharedRunId !== failure.runId,
    ),
  });
  if (action === 'split') return false;
  const files = failure.failedTests.length
    ? failure.failedTests.join(', ')
    : failure.step
      ? `${failure.step.job}: ${failure.step.excerpt}`
      : 'no test file named';
  if (action === 'settle') {
    const member = pending[0]!;
    const transition = {
      code: 'CHECK_FAILED',
      message: `Shared run ${failure.runId} on exact current main held only this member; it settles without rechecking the same tree alone.`,
    };
    await writeBatch(ctx, key, { ...batch, phase: 'failed', failure, transition });
    if (batch.included) await settleBatchConflicts(ctx, key, { ...batch, phase: 'failed' });
    const { batchId: _batch, ...state } = member.state;
    void _batch;
    const next = {
      ...state,
      batchOriginId: batch.id,
      version: state.version + 1,
      phase: 'terminal-failed' as const,
      observation: landingObservation('failed'),
      ...(run.testFiles ? { testFiles: run.testFiles } : {}),
      batchDiagnostic: diagnostic(failure, true, `${transition.message} Failing: ${files}.`),
      error: {
        code: 'CHECK_FAILED',
        message: `The exact check on current main settled as failed. Failing: ${files}`,
      },
    };
    await writeLanding(ctx, member.row, next, false);
    await settleLandingOperation(ctx, next);
    return true;
  }
  await retryLandingBatch(ctx, key, {
    ...batch,
    failure,
    transition: {
      code: 'STACKED_FAILURE_UNSTACKED',
      message: `Shared run ${failure.runId} failed on files no member of this group changed while its predecessor ${batch.predecessor!.submissionId} had not passed; the group recomposes once on current main without it.`,
    },
  });
  for (const member of pending) {
    const current = await loadLanding(ctx, { projectId: key.projectId, submissionId: member.state.id });
    if (current.state.phase === 'landed' || current.state.phase === 'terminal-failed') continue;
    await writeLanding(
      ctx,
      current.row,
      {
        ...current.state,
        version: current.state.version + 1,
        batchDiagnostic: diagnostic(
          failure,
          false,
          `Shared run ${failure.runId} failed (${files}) on files this group did not change, stacked on unpassed predecessor ${batch.predecessor!.submissionId}. Recomposing once on current main without it; a further failure splits as usual.`,
        ),
      },
      false,
    );
  }
  return true;
}
const diagnostic = (failure: BatchFailure, likelyCulprit: boolean, message: string) => ({
  sharedRunId: failure.runId,
  likelyCulprit,
  failedTests: failure.failedTests,
  waitingFor: null,
  failsTogetherWith: [],
  individualPassed: false,
  coverage: 'unavailable' as const,
  overBudgetPairs: failure.overBudgetPairs,
  message,
});
