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
import { hostedLandingStateSchema, type HostedLandingAttempt } from '../src/hosted-landing';
import { hostedBatching, hostedPipelineWidth } from '../src/hosted-landing-batch';
import { landingSuspect } from '../src/hosted-landing-suspect';
import { invalidatePipeline as retirePipeline } from './projectHostedLandingPipelineInvalidation';

export const livePipelineRow = (row: LandingRow | null): row is LandingRow =>
  Boolean(row && row.phase !== 'landed' && row.phase !== 'terminal-failed');

// A refused admission keeps its historical metadata but no longer owns its
// predicted head. Only the live original admission or its bound exact run may
// bridge the checking -> queued -> ready transition.
const liveAdmission = (row: LandingRow) =>
  row.admission?.full &&
  ['checking', 'passed'].includes(row.admission.status) &&
  (!row.admission.reuse || row.runId === row.admission.runId);

/** Read only the bounded retained train, never the active queue or history. A
 * tail becomes a base only after its exact head and acceptance IDs are fixed. */
export async function pipelinePredecessor(
  ctx: MutationCtx,
  input: LandingChannel,
  selected?: LandingRow[],
  onSelected?: (row: LandingRow, attempt: HostedLandingAttempt) => void,
) {
  const live =
    selected ??
    (
      await Promise.all(
        (await landingQueue(ctx, input))?.train?.map(submissionId =>
          landingRow(ctx, { projectId: input.projectId, submissionId }),
        ) ?? [],
      )
    ).filter(livePipelineRow);
  const states = live.map(row => hostedLandingStateSchema.parse(JSON.parse(row.value)));
  // A suspect (51bbbd00) still checks, but nothing stacks on its unproven head.
  // Its descendants retired when it became suspect, so the rest of the train
  // never contains its changes. It still occupies an execution slot below.
  const rows = live.filter(
    (_, index) =>
      !landingSuspect(states[index]!) && states[index]!.observation.pendingReason !== 'waiting-for-review',
  );
  if (
    !rows.length ||
    rows.some(
      row =>
        row.hold ||
        (row.phase !== 'checking' &&
          row.phase !== 'ready' &&
          !(row.phase === 'queued' && liveAdmission(row))),
    )
  )
    return undefined;
  const tail = rows.at(-1)!;
  if (tail.pipelineRetiredAttemptId === tail.attemptId) return undefined;
  const attempt = await loadLandingAttempt(ctx, { projectId: input.projectId, attemptId: tail.attemptId });
  const groups = new Set(states.map(state => state.batchId ?? state.id));
  if (
    !hostedBatching(attempt.policy) ||
    groups.size >= hostedPipelineWidth(attempt.policy) ||
    (!attempt.check && !liveAdmission(tail)) ||
    !attempt.candidate.head
  )
    return undefined;
  onSelected?.(tail, attempt);
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
  if (state.observation.pendingReason === 'waiting-for-review') return 'invalid' as const;
  if (row.pipelineRetiredAttemptId === state.attemptId) return 'invalid' as const;
  if (state.phase === 'landed')
    return state.acceptance?.head === batch.predecessor.head &&
      state.acceptance.receiptId === batch.predecessor.receiptId
      ? ('landed' as const)
      : ('invalid' as const);
  if (
    state.phase !== 'checking' &&
    state.phase !== 'ready' &&
    !(state.phase === 'queued' && (state.batchId || liveAdmission(row)))
  )
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
  ownerHold = false,
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
    undefined,
    ownerHold,
  );
}
