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
import { type BatchIdentity, type LandingBatch } from './projectHostedLandingBatchState';
import { hostedLandingStateSchema } from '../src/hosted-landing';
import { hostedBatching, hostedPipelineWidth } from '../src/hosted-landing-batch';
import { invalidatePipeline as retirePipeline } from './projectHostedLandingPipelineInvalidation';

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
  if (tail.pipelineRetiredAttemptId === tail.attemptId) return undefined;
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
  const { row, state } = await loadLanding(ctx, {
    projectId: input.projectId,
    submissionId: batch.predecessor.submissionId,
  });
  if (row.pipelineRetiredAttemptId === state.attemptId) return 'invalid' as const;
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

/** Cohort and solo transitions retire descendants through the same path. */
export function invalidatePipeline(
  ctx: MutationCtx,
  input: BatchIdentity,
  batch: { members: { submissionId: string }[] },
  retireMembers = false,
) {
  return retirePipeline(
    ctx,
    input,
    batch,
    {
      loadLanding,
      loadLandingAttempt,
      insertLandingAttempt,
      writeLanding,
    },
    retireMembers,
  );
}
