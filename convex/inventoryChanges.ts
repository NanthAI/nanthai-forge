// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference, paginationOptsValidator } from 'convex/server';
import { query } from './cliServer';
import { readerAllowed } from './sharing';
import { digest } from '../src/portable-hash';

/** Reactive invalidation contains only an opaque digest, never retained locations. */
export const watch = query({
  args: {
    kind: v.union(
      v.literal('sourceZones'),
      v.literal('savedViews'),
      v.literal('interests'),
      v.literal('interestCurrent'),
    ),
    importId: v.optional(v.id('imports')),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.string(),
  handler: async (ctx, { kind, importId, paginationOpts }) => {
    const args = kind === 'sourceZones' ? { importId, paginationOpts } : { paginationOpts };
    const current = kind === 'interestCurrent';
    const page = current
      ? {
          page: [
            await ctx.runQuery(
              makeFunctionReference<'query', Record<string, unknown>, { importId: string } | null>(
                'interests:currentRow',
              ),
              { importId },
            ),
          ].filter((row): row is { importId: string } => !!row),
        }
      : await ctx.runQuery(
          makeFunctionReference<'query', Record<string, unknown>, { page: { importId: string }[] }>(
            `${kind}:listRows`,
          ),
          args,
        );
    const actor = (await ctx.auth.getUserIdentity())?.subject;
    const access = [];
    for (const row of page.page) {
      const id = ctx.db.normalizeId('imports', row.importId);
      access.push(id ? [await ctx.db.get(id), actor ? await readerAllowed(ctx, id, actor) : false] : null);
    }
    return digest(JSON.stringify([page, access]));
  },
});
