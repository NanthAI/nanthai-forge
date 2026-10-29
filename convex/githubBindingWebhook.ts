// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { bindingInstallation } from './githubBindingAccess';
import { invariant } from '../src/errors';
/** HMAC-verified HTTP route only. Uninstall is one tombstone, never a table scan. */
export const invalidate = internalMutation({
  args: {
    delivery: v.string(),
    installationId: v.number(),
    removed: v.boolean(),
    repoIds: v.array(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    invariant(input.repoIds.length <= 100, 'BAD_ARGUMENT', 'Pass one webhook page.');
    if (
      await ctx.db
        .query('githubBindingWebhookReceipts')
        .withIndex('by_delivery', q => q.eq('delivery', input.delivery))
        .unique()
    )
      return null;
    const prior = await bindingInstallation(ctx, input.installationId);
    const value = {
      installationId: input.installationId,
      revision: (prior?.revision ?? 0) + 1,
      removed: input.removed || !!prior?.removed,
    };
    if (prior) await ctx.db.replace(prior._id, value);
    else await ctx.db.insert('githubBindingInstallations', value);
    for (const repoId of input.repoIds) {
      const row = await ctx.db
        .query('projectGithubBindings')
        .withIndex('by_repo', q => q.eq('repoId', repoId))
        .unique();
      if (row?.installationId === input.installationId) await ctx.db.delete(row._id);
    }
    await ctx.db.insert('githubBindingWebhookReceipts', { delivery: input.delivery });
    return null;
  },
});
