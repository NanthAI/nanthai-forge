// SPDX-License-Identifier: Apache-2.0

import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { internalQuery } from './cliServer';
import { interestDocument } from './schema';

export const currentRow = internalQuery({
  args: { importId: v.id('imports') },
  returns: v.union(interestDocument, v.null()),
  handler: async (ctx, { importId }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return null;

    return ctx.db
      .query('projectInterests')
      .withIndex('by_owner_and_importId', q => q.eq('owner', user.subject).eq('importId', importId))
      .unique();
  },
});

export const listRows = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(interestDocument),
  handler: async (ctx, { paginationOpts }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return { page: [], isDone: true, continueCursor: '' };
    const result = await ctx.db
      .query('projectInterests')
      .withIndex('by_owner_and_active', q => q.eq('owner', user.subject).eq('active', true))
      .order('desc')
      .paginate(paginationOpts);
    const page = [];
    for (const row of result.page) {
      page.push(row);
    }
    return { ...result, page };
  },
});
