// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
export type SourceBatchValidator = (batch: Doc<'projectSourceBatches'>) => Promise<boolean>;
export function sourceParallelism(env: Record<string, string | undefined> = process.env) {
  const value = Number(env.FORGE_SOURCE_PARALLELISM ?? 4);
  invariant(
    Number.isInteger(value) && value >= 1 && value <= 4,
    'SOURCE_WORKER_UNAVAILABLE',
    'Configure source parallelism between one and four.',
  );
  return value;
}
const taskRef = makeFunctionReference<'action'>('projectConvexSourceTask:run');
export async function scheduleSourceTask(ctx: MutationCtx, task: Doc<'projectSourceTasks'>) {
  const scheduledId = await ctx.scheduler.runAfter(0, taskRef, {
    projectId: task.projectId,
    jobId: task.jobId,
    step: task.step,
    index: task.index,
    generation: task.generation,
  });
  await ctx.db.patch(task._id, { status: 'running', scheduledId });
  return scheduledId;
}
export async function sourcePool(ctx: MutationCtx) {
  let row = await ctx.db
    .query('projectSourcePools')
    .withIndex('by_key', q => q.eq('key', 'source'))
    .unique();
  if (!row) {
    const id = await ctx.db.insert('projectSourcePools', { key: 'source', active: [] });
    row = (await ctx.db.get(id))!;
  }
  return row;
}
/** This is an event-driven drain, called inside enqueue/completion transactions.
 * The global cap includes every project. No idle loop or recovery timer exists. */
export async function drainSourcePool(ctx: MutationCtx, validate: SourceBatchValidator) {
  const pool = await sourcePool(ctx),
    active: Id<'projectSourceTasks'>[] = [];
  for (const id of pool.active) {
    const task = await ctx.db.get(id);
    if (!task || task.status === 'done') continue;
    const batch = await ctx.db.get(task.batchId),
      scheduled = task.scheduledId ? await ctx.db.system.get(task.scheduledId) : null;
    if (!batch || batch.status === 'fenced') {
      if (scheduled?.state.kind === 'pending') await ctx.scheduler.cancel(task.scheduledId!);
      if (scheduled?.state.kind === 'inProgress') active.push(id);
      else await ctx.db.patch(id, { status: 'done', failure: 'SOURCE_JOB_FENCED' });
      continue;
    }
    if (scheduled && ['pending', 'inProgress'].includes(scheduled.state.kind)) {
      active.push(id);
      continue;
    }
    if (await validate(batch)) {
      await scheduleSourceTask(ctx, task);
      active.push(id);
    } else {
      await ctx.db.patch(batch._id, { status: 'fenced' });
      await ctx.db.patch(id, { status: 'done', failure: 'SOURCE_JOB_FENCED' });
    }
  }
  const cap = sourceParallelism();
  // Each iteration either starts one of at most four slots or removes one
  // invalid batch. Batch rows, rather than per-file queue rows, avoid scanning
  // an abandoned change set before another project's work can start.
  for (let attempts = 0; active.length < cap && attempts < 16; attempts++) {
    const batch = (
      await ctx.db
        .query('projectSourceBatches')
        .withIndex('by_status', q => q.eq('status', 'queued'))
        .take(1)
    )[0];
    if (!batch) break;
    if (!(await validate(batch))) {
      await ctx.db.patch(batch._id, { status: 'fenced' });
      continue;
    }
    const task = await ctx.db
      .query('projectSourceTasks')
      .withIndex('by_batch_and_index', q => q.eq('batchId', batch._id).eq('index', batch.next))
      .unique();
    invariant(task?.status === 'queued', 'SOURCE_JOB_INVALID', 'Queued source work changed.');
    await scheduleSourceTask(ctx, task);
    active.push(task._id);
    await ctx.db.patch(batch._id, {
      next: batch.next + 1,
      status: batch.next + 1 === batch.total ? 'waiting' : 'queued',
    });
  }
  await ctx.db.patch(pool._id, { active });
  if (
    active.length < cap &&
    !pool.drainQueued &&
    (
      await ctx.db
        .query('projectSourceBatches')
        .withIndex('by_status', q => q.eq('status', 'queued'))
        .take(1)
    ).length
  ) {
    await ctx.db.patch(pool._id, { drainQueued: true });
    await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectConvexSourceFanout:drain'), {});
  }
}
export async function releaseSourceTask(ctx: MutationCtx, id: Id<'projectSourceTasks'>) {
  const pool = await sourcePool(ctx);
  await ctx.db.patch(pool._id, { active: pool.active.filter(value => value !== id) });
}
/** Recovery of a batch fenced only by an expired lease, after the caller renewed
 * the same execution. Every child restarts at a new generation, so replies from
 * the fenced attempt are ignored. Unfinished children keep their durable progress
 * (completed ones already cleared it). Bounded by the fork limit of 800. */
export async function requeueSourceBatch(ctx: MutationCtx, batch: Doc<'projectSourceBatches'>) {
  const tasks = await ctx.db
    .query('projectSourceTasks')
    .withIndex('by_batch_and_index', q => q.eq('batchId', batch._id))
    .take(batch.total);
  const ids = new Set(tasks.map(task => task._id)),
    pool = await sourcePool(ctx);
  await ctx.db.patch(pool._id, { active: pool.active.filter(id => !ids.has(id)) });
  for (const task of tasks)
    await ctx.db.patch(task._id, {
      status: 'queued',
      generation: task.generation + 1,
      output: null,
      failure: null,
      scheduledId: undefined,
    });
  await ctx.db.patch(batch._id, { status: 'queued', next: 0, completed: 0, failure: null });
}
