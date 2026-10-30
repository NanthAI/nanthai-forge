// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { BatchIdentity, LandingBatch } from './projectHostedLandingBatchStore';
import { loadLanding, writeLanding } from './projectHostedLandingStore';
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
    const { batchId: _batch, ...state } = current.state;
    void _batch;
    const terminal = state.phase === 'terminal-failed';
    const solo = terminal || state.batchSolo === true;
    await writeLanding(
      ctx,
      current.row,
      {
        ...state,
        batchOriginId: batch.id,
        batchSolo: true,
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
      !terminal && (!solo || current.row.runnable),
    );
    const finish = await finishRow(ctx, { projectId: input.projectId, submissionId: state.id });
    if (finish && !terminal) await scheduleFinish(ctx, finish);
    released = true;
  }
  if (released) await wakeLandingQueue(ctx, { projectId: input.projectId, channel: 'main' });
}
