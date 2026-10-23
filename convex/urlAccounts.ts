// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, query } from './cliServer';
import { accountFor, ensureAccount, handleTaken } from './urlIdentity';
import { handleError } from '../src/readable-urls';
import { invariant } from '../src/errors';
import { redeemInvites } from './projectContributors';
import { report } from './errors';
export const current = query({
  args: {},
  returns: v.union(v.object({ handle: v.string() }), v.null()),
  handler: async ctx => {
    const user = await ctx.auth.getUserIdentity();
    const account = user && (await accountFor(ctx, user.subject));
    return account ? { handle: account.handle } : null;
  },
});
export const ensure = mutation({
  args: {
    username: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, profile) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to set your handle.');
      await redeemInvites(ctx, user);
      return (
        await ensureAccount(ctx, user.subject, {
          username: profile.username ?? user.nickname,
          firstName: profile.firstName ?? user.givenName,
          lastName: profile.lastName ?? user.familyName,
        })
      ).handle;
    } catch (e) {
      return report(e);
    }
  },
});
export const available = query({
  args: { handle: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { handle }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return 'Sign in to set your handle.';
    return (
      handleError(handle) ??
      ((await handleTaken(ctx, handle, user.subject)) ? 'This handle is already taken.' : null)
    );
  },
});
export const set = mutation({
  args: { handle: v.string(), operationId: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to set your handle.');
      const original = await ctx.db
        .query('handleOperations')
        .withIndex('by_owner_and_operation', q =>
          q.eq('owner', user.subject).eq('operationId', input.operationId),
        )
        .unique();
      if (original) {
        invariant(
          original.handle === input.handle,
          'WORK_OPERATION_CHANGED',
          'Retry the original handle change.',
        );
        return null;
      }
      invariant(
        input.operationId.trim() && !handleError(input.handle),
        'BAD_ARGUMENT',
        handleError(input.handle) ?? 'Retain the operation id.',
      );
      invariant(
        !(await handleTaken(ctx, input.handle, user.subject)),
        'BAD_ARGUMENT',
        'This handle is already taken.',
      );
      const account = await ensureAccount(ctx, user.subject);
      if (account.handle !== input.handle) {
        if (
          !(await ctx.db
            .query('accountHandles')
            .withIndex('by_handle', q => q.eq('handle', input.handle))
            .unique())
        )
          await ctx.db.insert('accountHandles', { owner: user.subject, handle: input.handle });
        await ctx.db.patch(account._id, { handle: input.handle });
      }
      await ctx.db.insert('handleOperations', { owner: user.subject, ...input });
      return null;
    } catch (e) {
      return report(e);
    }
  },
});
