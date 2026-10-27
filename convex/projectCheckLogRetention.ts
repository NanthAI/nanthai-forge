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
/** One event-driven wake only when a finite expiry is already due. Never arms an idle timer. */
export async function wakeExpiredLogs(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const due = await ctx.db
    .query('projectCheckLogRetentions')
    .withIndex('by_project_and_expiry', q => q.eq('projectId', projectId).lte('expiresAt', Date.now()))
    .take(1);
  if (due.length)
    await ctx.scheduler.runAfter(0, internal.projectCheckLogRetentionActions.sweep, { projectId });
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
