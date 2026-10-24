import type { Doc, Id } from './_generated/dataModel';
import type { PaginationResult } from 'convex/server';
import { inventoryPage } from './inventoryPage';
import { action } from './cliServer';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { mutation, internalQuery, internalMutation } from './cliServer';
import { savedLink, savedRoute } from './schema';
import { invariant } from '../src/errors';
import { report } from './errors';
import { readerAllowed } from './sharing';

const item = v.object({
  id: v.id('savedViews'),
  importId: v.id('imports'),
  name: v.string(),
  route: savedRoute,
});
export const listRows = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(item),
  handler: async (ctx, { paginationOpts }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return { page: [], isDone: true, continueCursor: '' };
    const result = await ctx.db
      .query('savedViews')
      .withIndex('by_owner', q => q.eq('owner', user.subject))
      .order('desc')
      .paginate(paginationOpts);
    const visible = [];
    for (const row of result.page) {
      visible.push(row);
    }
    return {
      ...result,
      page: visible.map(row => ({
        id: row._id,
        importId: row.importId,
        name: row.name,
        route: row.route,
      })),
    };
  },
});
export const list = action({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(item),
  handler: (
    ctx,
    args,
  ): Promise<
    PaginationResult<{
      id: Id<'savedViews'>;
      importId: Id<'imports'>;
      name: string;
      route: Doc<'savedViews'>['route'];
    }>
  > => inventoryPage(ctx, 'savedViews:listRows', args),
});
export const receipt = internalQuery({
  args: { operationId: v.string() },
  returns: v.union(v.null(), item),
  handler: async (ctx, { operationId }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return null;
    const row = await ctx.db
      .query('savedViews')
      .withIndex('by_owner_and_operationId', q => q.eq('owner', user.subject).eq('operationId', operationId))
      .unique();
    return row ? { id: row._id, importId: row.importId, name: row.name, route: row.route } : null;
  },
});
export const put = internalMutation({
  args: savedLink,
  returns: v.id('savedViews'),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    invariant(user, 'GITHUB_UNAVAILABLE', 'Sign in to save a personal view.');
    const existing = await ctx.db
      .query('savedViews')
      .withIndex('by_owner_and_operationId', q =>
        q.eq('owner', user.subject).eq('operationId', args.operationId),
      )
      .unique();
    if (existing) {
      invariant(
        existing.importId === args.importId &&
          Object.keys({ ...existing.route, ...args.route }).every(
            key =>
              existing.route[key as keyof typeof args.route] === args.route[key as keyof typeof args.route],
          ),
        'BAD_ARGUMENT',
        'This save operation already names another view.',
      );
      return existing._id;
    }
    const removed = await ctx.db
      .query('accountItems')
      .withIndex('by_owner_and_kind_and_creation_operation_and_state', q =>
        q
          .eq('owner', user.subject)
          .eq('kind', 'view')
          .eq('expected.creationOperationId', args.operationId)
          .eq('state', 'completed'),
      )
      .take(1);
    invariant(
      !removed.length,
      'ACCOUNT_UNAVAILABLE',
      'This original save was removed by your recorded Forge data operation.',
    );
    const job = await ctx.db.get(args.importId);
    const reader =
      job?.visibility === 'private' && job.owner !== user.subject
        ? await readerAllowed(ctx, args.importId, user.subject)
        : false;
    invariant(
      job && !job.removal && (job.visibility === 'public' || job.owner === user.subject || reader),
      'GITHUB_UNAVAILABLE',
      'This Codescape is unavailable with the current access.',
    );
    invariant(args.name.trim(), 'BAD_ARGUMENT', 'Enter a saved view name.');
    return ctx.db.insert('savedViews', { ...args, name: args.name.trim(), owner: user.subject });
  },
});
export const rename = mutation({
  args: { id: v.id('savedViews'), name: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, name }) => {
    try {
      const user = await ctx.auth.getUserIdentity(),
        row = await ctx.db.get(id);
      invariant(user && row?.owner === user.subject, 'GITHUB_UNAVAILABLE', 'This saved view is unavailable.');
      invariant(name.trim(), 'BAD_ARGUMENT', 'Enter a saved view name.');
      await ctx.db.patch(id, { name: name.trim() });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export const remove = mutation({
  args: { id: v.id('savedViews') },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'GITHUB_UNAVAILABLE', 'Sign in to manage saved views.');
      const row = await ctx.db.get(id);
      // Missing/other-owner IDs are identical no-ops; lost deletion replies reconcile without an existence oracle.
      if (row?.owner === user.subject) await ctx.db.delete(id);
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
