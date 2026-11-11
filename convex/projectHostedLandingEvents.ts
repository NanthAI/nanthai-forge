// SPDX-License-Identifier: Apache-2.0
import { retainQueueStatus } from './projectHostedQueueStatus';
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { landingTransition } from '../src/hosted-landing';
import type { HostedLandingState } from '../src/hosted-landing';
import { finishPendingForReader, type HostedFinish } from '../src/hosted-finish';
export type LandingChannel = { projectId: Id<'hostedProjects'>; channel: 'main' };
export const landingQueue = (ctx: QueryCtx | MutationCtx, input: LandingChannel) =>
  ctx.db
    .query('projectHostedLandingQueues')
    .withIndex('by_project_and_channel', q => q.eq('projectId', input.projectId).eq('channel', input.channel))
    .unique();
export async function ensureLandingQueue(ctx: MutationCtx, input: LandingChannel) {
  const row = await landingQueue(ctx, input);
  if (row) return row;
  const id = await ctx.db.insert('projectHostedLandingQueues', {
    ...input,
    sequence: 0,
    fence: 0,
    wake: null,
    lease: null,
  });
  return (await ctx.db.get(id))!;
}
/** Mutation scheduling is part of the caller's transaction, including OCC retries.
 * Coalesce a Channel's enqueue/completion wakes; only pending work owns a timer. */
export async function scheduleLandingWake(
  ctx: MutationCtx,
  queue: Doc<'projectHostedLandingQueues'>,
  at: number,
  now = Date.now(),
) {
  if (queue.wake && queue.wake.at <= at) {
    const task = await ctx.db.system.get(queue.wake.taskId);
    if (task?.state.kind === 'pending' || task?.state.kind === 'inProgress') return;
  }
  if (queue.wake) await ctx.scheduler.cancel(queue.wake.taskId);
  const id = crypto.randomUUID();
  const taskId = await ctx.scheduler.runAfter(
    Math.max(0, at - now),
    makeFunctionReference<'action'>('projectHostedLandingDriver:drive'),
    { projectId: queue.projectId, channel: queue.channel, wakeId: id },
  );
  await ctx.db.patch(queue._id, { wake: { taskId, id, at } });
}
export async function wakeLandingQueue(ctx: MutationCtx, input: LandingChannel, now = Date.now()) {
  const queue = await ensureLandingQueue(ctx, input);
  await scheduleLandingWake(
    ctx,
    queue,
    queue.lease && queue.lease.until > now ? queue.lease.until : now,
    now,
  );
}
/** One compact transition per committed state; the request holds the current snapshot. */
export async function recordLandingObservation(
  ctx: MutationCtx,
  state: HostedLandingState,
  pendingAttempt?: unknown,
  wouldConflict?: unknown,
) {
  await retainQueueStatus(ctx, state);
  const finish =
    pendingAttempt === undefined
      ? await ctx.db
          .query('projectHostedFinishes')
          .withIndex('by_project_and_submission', q =>
            q.eq('projectId', state.projectId as Id<'hostedProjects'>).eq('submissionId', state.id),
          )
          .unique()
      : null;
  await ctx.db.insert('projectHostedLandingObservations', {
    projectId: state.projectId as Id<'hostedProjects'>,
    submissionId: state.id,
    version: state.version,
    value: landingTransition({
      submission: state,
      pendingAttempt: finishPendingForReader(
        (pendingAttempt ?? (finish ? JSON.parse(finish.value).pending : null)) as HostedFinish['pending'],
      ),
      ...(wouldConflict ? { wouldConflict } : {}),
    }),
  });
}
