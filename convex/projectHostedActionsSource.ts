// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { actionsSession, sessionArgs } from './projectHostedActionsSession';
import { isStored } from './projectObjectFields';
import { presignGet, r2Config } from './r2';
import { blobStore } from './blobStore';
import { directSourceWindow } from '../src/hosted-actions-direct';
import { invariant } from '../src/errors';
/** One bounded descriptor+GET window. Bytes go storage→runner, never via Convex. */
export const resolve = internalMutation({
  args: { ...sessionArgs, digests: v.array(v.string()) },
  returns: v.any(),
  handler: async (ctx, input) => {
    await actionsSession(ctx, input);
    invariant(
      input.digests.length > 0 && input.digests.length <= directSourceWindow,
      'BAD_ARGUMENT',
      'Resolve one source window.',
    );
    const result = [];
    for (const digest of input.digests) {
      invariant(/^[a-f0-9]{64}$/.test(digest), 'BAD_ARGUMENT', 'Select exact source hashes.');
      const row = await ctx.db
        .query('projectObjects')
        .withIndex('by_project_and_digest', q => q.eq('projectId', input.projectId).eq('digest', digest))
        .unique();
      invariant(
        row && !row.removed && isStored(row),
        'SOURCE_UNAVAILABLE',
        'Exact project object is unavailable.',
      );
      const url =
        row.location === 'r2' && row.r2Key
          ? await presignGet(r2Config(), row.r2Key)
          : row.storageId
            ? await blobStore(ctx).getUrl(row.storageId)
            : null;
      invariant(url || row.recipe, 'SOURCE_UNAVAILABLE', 'Source storage binding is unavailable.');
      result.push({
        descriptor: {
          object: { sha256: row.digest, size: row.size },
          recipe: row.recipe ? { sha256: row.recipe.digest, size: row.recipe.size } : null,
        },
        url,
      });
    }
    return result;
  },
});
