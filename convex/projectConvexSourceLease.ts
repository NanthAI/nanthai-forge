// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { activeStep, armSourceWake, moveSourceWake, rowFor } from './projectConvexSourceActive';
import { repairConvexSource } from './projectConvexSourceStore';
import { heartbeat, taskRow } from './projectConvexSourceFanout';
import { loadSourceJob, sourceJobTerminal } from './projectSourceJobs';
import { sourcePhaseNames } from '../src/hosted-source-retry';
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
    phase: v.optional(v.union(...sourcePhaseNames.map(phase => v.literal(phase)))),
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
    await heartbeat(ctx, active, {
      step: args.step,
      generation: args.generation ?? 0,
      ...(args.index === undefined ? {} : { index: args.index }),
      ...(args.phase ? { phase: args.phase } : {}),
    });
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
 * requeued). Whatever is still this step's work afterwards gets one wake at its lease end: a live
 * lease (renewed by the repair or another path), or an expired one only while the step's own action
 * is still pending or running, which the platform's action time limit bounds. A lease that nothing
 * renewed and no action holds (an authority fence) is not watched. A refused repair ends the watch
 * when the lease is still expired after it, and a re-armed wake whose repair is refused again ends
 * it too, so the wake never polls a stuck job (review 82171a53; wording, review be78a4be). Never
 * runs for a healthy step, and never polls an idle project. */
export const expired = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    jobId: v.string(),
    step: v.number(),
    generation: v.number(),
    refused: v.optional(v.literal(true)),
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
    let refused = false;
    if (before.job.control.workerUntil <= Date.now())
      try {
        await repairConvexSource(ctx, { projectId: args.projectId, jobId: args.jobId });
      } catch (error) {
        if (!(error instanceof ForgeError)) throw error;
        refused = true;
      }
    const after = await current();
    // A retry or a moved lease armed its own wake already.
    if (!after || after.row.repairWakeId !== before.row.repairWakeId) return null;
    const target = { step: after.row.step, generation: after.row.generation ?? 0 };
    const left = after.job.control.workerUntil - Date.now();
    // Every re-arm needs live work to watch, or the wake would poll a stuck job (review 82171a53).
    // A refused repair (a ForgeError, review 308f217c) keeps the writes made before it threw: a lease
    // it renewed first is watched to its end once, and a second refusal ends the watch.
    if (refused && (left <= 0 || args.refused)) return null;
    // A lease nobody renewed (an authority fence: renewConvexSource refuses it without throwing) is
    // watched only while the step's own action is still pending or running; that action's end commits,
    // fails or forks, and the platform's action time limit bounds it.
    if (left <= 0) {
      const scheduled = after.row.scheduledId ? await ctx.db.system.get(after.row.scheduledId) : null;
      if (scheduled?.state.kind !== 'pending' && scheduled?.state.kind !== 'inProgress') return null;
    }
    await ctx.db.patch(after.row._id, {
      repairWakeId: await armSourceWake(
        ctx,
        after.row,
        target,
        left > 0 ? left : after.job.control.workerLeaseMs,
        undefined,
        refused ? true : undefined,
      ),
    });
    return null;
  },
});
