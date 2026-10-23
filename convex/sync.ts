// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { jobDocument, syncResult } from './schema';

export const receive = internalMutation({
  args: { delivery: v.string(), event: v.string(), repository: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const previous = await ctx.db
      .query('githubDeliveries')
      .withIndex('by_delivery', q => q.eq('delivery', args.delivery))
      .unique();
    if (previous) {
      if (previous.complete) return null;
      const task = previous.task ? await ctx.db.system.get(previous.task) : null;
      if (task && ['pending', 'inProgress'].includes(task.state.kind)) return null;
      const scheduled = await ctx.scheduler.runAfter(0, internal.syncActions.run, { id: previous._id });
      await ctx.db.patch(previous._id, { task: scheduled });
    } else {
      const id = await ctx.db.insert('githubDeliveries', { ...args, cursor: null, complete: false });
      const task = await ctx.scheduler.runAfter(0, internal.syncActions.run, { id });
      await ctx.db.patch(id, { task });
    }
    return null;
  },
});
export const page = internalQuery({
  args: { id: v.id('githubDeliveries'), paginationOpts: paginationOptsValidator },
  returns: v.union(
    v.null(),
    v.object({ page: v.array(jobDocument), isDone: v.boolean(), continueCursor: v.string() }),
  ),
  handler: async (ctx, { id, paginationOpts }) => {
    const delivery = await ctx.db.get(id);
    if (!delivery || delivery.complete) return null;
    const jobs = delivery.repository
      ? ctx.db.query('imports').withIndex('by_repository', q => q.eq('repository', delivery.repository!))
      : ctx.db.query('imports');
    // ponytail: access events scan imported jobs in pages; add installation/user indexes if measured volume warrants them.
    const result = await jobs.paginate({ ...paginationOpts, cursor: delivery.cursor });
    return { page: result.page, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});
export const advance = internalMutation({
  args: { id: v.id('githubDeliveries'), cursor: v.string(), complete: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { id, cursor, complete }) => {
    const delivery = await ctx.db.get(id);
    if (!delivery || delivery.complete) return null;
    const task = complete ? undefined : await ctx.scheduler.runAfter(0, internal.syncActions.run, { id });
    await ctx.db.patch(id, { cursor, complete, task });
    return null;
  },
});
export const begin = internalMutation({
  args: { id: v.id('imports'), event: v.optional(v.boolean()) },
  returns: v.union(v.null(), v.number()),
  handler: async (ctx, { id, event }) => {
    const job = await ctx.db.get(id);
    if (!job || job.removal) return null;
    const revision = (job.syncRevision ?? 0) + 1;
    await ctx.db.patch(id, {
      syncRevision: revision,
      ...(event ? { syncEventRevision: (job.syncEventRevision ?? 0) + 1 } : {}),
    });
    return revision;
  },
});
export const finish = internalMutation({
  args: {
    id: v.id('imports'),
    revision: v.number(),
    observation: syncResult,
  },
  returns: v.boolean(),
  handler: async (ctx, { id, revision, observation }) => {
    const job = await ctx.db.get(id);
    if (!job || job.removal || job.syncRevision !== revision) return false;
    await ctx.db.patch(id, { sync: observation });
    return true;
  },
});
