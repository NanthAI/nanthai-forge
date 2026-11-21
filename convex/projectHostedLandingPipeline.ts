// SPDX-License-Identifier: Apache-2.0
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { LandingChannel, LandingRow } from './projectHostedLandingStore';
import {
  landingQueue,
  landingRow,
  loadLanding,
  loadLandingAttempt,
  forkLandingAttempt,
  insertLandingAttempt,
  writeLanding,
} from './projectHostedLandingStore';
import { loadBatch, type BatchIdentity, type LandingBatch } from './projectHostedLandingBatchState';
import { storedLandingStateSchema, type HostedLandingAttempt } from '../src/hosted-landing';
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
  ctx: QueryCtx | MutationCtx,
  input: LandingChannel,
  selected?: LandingRow[],
  onSelected?: (row: LandingRow, attempt: HostedLandingAttempt) => void,
  options: {
    queue?: Doc<'projectHostedLandingQueues'> | null;
    excludeIds?: string[];
    pins?: { submissionId: string; head: string; receiptId: string }[];
    requireSlot?: boolean;
    onCapacity?: (full: boolean) => void;
    onBlocked?: (row: LandingRow) => void;
  } = {},
) {
  const live =
    selected ??
    (
      await Promise.all(
        (options.queue ?? (await landingQueue(ctx, input)))?.train
          ?.filter(id => !options.excludeIds?.includes(id))
          .map(submissionId => landingRow(ctx, { projectId: input.projectId, submissionId })) ?? [],
      )
    ).filter(livePipelineRow);
  const blocked = () => {
    const tail = live.at(-1);
    if (tail) options.onBlocked?.(tail);
    return undefined;
  };
  const states = live.map(row => storedLandingStateSchema.parse(JSON.parse(row.value)));
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
    return blocked();
  const tail = rows.at(-1)!;
  if (tail.pipelineRetiredAttemptId === tail.attemptId) return blocked();
  const attempt = await loadLandingAttempt(ctx, { projectId: input.projectId, attemptId: tail.attemptId });
  const groups = new Set(states.map(state => state.batchId ?? state.id));
  options.onCapacity?.(groups.size >= hostedPipelineWidth(attempt.policy));
  if (
    !hostedBatching(attempt.policy) ||
    (options.requireSlot !== false && groups.size >= hostedPipelineWidth(attempt.policy)) ||
    (!attempt.check && !liveAdmission(tail)) ||
    !attempt.candidate.head
  )
    return blocked();
  // A pin is an acceptance precondition, never a side-branch compose base. Both advice
  // and composition use this same fixed tail and its exact predecessor chain.
  const pending = new Map((options.pins ?? []).map(pin => [pin.submissionId, pin]));
  let current = {
    submissionId: tail.submissionId,
    head: attempt.candidate.head,
    receiptId: attempt.operations.accept,
  };
  let state = storedLandingStateSchema.parse(JSON.parse(tail.value));
  for (let depth = 0; pending.size && depth <= live.length; depth++) {
    const required = pending.get(current.submissionId);
    if (required?.head === current.head && required.receiptId === current.receiptId)
      pending.delete(current.submissionId);
    if (!pending.size) break;
    if (!state.batchId) return blocked();
    const group = (await loadBatch(ctx, { projectId: input.projectId, batchId: state.batchId })).batch;
    // Every included cohort member owns its own acceptance receipt for the same checked State.
    // Its exact pin is contained even when another member is the train tail.
    for (const pin of pending.values()) {
      if (
        pin.head !== current.head ||
        !group.members.some(member => member.submissionId === pin.submissionId) ||
        (group.included && !group.included.includes(pin.submissionId))
      )
        continue;
      const member =
        live.find(row => row.submissionId === pin.submissionId) ??
        (await landingRow(ctx, { projectId: input.projectId, submissionId: pin.submissionId }));
      if (!member || member.pipelineRetiredAttemptId === member.attemptId) continue;
      const exact = await loadLandingAttempt(ctx, {
        projectId: input.projectId,
        attemptId: member.attemptId,
      });
      if (
        exact.candidate.head === pin.head &&
        exact.operations.accept === pin.receiptId &&
        group.runId &&
        exact.check?.runId === group.runId
      )
        pending.delete(pin.submissionId);
    }
    if (!pending.size) break;
    const previous = group.predecessor;
    if (!previous) return blocked();
    const pin = pending.get(previous.submissionId);
    if (pin?.head === previous.head && pin.receiptId === previous.receiptId)
      pending.delete(previous.submissionId);
    if (!pending.size) break;
    const parent = await loadLanding(ctx, {
      projectId: input.projectId,
      submissionId: previous.submissionId,
    });
    const exact = await loadLandingAttempt(ctx, {
      projectId: input.projectId,
      attemptId: parent.state.attemptId,
    });
    if (exact.candidate.head !== previous.head || exact.operations.accept !== previous.receiptId)
      return blocked();
    current = previous;
    state = parent.state;
  }
  if (pending.size) return blocked();
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
      forkLandingAttempt,
      insertLandingAttempt,
      writeLanding,
    },
    retireMembers,
    undefined,
    ownerHold,
  );
}
