// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation } from './server';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { HostedLandingAttempt, HostedLandingState } from '../src/hosted-landing';
import { hostedLandingStateSchema } from '../src/hosted-landing';
import { HOSTED_BATCH_MEMBERS, HOSTED_TRAIN_HOLD_MS, hostedBatching } from '../src/hosted-landing-batch';
import { preQueueCheck } from '../src/hosted-landing-admission';
import { holdsLandingOrder } from './projectHostedLandingOrder';
import { wakeLandingQueue } from './projectHostedLandingEvents';
import { wakeLandingOrderWaiters } from './projectHostedFinishWake';

/** Cohort hold (Issue 10b0a94b; model `prequeue-cohort`, litmus `cohorthold`).
 * Admitted changes each try their own Lane run first. On a moved main every
 * refused one recomposed and formed its cohort before its peers had tried, so a
 * wave of 8 was re-checked as 7 groups. A refused member now waits while a peer
 * that entered the queue before its hold is still deciding its own proof, then
 * all of them form one cohort.
 * - Bounded: one hold per admission, at most HOSTED_TRAIN_HOLD_MS. Later
 *   arrivals never extend it.
 * - No order cycle: a held entry holds no queue order (peers it waits for publish
 *   only after the older entries ahead of them) and wakes its order waiters.
 * - Released in the transaction that ends the last such decision. The one-shot
 *   wake at the bound is armed with the hold, so a lost release drive is re-driven
 *   (c329d191); a wake refused by a write outage is re-driven on resume (72d50375).
 * Holding only happens during a wave; idle costs nothing. */
type Row = Doc<'projectHostedLandingRequests'>;
const END = makeFunctionReference<'mutation'>('projectHostedLandingCohortHold:end');

/** The row's `deciding` value: its admission end while it is an admitted change
 * that has not tried its Lane run, or is still bound to it (exact on unchanged
 * main, carried by proved reuse, or refused at publication). */
export function decidingSince(
  row: Pick<Row, 'admission'>,
  state: HostedLandingState,
  attempt: HostedLandingAttempt,
  orderLive: boolean,
) {
  const admission = row.admission;
  if (!admission?.full || admission.status !== 'passed' || state.batchId || state.batchSolo) return undefined;
  if (!orderLive || (state.phase !== 'queued' && state.phase !== 'ready')) return undefined;
  if (admission.reuse && attempt.check?.runId !== admission.runId) return undefined;
  return admission.endedAt ?? Date.parse(state.at);
}
/** Waiting for peers: not runnable and holding no queue order. */
export const cohortHeld = (row: Pick<Row, 'admission'>, state: HostedLandingState, runnable: boolean) =>
  Boolean(row.admission?.hold && !row.admission.hold.done && !runnable) &&
  state.phase === 'queued' &&
  !state.batchId;

/** Before a refused admitted member forms its cohort: hold while an earlier peer
 * decides. One indexed read; one scheduled wake per admission at most. */
export async function holdForPeers(
  ctx: MutationCtx,
  selected: {
    row: Row;
    state: HostedLandingState;
    attempt: HostedLandingAttempt;
  },
) {
  const { row, state, attempt } = selected;
  const admission = row.admission;
  if (
    !preQueueCheck(attempt.policy) ||
    !hostedBatching(attempt.policy) ||
    attempt.policy.acceptance.batchMaxSize === 1 ||
    !admission?.full ||
    admission.reuse !== 'tried' ||
    admission.hold ||
    !attempt.deferredCheck ||
    state.batchId ||
    state.batchSolo
  )
    return false;
  const since = Date.now();
  const [peer] = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_deciding', q =>
      q.eq('projectId', row.projectId).eq('channel', 'main').gt('deciding', 0).lte('deciding', since),
    )
    .take(1);
  if (!peer) return false;
  const taskId = await ctx.scheduler.runAfter(HOSTED_TRAIN_HOLD_MS, END, {
    projectId: row.projectId,
    submissionId: row.submissionId,
  });
  await ctx.db.patch(row._id, {
    runnable: false,
    orderLive: undefined,
    orderWaited: undefined,
    admission: { ...admission, hold: { since, taskId } },
  });
  // Peers parked behind this entry's place would otherwise wait for it forever.
  if (row.orderWaited) await wakeLandingOrderWaiters(ctx, row);
  return true;
}
async function release(ctx: MutationCtx, row: Row) {
  const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
  await ctx.db.patch(row._id, {
    runnable: true,
    orderLive: holdsLandingOrder(row, state) ? true : undefined,
    admission: {
      ...row.admission!,
      hold: { ...row.admission!.hold!, done: true },
    },
  });
}
/** A peer stopped deciding (called from its own write). Release every held entry
 * that no remaining decision is older than: one indexed read for the oldest
 * remaining decision and one bounded window of queued batchable entries. An
 * entry outside the window is released by its own wake at the bound. */
export async function releaseCohortHolds(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const [oldest] = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_deciding', q =>
      q.eq('projectId', projectId).eq('channel', 'main').gt('deciding', 0),
    )
    .take(1);
  const rows = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_batchable_and_phase_and_sequence', q =>
      q.eq('projectId', projectId).eq('channel', 'main').eq('batchable', true).eq('phase', 'queued'),
    )
    .take(2 * HOSTED_BATCH_MEMBERS);
  let released = false;
  for (const row of rows) {
    const hold = row.admission?.hold;
    if (row.runnable || !hold || hold.done || (oldest && oldest.deciding! <= hold.since)) continue;
    await release(ctx, row);
    released = true;
  }
  if (released) await wakeLandingQueue(ctx, { projectId, channel: 'main' });
}
/** The hold's bound. Releases a still-held entry; a released one that is still
 * waiting for its cohort gets the queue wake its release may have lost. */
export const end = internalMutation({
  args: { projectId: v.id('hostedProjects'), submissionId: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const row = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_submission', q =>
        q.eq('projectId', input.projectId).eq('submissionId', input.submissionId),
      )
      .unique();
    if (!row?.admission?.hold || row.phase !== 'queued') return null;
    const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
    if (state.batchId) return null;
    if (!row.admission.hold.done && !row.runnable) await release(ctx, row);
    else if (!row.runnable) return null;
    await wakeLandingQueue(ctx, {
      projectId: input.projectId,
      channel: 'main',
    });
    return null;
  },
});
/** Write-outage re-drive (72d50375): the hold's wake threw. Re-arm it at the
 * remaining bound; the same identity, nothing else is repeated. */
export async function redriveCohortHold(ctx: MutationCtx, row: Row) {
  const hold = row.admission?.hold;
  if (!hold || hold.done || row.phase !== 'queued') return false;
  const task = await ctx.db.system.get(hold.taskId);
  if (task && task.state.kind !== 'failed') return false;
  const taskId = await ctx.scheduler.runAfter(
    Math.max(0, hold.since + HOSTED_TRAIN_HOLD_MS - Date.now()),
    END,
    { projectId: row.projectId, submissionId: row.submissionId },
  );
  await ctx.db.patch(row._id, {
    admission: { ...row.admission!, hold: { ...hold, taskId } },
  });
  return true;
}
