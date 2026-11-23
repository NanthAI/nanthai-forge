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
    /** Sequence of a runnable entry older than every live train entry. When every train group has
     * passed (none holds a runner), they all wait for it in landing order, so it is dispatched
     * without a free slot (Item 273650ab shape 2): requiring one left nothing able to move until the
     * stall alarm. Dispatch only: batch formation still finds no slot, so it composes on main and
     * never publishes after the groups that wait for it. */
    ahead?: number;
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
  const ahead = options.ahead;
  const heads = ahead !== undefined && live.every(row => row.sequence > ahead && row.phase === 'ready');
  if (
    !hostedBatching(attempt.policy) ||
    (options.requireSlot !== false && !heads && groups.size >= hostedPipelineWidth(attempt.policy)) ||
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

/** Deciding peers read past `own` before the slot counts as taken (more stay unread). */
const PIPELINE_DECIDING_READS = 4;

/** No free check slot for a main-race recheck of `own` (10b0a94b, owner option B 2026-11-22),
 * counted only for entries that can take main first (Item 196d5e4e option C, lead 2026-11-23): an
 * admitted peer still deciding its own Lane run (reuse or publication undecided, so it may yet need
 * the slot), or a retained train at the pipeline width. A holder waits for the recheck, and so moves
 * no main under it, only when the landing order rules (`olderLandingAhead`) hold it there whatever its
 * paths: it is newer than every `own` entry and not urgent ahead of it, every `own` entry holds strict
 * order (it already gave its bounded overtake step to an earlier generation, `overtakeOlder`; until
 * then an independent newer pass may take main first), and it has not passed yet (a pass from before
 * this generation may still go ahead, `generationStartedAfterPass`). Then the scoped run has nothing
 * to lose. The queue's own count, any runner (BYOCI). Reads: deciding rows up to
 * `PIPELINE_DECIDING_READS` past `own` (the checked submissions, which may still carry their own
 * stamp while they recompose, and whose own train slots count as free; an unread peer may land first,
 * so more of them keep the full run); `own`'s rows once a peer or a full train needs ordering; the
 * train rows only when the train is at width, which the tick reads anyway. */
export async function pipelineFull(
  ctx: QueryCtx | MutationCtx,
  input: LandingChannel,
  policy: HostedLandingAttempt['policy'],
  own: readonly string[] = [],
) {
  let mine: LandingRow[] | undefined;
  // Without its own rows (none named, or none found) every peer may land first.
  const landsFirst = async (other: LandingRow) => {
    mine ??= (
      await Promise.all(
        own.map(submissionId => landingRow(ctx, { projectId: input.projectId, submissionId }, false)),
      )
    ).filter((row): row is LandingRow => row !== null);
    if (!mine.length) return true;
    const strict = mine.every(row => row.overtaken !== undefined);
    const urgent = mine.some(row => row.priority === 'urgent');
    return (
      !strict ||
      (other.priority === 'urgent' && !urgent) ||
      other.sequence < Math.max(...mine.map(row => row.sequence)) ||
      other.passedAt !== undefined ||
      other.phase === 'ready'
    );
  };
  let peers = 0;
  for await (const row of ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_deciding', q =>
      q.eq('projectId', input.projectId).eq('channel', input.channel).gt('deciding', 0),
    )) {
    if (own.includes(row.submissionId)) continue;
    if (++peers > PIPELINE_DECIDING_READS || (await landsFirst(row))) return true;
  }
  // A recheck replaces its own run, so its own train slot is free to it (keep-the-run scoped recheck).
  const train = ((await landingQueue(ctx, input))?.train ?? []).filter(id => !own.includes(id));
  const width = hostedPipelineWidth(policy);
  if (train.length < width) return false;
  const rows = (
    await Promise.all(
      train.map(submissionId => landingRow(ctx, { projectId: input.projectId, submissionId })),
    )
  ).filter(livePipelineRow);
  const groups = new Set(
    rows.map(row => storedLandingStateSchema.parse(JSON.parse(row.value)).batchId ?? row.submissionId),
  );
  if (groups.size < width) return false;
  for (const row of rows) if (await landsFirst(row)) return true;
  return false;
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
