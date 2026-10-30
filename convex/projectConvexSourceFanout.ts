// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { activeStep } from './projectConvexSourceStore';
import {
  drainSourcePool,
  releaseSourceTask,
  scheduleSourceTask,
  sourcePool,
} from './projectConvexSourcePool';
import { receiveConvexSourceJobCallback } from './projectSourceJobCallbacks';
import { sourceTaskData } from './projectSourceStepFields';
import { sourceDispatch } from '../src/hosted-source-job-controller';
import { canonicalPayload } from '../src/hosted-source-operation';
import { ForgeError, invariant } from '../src/errors';
const identity = { projectId: v.id('hostedProjects'), jobId: v.string(), step: v.number() };
const taskIdentity = { ...identity, index: v.number(), generation: v.number() };
export async function validSourceBatch(ctx: MutationCtx, batch: Doc<'projectSourceBatches'>) {
  try {
    const active = await activeStep(ctx, batch);
    return !!active && active.row.batchId === batch._id;
  } catch (error) {
    if (error instanceof ForgeError) return false;
    throw error;
  }
}
async function heartbeat(ctx: MutationCtx, active: NonNullable<Awaited<ReturnType<typeof activeStep>>>) {
  const body: Partial<ReturnType<typeof sourceDispatch>> = sourceDispatch(active.row.projectId, active.job);
  // Dispatch-only fields do not belong to the existing terminal manifest.
  delete body.jobKind;
  delete body.input;
  delete body.dispatchKey;
  await receiveConvexSourceJobCallback(ctx, active.row.projectId, {
    ...body,
    executionId: active.row.executionId,
    result: { status: 'heartbeat', sequence: active.job.control.heartbeat + 1 },
  });
}
const taskRow = (ctx: MutationCtx, batchId: Id<'projectSourceBatches'>, index: number) =>
  ctx.db
    .query('projectSourceTasks')
    .withIndex('by_batch_and_index', q => q.eq('batchId', batchId).eq('index', index))
    .unique();
export const fork = internalMutation({
  args: {
    ...identity,
    cursor: v.string(),
    kind: v.string(),
    end: v.number(),
    tasks: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const active = await activeStep(ctx, args);
    if (!active) return null;
    if (active.row.batchId) {
      const previous = await ctx.db.get(active.row.batchId);
      invariant(previous?.status === 'done', 'SOURCE_JOB_FENCED', 'Join the retained source work first.');
    }
    invariant(
      args.tasks.length > 0 && args.tasks.length <= 800,
      'SOURCE_JOB_INVALID',
      'Fork a bounded source window.',
    );
    const step = args.step + 1,
      batchId = await ctx.db.insert('projectSourceBatches', {
        projectId: args.projectId,
        jobId: args.jobId,
        step,
        kind: args.kind,
        end: args.end,
        total: args.tasks.length,
        next: 0,
        completed: 0,
        status: 'queued',
        failure: null,
      });
    for (let index = 0; index < args.tasks.length; index++)
      await ctx.db.insert('projectSourceTasks', {
        projectId: args.projectId,
        jobId: args.jobId,
        step,
        batchId,
        index,
        input: args.tasks[index]!,
        status: 'queued',
        generation: 0,
        progress: null,
        output: null,
        failure: null,
      });
    await ctx.db.patch(active.row._id, { step, cursor: args.cursor, batchId });
    await heartbeat(ctx, active);
    await drainSourcePool(ctx, batch => validSourceBatch(ctx, batch));
    return null;
  },
});
export const begin = internalMutation({
  args: taskIdentity,
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    let active;
    try {
      active = await activeStep(ctx, args);
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
      active = null;
    }
    const step = await ctx.db
      .query('projectSourceSteps')
      .withIndex('by_project_and_job', q => q.eq('projectId', args.projectId).eq('jobId', args.jobId))
      .unique();
    const batch = step?.batchId ? await ctx.db.get(step.batchId) : null;
    if (!batch || batch.step !== args.step) return null;
    const task = await taskRow(ctx, batch._id, args.index);
    if (!task || task.status !== 'running' || task.generation !== args.generation) return null;
    if (!active) {
      await ctx.db.patch(batch._id, { status: 'fenced' });
      await ctx.db.patch(task._id, { status: 'done', failure: 'SOURCE_JOB_FENCED' });
      await releaseSourceTask(ctx, task._id);
      await drainSourcePool(ctx, b => validSourceBatch(ctx, b));
      return null;
    }
    return canonicalPayload({ input: task.input, progress: task.progress });
  },
});
export const complete = internalMutation({
  args: {
    ...taskIdentity,
    done: v.boolean(),
    progress: v.union(sourceTaskData, v.null()),
    output: v.union(sourceTaskData, v.null()),
    failure: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const active = await activeStep(ctx, args);
    if (!active?.row.batchId) return null;
    const batch = await ctx.db.get(active.row.batchId);
    if (!batch || batch.status === 'done' || batch.status === 'fenced') return null;
    const task = await taskRow(ctx, batch._id, args.index);
    if (!task || task.status !== 'running' || task.generation !== args.generation) return null;
    await heartbeat(ctx, active);
    if (!args.done && !args.failure) {
      await ctx.db.patch(task._id, { generation: task.generation + 1, progress: args.progress });
      await scheduleSourceTask(ctx, { ...task, generation: task.generation + 1, progress: args.progress });
      return null;
    }
    await ctx.db.patch(task._id, {
      status: 'done',
      progress: null,
      output: args.output,
      failure: args.failure,
    });
    await releaseSourceTask(ctx, task._id);
    const completed = batch.completed + 1;
    await ctx.db.patch(batch._id, {
      completed,
      failure: batch.failure ?? args.failure,
      status: completed === batch.total ? 'done' : batch.status,
    });
    if (completed === batch.total) {
      const scheduledId = await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'action'>('projectConvexSource:step'),
        { projectId: args.projectId, jobId: args.jobId, step: args.step },
      );
      await ctx.db.patch(active.row._id, { scheduledId });
    }
    await drainSourcePool(ctx, b => validSourceBatch(ctx, b));
    return null;
  },
});
export const results = internalMutation({
  args: identity,
  returns: v.string(),
  handler: async (ctx, args) => {
    const active = await activeStep(ctx, args);
    invariant(active?.row.batchId, 'SOURCE_JOB_FENCED', 'Source join changed.');
    const batch = await ctx.db.get(active.row.batchId);
    invariant(
      batch?.status === 'done' && batch.completed === batch.total,
      'SOURCE_JOB_FENCED',
      'Source children are still running.',
    );
    const tasks = await ctx.db
      .query('projectSourceTasks')
      .withIndex('by_batch_and_index', q => q.eq('batchId', batch._id))
      .take(batch.total);
    invariant(
      tasks.length === batch.total && tasks.every(t => t.status === 'done'),
      'SOURCE_JOB_INVALID',
      'Source join is incomplete.',
    );
    return canonicalPayload({
      kind: batch.kind,
      end: batch.end,
      failure: batch.failure,
      outputs: tasks.map(task => task.output),
    });
  },
});

export const drain = internalMutation({
  args: {},
  returns: v.null(),
  handler: async ctx => {
    const pool = await sourcePool(ctx);
    await ctx.db.patch(pool._id, { drainQueued: false });
    await drainSourcePool(ctx, b => validSourceBatch(ctx, b));
    return null;
  },
});
