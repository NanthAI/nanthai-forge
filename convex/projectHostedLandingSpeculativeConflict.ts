// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { cancelPendingTask } from './schedulerCancel';
import type { MutationCtx } from './_generated/server';
import type { BatchIdentity, LandingBatch } from './projectHostedLandingBatchState';
import type { BatchDropped } from '../src/hosted-landing-batch';
import { predecessorLane } from './projectHostedEarlyResolution';
import { pipelinePredecessor } from './projectHostedLandingPipeline';
import { landingQueue, loadLandingAttempt } from './projectHostedLandingStore';
import { landingRow, loadLanding, writeLanding } from './projectHostedLandingStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import { predecessorConflictAdvice } from '../src/hosted-would-conflict';
import type { HostedLandingAttempt } from '../src/hosted-landing';

/** A speculative rejection is advice, never terminal evidence. Park only the
 * rejected members of this bounded cohort on the predecessor's existing order-settlement event. No run,
 * replacement attempt, periodic wake or per-member Convex call is allocated. */
export async function deferSpeculativeConflict(
  ctx: MutationCtx,
  input: BatchIdentity,
  batch: LandingBatch,
  dropped: BatchDropped,
  // For an internal prefix, use the included tail's existing settlement event.
  waitFor = batch.predecessor,
) {
  const prepared = await (async () => {
    try {
      if (!waitFor) return;
      const members = batch.members.filter(member =>
        dropped.some(drop => drop.candidateId === member.candidate.id),
      );
      const loaded = await Promise.all(
        members.map(member =>
          loadLanding(ctx, { projectId: input.projectId, submissionId: member.submissionId }),
        ),
      );
      // Replaying the same signed source result retains its existing event owner and advice.
      // Do not walk the train, reread history or rewrite observations on an idempotent replay.
      if (
        loaded.length &&
        loaded.every(({ row, state }) => {
          const advice = row.wouldConflict ? JSON.parse(row.wouldConflict) : null;
          return (
            state.batchId === batch.id &&
            state.phase === 'queued' &&
            !row.alarm &&
            advice?.resolution &&
            advice.at === batch.at &&
            row.orderWait === advice.predecessor?.submissionId
          );
        })
      )
        return;
      const queue = await landingQueue(ctx, { projectId: input.projectId, channel: 'main' });
      const prefix = await pipelinePredecessor(
        ctx,
        { projectId: input.projectId, channel: 'main' },
        undefined,
        undefined,
        {
          queue,
          pins: [waitFor],
          requireSlot: false,
          excludeIds: batch.members
            .map(member => member.submissionId)
            .filter(id => id !== waitFor!.submissionId),
        },
      );
      if (!prefix) return;
      waitFor = prefix;
      const early = batch.members[0]!.policy.acceptance.earlyResolve !== 'off';
      const predecessor = await loadLanding(ctx, {
        projectId: input.projectId,
        submissionId: waitFor.submissionId,
      });
      const laneId = await predecessorLane(
        ctx,
        input.projectId,
        predecessor.state.id,
        predecessor.state,
      ).catch(() => null);
      return { members, loaded, early, predecessor, laneId, waitFor };
    } catch {
      // Optional reads leave the retained cohort's ordinary wait authoritative.
      return null;
    }
  })();
  if (!prepared) return;
  const { members, loaded, early, predecessor, laneId, waitFor: prefix } = prepared;
  const watch = canonicalPayload(prefix);
  // Install the settlement owner before parking any member. A write or later read
  // failure must escape and roll back the entire mutation, never commit half advice.
  if (!predecessor.row.orderWaited || predecessor.row.earlyResolveWatch !== watch)
    await ctx.db.patch(predecessor.row._id, { orderWaited: true, earlyResolveWatch: watch });
  for (const [index, member] of members.entries()) {
    const conflict = dropped.find(drop => drop.candidateId === member.candidate.id);
    const { row, state } = loaded[index]!;
    if (state.phase === 'landed' || state.phase === 'terminal-failed') continue;
    let current = row;
    if (conflict) {
      const paths = conflict.paths ?? [],
        more = conflict.more ?? 0;
      const advice = canonicalPayload(
        predecessorConflictAdvice({
          early,
          predecessor: { ...prefix, groupId: predecessor.state.batchId ?? predecessor.state.id },
          ...(laneId ? { laneId } : {}),
          paths,
          more,
          at: batch.at,
          operationId: state.operationId,
        }),
      );
      if (row.wouldConflict !== advice) {
        await writeLanding(
          ctx,
          { ...row, wouldConflict: advice },
          { ...state, version: state.version + 1 },
          false,
        );
        current = (await landingRow(ctx, { projectId: input.projectId, submissionId: state.id }))!;
      }
    }
    // The predecessor owns rejected-member progress. Relinquish their alarms
    // so a stale compose alarm cannot split independently checking survivors.
    if (current.alarm) await cancelPendingTask(ctx, current.alarm.taskId);
    if (current.alarm || current.orderWait !== predecessor.state.id)
      await ctx.db.patch(current._id, {
        alarm: null,
        orderWait: predecessor.state.id,
      });
  }
}

/** Internal rejections need the checked survivor, whose bytes contain their conflict.
 * The outer predecessor can be disjoint; it owns only outer-base rejections. */
export async function deferCohortConflicts(
  ctx: MutationCtx,
  input: BatchIdentity,
  batch: LandingBatch,
  dropped: BatchDropped,
  checkedTail?: HostedLandingAttempt,
) {
  const outer = dropped.filter(drop => drop.againstMain);
  if (outer.length && batch.predecessor) await deferSpeculativeConflict(ctx, input, batch, outer);
  const internal = dropped.filter(drop => !drop.againstMain);
  if (!internal.length) return;
  try {
    if (!checkedTail) {
      const tail = batch.members.filter(member => batch.included?.includes(member.submissionId)).at(-1);
      if (!tail) return;
      const current = await loadLanding(ctx, { projectId: input.projectId, submissionId: tail.submissionId });
      if (!['checking', 'ready'].includes(current.state.phase) || current.state.batchId !== batch.id) return;
      checkedTail = await loadLandingAttempt(ctx, {
        projectId: input.projectId,
        attemptId: current.state.attemptId,
      });
    }
  } catch {
    return; // Optional survivor metadata is unavailable; no member has been parked.
  }
  if (!checkedTail.candidate.head || !checkedTail.check) return;
  await deferSpeculativeConflict(ctx, input, batch, internal, {
    submissionId: checkedTail.submissionId,
    head: checkedTail.candidate.head,
    receiptId: checkedTail.operations.accept,
  });
}
