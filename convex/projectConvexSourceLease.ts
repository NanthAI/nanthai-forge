// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { activeStep } from './projectConvexSourceStore';
import { heartbeat, taskRow } from './projectConvexSourceFanout';
import { ForgeError } from '../src/errors';
/** A running step (or fan-out task) renews its worker lease from inside the step (keepSourceLease,
 * incident e62d834b). Only the current execution renews: the step, its generation (for a task, its
 * running task generation) and a still-valid lease, checked exactly as the step's own commit checks
 * them. Renewal is the existing heartbeat callback, so it never revives an expired or replaced step
 * and adds no table. False tells the step to stop renewing. */
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
    return true;
  },
});
