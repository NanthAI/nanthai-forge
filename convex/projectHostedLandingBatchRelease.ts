// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { BatchIdentity, LandingBatch } from './projectHostedLandingBatchStore';
import { loadLanding, loadLandingAttempt, writeLanding } from './projectHostedLandingStore';
import { individualLandingRun } from './projectHostedLandingIndividual';
import { finishRow, scheduleFinish } from './projectHostedFinishWake';
import { wakeLandingQueue } from './projectHostedLandingWake';
import { landingObservation } from '../src/hosted-landing';

/** Runs inside the batch state transaction. No pending member depends on a
 * leader retaining batchId; immutable origin keeps diagnostics and serial order. */
export async function releaseBatchMembers(ctx: MutationCtx, input: BatchIdentity, batch: LandingBatch) {
  let released = false;
  for (const member of batch.members) {
    const current = await loadLanding(ctx, { projectId: input.projectId, submissionId: member.submissionId });
    if (current.state.phase === 'landed' || current.state.batchId !== batch.id) continue;
    const { batchId: _batch, batchNeedsSoloCompose: needsCompose, ...state } = current.state;
    void _batch;
    const terminal = state.phase === 'terminal-failed';
    const run =
      !terminal && current.row.runId
        ? await individualLandingRun(
            ctx,
            input.projectId,
            await loadLandingAttempt(ctx, { projectId: input.projectId, attemptId: state.attemptId }),
            member.candidate,
          )
        : null;
    const solo =
      terminal || Boolean(run) || (state.batchSolo === true && !needsCompose && !current.row.runId);
    await writeLanding(
      ctx,
      current.row,
      {
        ...state,
        batchOriginId: batch.id,
        batchSolo: true,
        ...(run
          ? {
              phase: run.status === 'passed' ? ('ready' as const) : ('checking' as const),
              observation: landingObservation(run.status === 'passed' ? 'queued' : 'checking'),
              error: null,
            }
          : needsCompose
            ? { batchNeedsSoloCompose: needsCompose }
            : {}),
        ...(!solo
          ? {
              batchNeedsSoloCompose: true as const,
              phase: 'queued' as const,
              observation: landingObservation('queued'),
              error: null,
            }
          : {}),
        version: state.version + 1,
      },
      !terminal && (Boolean(run) || !solo || current.row.runnable),
    );
    const finish = await finishRow(ctx, { projectId: input.projectId, submissionId: state.id });
    if (finish && !terminal) await scheduleFinish(ctx, finish);
    released = true;
  }
  if (released) await wakeLandingQueue(ctx, { projectId: input.projectId, channel: 'main' });
}
