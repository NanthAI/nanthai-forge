// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import {
  ensureLandingQueue,
  landingQueue,
  recordLandingObservation,
  type LandingChannel,
} from './projectHostedLandingStore';
import { hostedLandingStateSchema } from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';

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
export async function releaseLandingQueue(
  ctx: MutationCtx,
  queue: Doc<'projectHostedLandingQueues'>,
  now = Date.now(),
) {
  if (queue.wake) await ctx.scheduler.cancel(queue.wake.taskId);
  await ctx.db.patch(queue._id, { lease: null, wake: null });
  const pending = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_runnable_and_sequence', q =>
      q.eq('projectId', queue.projectId).eq('channel', queue.channel).eq('runnable', true),
    )
    .order('asc')
    .take(1);
  if (pending.length) {
    const current = (await landingQueue(ctx, queue))!;
    await scheduleLandingWake(ctx, current, now, now);
  }
}
const checkWakeRow = (ctx: MutationCtx, input: { projectId: Id<'hostedProjects'>; runId: string }) =>
  ctx.db
    .query('projectHostedLandingCheckWakes')
    .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
    .unique();
async function scheduleCheckWake(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; runId: string },
  row: Awaited<ReturnType<typeof checkWakeRow>>,
) {
  const id = crypto.randomUUID();
  const taskId = await ctx.scheduler.runAfter(
    0,
    makeFunctionReference<'mutation'>('projectHostedLandingDriver:checkWake'),
    { ...input, wakeId: id },
  );
  if (row) await ctx.db.patch(row._id, { wake: { taskId, id } });
  else await ctx.db.insert('projectHostedLandingCheckWakes', { ...input, wake: { taskId, id } });
}
/** H10 schedules one coalesced metadata fan-out in its result transaction. Its
 * cost stays constant even if thousands of requests wait for the same run. */
export async function notifyLandingCheck(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    runId: string;
  },
) {
  const waiting = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_run_and_phase', q =>
      q.eq('projectId', input.projectId).eq('runId', input.runId).eq('phase', 'checking'),
    )
    .take(1);
  if (!waiting.length) return;
  const row = await checkWakeRow(ctx, input);
  if (row?.wake) {
    const task = await ctx.db.system.get(row.wake.taskId);
    if (task?.state.kind === 'pending' || task?.state.kind === 'inProgress') return;
  }
  await scheduleCheckWake(ctx, input, row);
}
/** Consume a bounded metadata window. Removing checking from the matching index
 * permits continuation without scanning prior terminal work or skipping rows. */
export async function wakeLandingCheck(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    runId: string;
    wakeId: string;
  },
) {
  const wake = await checkWakeRow(ctx, input);
  if (wake?.wake?.id !== input.wakeId) return;
  const page = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_run_and_phase', q =>
      q.eq('projectId', input.projectId).eq('runId', input.runId).eq('phase', 'checking'),
    )
    .paginate({ cursor: null, numItems: 100, maximumRowsRead: 100, maximumBytesRead: 96 * 1024 });
  for (const row of page.page) {
    const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
    state.phase = 'queued';
    state.version++;
    // Keep the checking observation until the original run is evaluated.
    await recordLandingObservation(ctx, state, null);
    await ctx.db.patch(row._id, { phase: 'queued', runnable: true, value: canonicalPayload(state) });
  }
  if (page.page.length) await wakeLandingQueue(ctx, { projectId: input.projectId, channel: 'main' });
  if (!page.isDone) await scheduleCheckWake(ctx, { projectId: input.projectId, runId: input.runId }, wake);
  else await ctx.db.patch(wake._id, { wake: null });
}
