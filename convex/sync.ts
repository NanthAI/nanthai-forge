// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { internalMutation, internalQuery } from './server';
import type { MutationCtx } from './_generated/server';
import { invariant } from '../src/errors';
import { internal } from './_generated/api';
import { jobDocument, syncResult } from './schema';

/** Most repositories one installation-level delivery may refresh (10 pages of
 * 100 indexed lookups). Larger payloads refresh on the next push or read. */
export const INSTALLATION_EVENT_REPOSITORY_LIMIT = 1000;
export const INSTALLATION_EVENT_PAGE = 100;
const repositoryName = /^[\w.-]+\/[\w.-]+$/;
/** Repository names an installation-level event names, deduplicated and capped. */
export function installationRepositories(payload: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const key of ['repositories', 'repositories_added', 'repositories_removed']) {
    const list = payload[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (names.size >= INSTALLATION_EVENT_REPOSITORY_LIMIT) return [...names];
      const name = (item as { full_name?: unknown } | null)?.full_name;
      if (
        typeof name === 'string' &&
        repositoryName.test(name) &&
        name.split('/').every(part => part !== '.' && part !== '..')
      )
        names.add(name);
    }
  }
  return [...names];
}
type Delivery = { delivery: string; event: string; repository: string };
async function enqueue(ctx: MutationCtx, args: Delivery) {
  const previous = await ctx.db
    .query('githubDeliveries')
    .withIndex('by_delivery', q => q.eq('delivery', args.delivery))
    .unique();
  if (previous) {
    if (previous.complete) return;
    const task = previous.task ? await ctx.db.system.get(previous.task) : null;
    if (task && ['pending', 'inProgress'].includes(task.state.kind)) return;
    const scheduled = await ctx.scheduler.runAfter(0, internal.syncActions.run, { id: previous._id });
    await ctx.db.patch(previous._id, { task: scheduled });
  } else {
    const id = await ctx.db.insert('githubDeliveries', { ...args, cursor: null, complete: false });
    const task = await ctx.scheduler.runAfter(0, internal.syncActions.run, { id });
    await ctx.db.patch(id, { task });
  }
}
/** Push deliveries name one repository and refresh its imports by index. */
export const receive = internalMutation({
  args: { delivery: v.string(), event: v.string(), repository: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await enqueue(ctx, args);
    return null;
  },
});
/** One page of an installation-level delivery: only named repositories that
 * have imports get a delivery and a scheduled refresh; others write nothing. */
export const receiveRepositories = internalMutation({
  args: { delivery: v.string(), event: v.string(), repositories: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { delivery, event, repositories }) => {
    invariant(repositories.length <= INSTALLATION_EVENT_PAGE, 'BAD_ARGUMENT', 'Pass one webhook page.');
    for (const repository of repositories) {
      const imported = await ctx.db
        .query('imports')
        .withIndex('by_repository', q => q.eq('repository', repository))
        .first();
      if (imported) await enqueue(ctx, { delivery: `${delivery}:${repository}`, event, repository });
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
    // Deliveries always name a repository; older rows without one complete with no work.
    if (!delivery.repository) return { page: [], isDone: true, continueCursor: delivery.cursor ?? '' };
    const result = await ctx.db
      .query('imports')
      .withIndex('by_repository', q => q.eq('repository', delivery.repository!))
      .paginate({ ...paginationOpts, cursor: delivery.cursor });
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
