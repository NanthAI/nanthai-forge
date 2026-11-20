// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { activeStep, armSourceWake, moveSourceWake, rowFor } from './projectConvexSourceActive';
import { repairConvexSource } from './projectConvexSourceStore';
import { heartbeat, taskRow } from './projectConvexSourceFanout';
import { loadSourceJob, sourceJobTerminal } from './projectSourceJobs';
import { ForgeError } from '../src/errors';
/** A running step (or fan-out task) renews its worker lease from inside the step (keepSourceLease,
 * incident e62d834b). Only the current execution renews: the step, its generation (for a task, its
 * running task generation) and a still-valid lease, checked exactly as the step's own commit checks
 * them. Renewal is the existing heartbeat callback, so it never revives an expired or replaced step
 * and adds no table. A step's renewal also moves its repair wake to the renewed lease's end, so the
 * wake never runs while the step is alive. False tells the step to stop renewing. */
export const renew = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    jobId: v.string(),
    step: v.number(),
    generation: v.optional(v.number()),
    index: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    let active;
    try {
      active = await activeStep(
        ctx,
        args.index === undefined ? { ...args, generation: args.generation ?? 0 } : args,
      );
    } catch (error) {
      if (error instanceof ForgeError) return false;
      throw error;
    }
    if (!active) return false;
    if (args.index !== undefined) {
      const batch = active.row.batchId ? await ctx.db.get(active.row.batchId) : null;
      if (!batch || batch.step !== args.step || batch.status === 'done' || batch.status === 'fenced')
        return false;
      const task = await taskRow(ctx, batch._id, args.index);
      if (!task || task.status !== 'running' || task.generation !== args.generation) return false;
    }
    await heartbeat(ctx, active);
    await moveSourceWake(
      ctx,
      active.row,
      { step: args.step, generation: args.index === undefined ? (args.generation ?? 0) : 0 },
      active.job.control.workerLeaseMs,
      args.index !== undefined,
    );
    return true;
  },
});
/** The step's repair wake (armSourceWake) at the end of its worker lease. Every arm cancels the
 * row's earlier wake and a settling commit cancels it, so a wake that runs is the row's current one;
 * it acts on the row's current step (a fork keeps the wake), and a settled job is left alone. An
 * expired lease is repaired at once (repairConvexSource: a dead or fenced step is retried as its next
 * generation, which arms its own wake; a fan-out batch fenced or queued past its lease is renewed and
 * requeued). Whatever is still this step's work afterwards (an action still pending or running, a
 * batch in flight, a lease some other path renewed) gets one wake at its lease end, which the
 * platform's action time limit and the job's retry window bound. Never runs for a healthy step, and
 * never polls an idle project. */
export const expired = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    jobId: v.string(),
    step: v.number(),
    generation: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const current = async () => {
      const row = await rowFor(ctx, args.projectId, args.jobId);
      if (!row || row.physicalSeed) return null;
      const job = await loadSourceJob(ctx, args.projectId, args.jobId);
      return sourceJobTerminal(job) ? null : { row, job };
    };
    const before = await current();
    if (!before) return null;
    if (before.job.control.workerUntil <= Date.now())
      try {
        await repairConvexSource(ctx, { projectId: args.projectId, jobId: args.jobId });
      } catch (error) {
        if (!(error instanceof ForgeError)) throw error;
        return null;
      }
    const after = await current();
    // A retry or a moved lease armed its own wake already.
    if (!after || after.row.repairWakeId !== before.row.repairWakeId) return null;
    const target = { step: after.row.step, generation: after.row.generation ?? 0 };
    const left = after.job.control.workerUntil - Date.now();
    await ctx.db.patch(after.row._id, {
      repairWakeId: await armSourceWake(
        ctx,
        after.row,
        target,
        left > 0 ? left : after.job.control.workerLeaseMs,
      ),
    });
    return null;
  },
});
