// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { BatchIdentity, LandingBatch } from './projectHostedLandingBatchState';
import { prepareBatchCompose } from './projectHostedLandingBatchCompose';
import { retryLandingBatch, writeBatch } from './projectHostedLandingBatchStore';
import { deferSpeculativeConflict } from './projectHostedLandingSpeculativeConflict';
import { predecessorStatus } from './projectHostedLandingPipeline';
import { hostedStartMain } from './projectHostedChannels';
import { landingQueue, loadLanding, writeLanding } from './projectHostedLandingStore';
import { retainBatchConflict } from './projectHostedLandingBatchConflict';
import { batchConflictPeers } from './projectHostedLandingConflictPeers';
import { loadFinish } from './projectHostedFinishStore';
import { reserveFinishRetry } from './projectHostedFinishCompose';
import { scheduleFinish } from './projectHostedFinishWake';

/** Rejected members wait outside the checking train. Its tail is the last
 * included acceptance receipt, even when the original last member conflicts. */
export async function retainSurvivorTrain(
  ctx: MutationCtx,
  input: BatchIdentity,
  included: string[],
  batch: LandingBatch,
) {
  if (included.length === batch.members.length) return;
  const queue = await landingQueue(ctx, { projectId: input.projectId, channel: 'main' });
  if (!queue?.train) return;
  const rejected = new Set(
    batch.members.map(member => member.submissionId).filter(id => !included.includes(id)),
  );
  await ctx.db.patch(queue._id, { train: queue.train.filter(id => !rejected.has(id)) });
}

/** Consume the same immutable source generation on predecessor settlement.
 * Only rejected entries are resumed. Clean peers retain their original check.
 * If current main has since moved, only the rejected selection recomposes. */
export async function settleBatchConflicts(ctx: MutationCtx, input: BatchIdentity, batch: LandingBatch) {
  const predecessor = await predecessorStatus(ctx, input, batch);
  if (predecessor === 'invalid') {
    await retryLandingBatch(ctx, input, batch);
    return;
  }
  const source = await prepareBatchCompose(ctx, input);
  if (source.operation.terminal?.outcome.status !== 'completed') return;
  const dropped = source.state.dropped ?? [];
  if (predecessor === 'pending') {
    await deferSpeculativeConflict(ctx, input, batch, dropped);
    return;
  }
  const main = await hostedStartMain(ctx, input.projectId);
  const exact =
    main.head === source.state.request.expectedMain.head &&
    main.receipt.id === source.state.request.expectedMain.receiptId;
  for (const member of batch.members.filter(member => !batch.included?.includes(member.submissionId))) {
    const current = await loadLanding(ctx, { projectId: input.projectId, submissionId: member.submissionId });
    if (current.state.batchId !== batch.id || ['landed', 'terminal-failed'].includes(current.state.phase))
      continue;
    const conflict = dropped.find(drop => drop.candidateId === member.candidate.id);
    if (!conflict) continue;
    if (exact) {
      await retainBatchConflict(ctx, {
        projectId: input.projectId,
        member,
        main: source.state.request.expectedMain,
        conflict,
        ownerInputs: source.state.ownerProvenance === 1 && source.state.ownerInputs === true,
        peerLanes: await batchConflictPeers(
          ctx,
          input.projectId,
          batch,
          member.candidate.id,
          dropped.map(drop => drop.candidateId),
        ),
        at: batch.at,
      });
    } else {
      const { batchId: _batch, ...state } = current.state;
      void _batch;
      await writeLanding(
        ctx,
        current.row,
        { ...state, batchOriginId: batch.id, batchSolo: true, version: state.version + 1 },
        false,
      );
      const finish = await loadFinish(ctx, { projectId: input.projectId, submissionId: member.submissionId });
      if (!finish.value.pending) await reserveFinishRetry(ctx, finish.row, finish.value, 'BATCH_FALLBACK');
      else await scheduleFinish(ctx, finish.row);
    }
  }
  if (!batch.included?.length) await writeBatch(ctx, input, { ...batch, phase: 'landed' });
}
