// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { LandingChannel, LandingRow } from './projectHostedLandingStore';
import {
  landingQueue,
  landingRow,
  loadLanding,
  loadLandingAttempt,
  insertLandingAttempt,
  writeLanding,
} from './projectHostedLandingStore';
import { loadBatch, type BatchIdentity, type LandingBatch } from './projectHostedLandingBatchState';
import { hostedLandingStateSchema, landingObservation } from '../src/hosted-landing';
import { hostedBatching, hostedPipelineWidth } from '../src/hosted-landing-batch';
import { canonicalPayload } from '../src/hosted-source-operation';
import { wakeLandingQueue } from './projectHostedLandingEvents';

export const livePipelineRow = (row: LandingRow | null): row is LandingRow =>
  Boolean(row && row.phase !== 'landed' && row.phase !== 'terminal-failed');

/** Read only the bounded retained train, never the active queue or history. A
 * tail becomes a base only after its exact head and acceptance IDs are fixed. */
export async function pipelinePredecessor(ctx: MutationCtx, input: LandingChannel, selected?: LandingRow[]) {
  const rows =
    selected ??
    (
      await Promise.all(
        (await landingQueue(ctx, input))?.train?.map(submissionId =>
          landingRow(ctx, { projectId: input.projectId, submissionId }),
        ) ?? [],
      )
    ).filter(livePipelineRow);
  if (!rows.length || rows.some(row => row.hold || (row.phase !== 'checking' && row.phase !== 'ready')))
    return undefined;
  const tail = rows.at(-1)!;
  const state = hostedLandingStateSchema.parse(JSON.parse(tail.value));
  const attempt = await loadLandingAttempt(ctx, { projectId: input.projectId, attemptId: tail.attemptId });
  const groups = new Set(
    rows.map(row => {
      const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
      return state.batchId ?? state.id;
    }),
  );
  if (
    !hostedBatching(attempt.policy) ||
    groups.size >= hostedPipelineWidth(attempt.policy) ||
    state.batchSolo ||
    !attempt.check ||
    !attempt.candidate.head
  )
    return undefined;
  return {
    submissionId: tail.submissionId,
    head: attempt.candidate.head,
    receiptId: attempt.operations.accept,
  };
}

/** Pending predecessors are allowed during source/check preparation, never at
 * publication. Their reserved receipt and head must remain the same generation. */
export async function predecessorStatus(ctx: MutationCtx, input: BatchIdentity, batch: LandingBatch) {
  if (!batch.predecessor) return 'landed' as const;
  const { state } = await loadLanding(ctx, {
    projectId: input.projectId,
    submissionId: batch.predecessor.submissionId,
  });
  if (state.phase === 'landed')
    return state.acceptance?.head === batch.predecessor.head &&
      state.acceptance.receiptId === batch.predecessor.receiptId
      ? ('landed' as const)
      : ('invalid' as const);
  if (state.phase !== 'checking' && state.phase !== 'ready' && !(state.phase === 'queued' && state.batchId))
    return 'invalid' as const;
  const attempt = await loadLandingAttempt(ctx, { projectId: input.projectId, attemptId: state.attemptId });
  return attempt.candidate.head === batch.predecessor.head &&
    attempt.operations.accept === batch.predecessor.receiptId
    ? ('pending' as const)
    : ('invalid' as const);
}

/** Retire only descendants of this generation. Restore each original selection
 * as a new immutable deferred attempt; late source/check callbacks cannot land
 * the discarded stack. All work is bounded by configured width * cohort size. */
export async function invalidatePipeline(ctx: MutationCtx, input: BatchIdentity, batch: LandingBatch) {
  const queue = await landingQueue(ctx, { projectId: input.projectId, channel: 'main' });
  const train = queue?.train ?? [];
  let last = -1;
  for (let index = 0; index < train.length; index++)
    if (batch.members.some(member => member.submissionId === train[index])) last = index;
  if (last < 0 || last === train.length - 1) return false;
  const retired = new Set<string>();
  const invalid = new Set(batch.members.map(member => member.submissionId));
  const removed = new Set<string>();
  for (const submissionId of train.slice(last + 1)) {
    const current = await loadLanding(ctx, { projectId: input.projectId, submissionId });
    if (!livePipelineRow(current.row) || !current.state.batchId || retired.has(current.state.batchId))
      continue;
    const descendant = await loadBatch(ctx, { projectId: input.projectId, batchId: current.state.batchId });
    if (!descendant.batch.predecessor || !invalid.has(descendant.batch.predecessor.submissionId)) continue;
    retired.add(descendant.batch.id);
    for (const member of descendant.batch.members) {
      invalid.add(member.submissionId);
      removed.add(member.submissionId);
    }
    await ctx.db.patch(descendant.row._id, {
      value: canonicalPayload({ ...descendant.batch, phase: 'superseded' }),
    });
    for (const original of descendant.batch.members) {
      const { row, state } = await loadLanding(ctx, {
        projectId: input.projectId,
        submissionId: original.submissionId,
      });
      if (!livePipelineRow(row)) continue;
      const parent = await loadLandingAttempt(ctx, {
        projectId: input.projectId,
        attemptId: state.attemptId,
      });
      const attempt = {
        ...original,
        id: crypto.randomUUID(),
        parentAttemptId: parent.id,
        number: parent.number + 1,
        check: null,
        deferredCheck: true as const,
        operations: { check: crypto.randomUUID(), accept: crypto.randomUUID() },
      };
      await insertLandingAttempt(ctx, attempt);
      const { batchId: _batch, ...rest } = state;
      void _batch;
      await writeLanding(
        ctx,
        row,
        {
          ...rest,
          attemptId: attempt.id,
          version: state.version + 1,
          phase: 'queued',
          observation: landingObservation('queued'),
          error: null,
        },
        true,
      );
    }
  }
  if (!removed.size) return false;
  await ctx.db.patch(queue!._id, { train: train.filter(id => !removed.has(id)) });
  await wakeLandingQueue(ctx, { projectId: input.projectId, channel: 'main' });
  return true;
}
