// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { activeProject } from './projectAuthority';

export async function retainLogExpiry(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  key: string,
  expiresAt: number,
) {
  const existing = await ctx.db
    .query('projectCheckLogRetentions')
    .withIndex('by_project_and_key', q => q.eq('projectId', projectId).eq('key', key))
    .unique();
  if (!existing) await ctx.db.insert('projectCheckLogRetentions', { projectId, key, expiresAt });
}
/** Automatic deletion may trail expiry by up to this long, so continuous expiries
 * share at most one full plan per project per day instead of one per check. */
export const CHECK_LOG_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** One event-driven wake only when a finite expiry is already due. Never arms an idle timer. */
export async function wakeExpiredLogs(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const due = await ctx.db
    .query('projectCheckLogRetentions')
    .withIndex('by_project_and_expiry', q => q.eq('projectId', projectId).lte('expiresAt', Date.now()))
    .take(1);
  if (!due.length) return;
  const project = await ctx.db.get(projectId);
  if (!project || project.removal) return;
  if (
    !project.checkLogSweep &&
    project.checkLogSweptAt !== undefined &&
    Date.now() - project.checkLogSweptAt < CHECK_LOG_SWEEP_INTERVAL_MS
  )
    return;
  if (project.checkLogSweep) {
    const task = await ctx.db.system.get(project.checkLogSweep.task);
    if (task && ['pending', 'inProgress'].includes(task.state.kind)) return;
  }
  const prior = project.checkLogSweep;
  const sweep = {
    operationId: prior?.operationId ?? crypto.randomUUID(),
    cutoff: prior?.cutoff ?? Date.now(),
    sequence: (prior?.sequence ?? 0) + 1,
    running: false,
    ...(prior?.settling ? { settling: true } : {}),
  };
  const task = await ctx.scheduler.runAfter(0, internal.projectCheckLogRetentionActions.sweep, {
    projectId,
    operationId: sweep.operationId,
    sequence: sweep.sequence,
  });
  await ctx.db.patch(projectId, { checkLogSweep: { ...sweep, task } });
}
export const register = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    entries: v.array(v.object({ key: v.string(), expiresAt: v.number() })),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    await activeProject(ctx, input.projectId, input.actor);
    for (const entry of input.entries)
      await retainLogExpiry(ctx, input.projectId, entry.key, entry.expiresAt);
    await wakeExpiredLogs(ctx, input.projectId);
    return null;
  },
});
export const due = internalQuery({
  args: { projectId: v.id('hostedProjects') },
  returns: v.string(),
  handler: async (ctx, { projectId }) => {
    const project = await ctx.db.get(projectId);
    if (!project || project.removal) return JSON.stringify({ owner: null, entries: [] });
    const entries = await ctx.db
      .query('projectCheckLogRetentions')
      .withIndex('by_project_and_expiry', q => q.eq('projectId', projectId).lte('expiresAt', Date.now()))
      .take(50);
    return JSON.stringify({ owner: project.owner, entries });
  },
});
export const settled = internalMutation({
  args: { projectId: v.id('hostedProjects'), ids: v.array(v.id('projectCheckLogRetentions')) },
  returns: v.null(),
  handler: async (ctx, { projectId, ids }) => {
    for (const id of ids) {
      const row = await ctx.db.get(id);
      if (row?.projectId === projectId) await ctx.db.delete(id);
    }
    await wakeExpiredLogs(ctx, projectId);
    return null;
  },
});

export const claimSweep = internalMutation({
  args: { projectId: v.id('hostedProjects'), operationId: v.string(), sequence: v.number() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId),
      sweep = project?.checkLogSweep;
    if (
      !project ||
      project.removal ||
      !sweep ||
      sweep.operationId !== input.operationId ||
      sweep.sequence !== input.sequence ||
      sweep.running
    )
      return null;
    await activeProject(ctx, input.projectId, project.owner);
    await ctx.db.patch(input.projectId, { checkLogSweep: { ...sweep, running: true } });
    return JSON.stringify({ actor: project.owner, settling: sweep.settling ?? false });
  },
});
/** The winner alone schedules the next finite page. Due receipts are drained
 * under the original cutoff, so a backlog shares one plan rather than rescanning. */
export const advanceSweep = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    sequence: v.number(),
    complete: v.boolean(),
    restart: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId),
      sweep = project?.checkLogSweep;
    if (
      !project ||
      project.removal ||
      !sweep ||
      sweep.operationId !== input.operationId ||
      sweep.sequence !== input.sequence ||
      !sweep.running
    )
      return null;
    await activeProject(ctx, input.projectId, project.owner);
    const settling = sweep.settling || input.complete;
    if (settling) {
      const rows = await ctx.db
        .query('projectCheckLogRetentions')
        .withIndex('by_project_and_expiry', q =>
          q.eq('projectId', input.projectId).lte('expiresAt', sweep.cutoff),
        )
        .take(50);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length < 50) {
        // Expiries that became due during this plan wait for the next daily wake.
        await ctx.db.patch(input.projectId, { checkLogSweep: undefined, checkLogSweptAt: Date.now() });
        return null;
      }
    }
    const operationId = input.restart ? crypto.randomUUID() : sweep.operationId;
    const sequence = sweep.sequence + 1;
    const task = await ctx.scheduler.runAfter(0, internal.projectCheckLogRetentionActions.sweep, {
      projectId: input.projectId,
      operationId,
      sequence,
    });
    await ctx.db.patch(input.projectId, {
      checkLogSweep: { ...sweep, operationId, sequence, task, running: false, settling },
    });
    return null;
  },
});
