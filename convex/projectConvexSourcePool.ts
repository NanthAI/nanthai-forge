// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import {
  exhaustSourceExecution,
  sourceFailureUpdate,
  sourceRetryExpired,
} from './projectConvexSourceFailure';
import { sourceStep } from './projectConvexSourceActive';
import { SOURCE_MAX_FAILED_ATTEMPTS, unknownSourceFailure } from '../src/hosted-source-retry';
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
export async function scheduleSourceTask(
  ctx: MutationCtx,
  task: Doc<'projectSourceTasks'>,
  retry = false,
  update: Partial<ReturnType<typeof sourceFailureUpdate>> = {},
) {
  const generation = task.generation + (retry ? 1 : 0);
  const scheduledId = await ctx.scheduler.runAfter(
    Math.max(0, (update.retryAt ?? task.retryAt ?? 0) - Date.now()),
    taskRef,
    {
      projectId: task.projectId,
      jobId: task.jobId,
      step: task.step,
      index: task.index,
      generation,
    },
  );
  await ctx.db.patch(task._id, {
    status: 'running',
    scheduledId,
    ...(retry ? { generation } : {}),
    ...update,
  });
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
export type SourceSlot = Doc<'projectSourcePools'>['active'][number];
const slotTask = (slot: SourceSlot) => (typeof slot === 'string' ? slot : slot.task);
const slot = (task: Doc<'projectSourceTasks'>, scheduled: Id<'_scheduled_functions'>) => ({
  task: task._id,
  batch: task.batchId,
  scheduled,
});
const live = (state?: string) => state === 'pending' || state === 'inProgress';
/** This is an event-driven drain, called inside enqueue/completion transactions.
 * The global cap includes every project. No idle loop or recovery timer exists.
 * A slot whose batch is valid and whose recorded run is still pending or running
 * is kept without reading its task document; any other slot reads the task. */
export async function drainSourcePool(ctx: MutationCtx, check: SourceBatchValidator) {
  const pool = await sourcePool(ctx),
    active: SourceSlot[] = [],
    // Healthy drains reuse one authority answer per batch. Exhaustion fences
    // its batch before further queue selection; other batch answers still hold.
    checked = new Map<Id<'projectSourceBatches'>, Promise<boolean>>();
  const validate: SourceBatchValidator = batch => {
    let answer = checked.get(batch._id);
    if (!answer) checked.set(batch._id, (answer = check(batch)));
    return answer;
  };
  // Exhaustion can cancel slots already accumulated earlier in this drain.
  // Read its bounded pool result only on that terminal path, so the final write
  // cannot restore cancelled reservations or strand another project's queue.
  const removeReleased = async (batchId: Id<'projectSourceBatches'>) => {
    const retained = new Set((await sourcePool(ctx)).active.map(slotTask));
    for (let i = active.length - 1; i >= 0; i--) {
      const entry = active[i]!;
      if (typeof entry !== 'string' && entry.batch === batchId && !retained.has(entry.task))
        active.splice(i, 1);
    }
  };
  for (const entry of pool.active) {
    const id = slotTask(entry);
    if (typeof entry !== 'string') {
      const batch = await ctx.db.get(entry.batch);
      if (batch && batch.status !== 'fenced') {
        const hinted = await ctx.db.system.get(entry.scheduled);
        if (live(hinted?.state.kind)) {
          active.push(entry);
          continue;
        }
      }
    }
    const task = await ctx.db.get(id);
    if (!task || task.status === 'done') continue;
    const batch = await ctx.db.get(task.batchId),
      scheduled = task.scheduledId ? await ctx.db.system.get(task.scheduledId) : null;
    if (!batch || batch.status === 'fenced') {
      if (scheduled?.state.kind === 'pending') await ctx.scheduler.cancel(task.scheduledId!);
      if (scheduled?.state.kind === 'inProgress') active.push(slot(task, task.scheduledId!));
      else await ctx.db.patch(id, { status: 'done', failure: 'SOURCE_JOB_FENCED' });
      continue;
    }
    if (scheduled && live(scheduled.state.kind)) {
      active.push(slot(task, task.scheduledId!));
      continue;
    }
    // A stopped action may have lost a mutation reply. Fence its late completion
    // before reserving another action for the same durable quantum.
    if (await validate(batch)) {
      const scheduledId = await retrySourceTask(ctx, task, unknownSourceFailure('scheduled-task'), true);
      if (scheduledId) active.push(slot(task, scheduledId));
      else await removeReleased(batch._id);
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
      .withIndex('by_batch_and_index', q =>
        q.eq('batchId', batch._id).eq('index', batch.retryIndices?.[0] ?? batch.next),
      )
      .unique();
    invariant(task?.status === 'queued', 'SOURCE_JOB_INVALID', 'Queued source work changed.');
    if (
      (task.failedAttempts ?? 0) >= SOURCE_MAX_FAILED_ATTEMPTS ||
      sourceRetryExpired({ job: { control: { retryUntil: task.retryUntil } } })
    ) {
      await exhaustSourceExecution(ctx, task, task.lastFailure);
      await removeReleased(batch._id);
      continue;
    }
    active.push(slot(task, await scheduleSourceTask(ctx, task)));
    await ctx.db.patch(
      batch._id,
      batch.retryIndices
        ? {
            retryIndices: batch.retryIndices.slice(1),
            status: batch.retryIndices.length === 1 ? 'waiting' : 'queued',
          }
        : {
            next: batch.next + 1,
            status: batch.next + 1 === batch.total ? 'waiting' : 'queued',
          },
    );
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
  await ctx.db.patch(pool._id, { active: pool.active.filter(value => slotTask(value) !== id) });
}
/** Recovery of a batch fenced only by an expired lease, after the caller renewed
 * the same execution. Only unfinished/fenced children change generation; completed
 * outputs and durable prefixes survive. Old in-progress runs keep their slots
 * until the scheduler confirms they stopped. Bounded by the fork limit of 800. */
export async function requeueSourceBatch(ctx: MutationCtx, batch: Doc<'projectSourceBatches'>) {
  const tasks = await ctx.db
    .query('projectSourceTasks')
    .withIndex('by_batch_and_index', q => q.eq('batchId', batch._id))
    .take(batch.total);
  const ids = new Set(tasks.map(task => task._id)),
    pool = await sourcePool(ctx),
    held: SourceSlot[] = [],
    retryIndices: number[] = [];
  let completed = 0,
    failure: string | null = null;
  for (const task of tasks) {
    if (task.status === 'done' && task.failure !== 'SOURCE_JOB_FENCED') {
      completed++;
      failure ??= task.failure;
      continue;
    }
    const scheduled = task.scheduledId ? await ctx.db.system.get(task.scheduledId) : null;
    // A fenced begin already released its slot and does no source work while
    // returning. Do not reclaim that slot from another project's live action.
    const running = task.status === 'running' && scheduled?.state.kind === 'inProgress';
    if (running) held.push(slot(task, task.scheduledId!));
    else {
      if (scheduled?.state.kind === 'pending') await ctx.scheduler.cancel(task.scheduledId!);
      retryIndices.push(task.index);
    }
    const failed =
      task.status === 'running' && (!scheduled || ['failed', 'canceled'].includes(scheduled.state.kind));
    const update: Partial<ReturnType<typeof sourceFailureUpdate>> = failed
      ? sourceFailureUpdate(task, task.lastFailure ?? unknownSourceFailure('scheduled-task'), task.retryUntil)
      : {};
    if (failed && update.failedAttempts! >= SOURCE_MAX_FAILED_ATTEMPTS) {
      await ctx.db.patch(task._id, update);
      await exhaustSourceExecution(ctx, task, update.lastFailure);
      return;
    }
    await ctx.db.patch(task._id, {
      ...update,
      status: running ? 'running' : 'queued',
      generation: task.generation + 1,
      output: null,
      failure: null,
      ...(running ? {} : { scheduledId: undefined }),
    });
  }
  await ctx.db.patch(pool._id, {
    active: [...pool.active.filter(value => !ids.has(slotTask(value))), ...held],
  });
  await ctx.db.patch(batch._id, {
    status: retryIndices.length ? 'queued' : 'waiting',
    next: batch.total,
    retryIndices,
    completed,
    failure,
  });
}

/** The only replacement path for a failed child, including failures discovered
 * by unrelated pool activity. Scheduling and accounting share one row write. */
export async function retrySourceTask(
  ctx: MutationCtx,
  task: Doc<'projectSourceTasks'>,
  cause = unknownSourceFailure('scheduled-task'),
  validated = false,
) {
  if (!validated && !(await sourceStep(ctx, task, false))) return null;
  const update = sourceFailureUpdate(task, cause, task.retryUntil);
  if (
    update.failedAttempts >= SOURCE_MAX_FAILED_ATTEMPTS ||
    sourceRetryExpired({ job: { control: { retryUntil: task.retryUntil } } })
  ) {
    await ctx.db.patch(task._id, update);
    await exhaustSourceExecution(ctx, task, update.lastFailure, task._id);
    return null;
  }
  return scheduleSourceTask(ctx, task, true, update);
}
