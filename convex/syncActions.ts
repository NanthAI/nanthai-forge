// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { currentAccess } from './access';
import { githubJson } from '../src/github';
import { ForgeError, invariant } from '../src/errors';
import type { Doc } from './_generated/dataModel';

export const run = internalAction({
  args: { id: v.id('githubDeliveries') },
  returns: v.null(),
  handler: async (ctx, { id }): Promise<null> => {
    // Two jobs leave room for each existing thirty-second provider timeout within Convex's ten-minute action ceiling.
    const batch: { page: Doc<'imports'>[]; isDone: boolean; continueCursor: string } | null =
      await ctx.runQuery(internal.sync.page, { id, paginationOpts: { cursor: null, numItems: 2 } });
    if (!batch) return null;
    for (const job of batch.page) {
      const revision: number | null = await ctx.runMutation(internal.sync.begin, {
        id: job._id,
        event: true,
      });
      if (revision === null) continue;
      let observation: { checkedAt: number; result: 'checked' | 'unavailable' | 'error'; head?: string };
      try {
        const access = await currentAccess(ctx, job._id, job.owner || undefined);
        const latest = await githubJson<{ sha: string }>(
          `/repos/${access.repository.full_name}/commits/${encodeURIComponent(job.ref)}`,
          access.token,
        );
        invariant(
          /^[a-f0-9]{40,64}$/.test(latest.sha),
          'GITHUB_RESPONSE',
          'GitHub returned an invalid source revision.',
        );
        observation = { checkedAt: Date.now(), result: 'checked', head: latest.sha };
      } catch (error) {
        observation = {
          checkedAt: Date.now(),
          result:
            error instanceof ForgeError && error.code === 'GITHUB_UNAVAILABLE' ? 'unavailable' : 'error',
        };
      }
      await ctx.runMutation(internal.sync.finish, { id: job._id, revision, observation });
    }
    await ctx.runMutation(internal.sync.advance, {
      id,
      cursor: batch.continueCursor,
      complete: batch.isDone,
    });
    return null;
  },
});
