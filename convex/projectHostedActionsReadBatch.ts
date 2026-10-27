// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { authorizeActionsTransfer } from './projectHostedActionsTransfers';
import { saveObject } from './projectHostedSaveStore';
import { blobStore } from './blobStore';
import { presignGet, r2Config } from './r2';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

/** One live job/actor/epoch/lease check per bounded window, never a reusable
 * authorization cache. Recipe leaves still require their own exact grants. */
export const describeAndGrant = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    input: v.string(),
    executionId: v.string(),
    sha256s: v.array(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    await authorizeActionsTransfer(ctx, input);
    invariant(
      input.sha256s.length > 0 &&
        input.sha256s.length <= 100 &&
        input.sha256s.every(hash => /^[0-9a-f]{64}$/.test(hash)) &&
        new Set(input.sha256s).size === input.sha256s.length,
      'BAD_ARGUMENT',
      'Select a window of at most 100 unique exact source digests.',
    );
    const result = [];
    for (const sha256 of input.sha256s) {
      const descriptor = await saveObject(ctx, input.projectId, { sha256 });
      let target = null;
      if (!descriptor.recipe) {
        const row = await ctx.db
          .query('projectObjects')
          .withIndex('by_project_and_digest', q => q.eq('projectId', input.projectId).eq('digest', sha256))
          .unique();
        const url =
          row?.location === 'r2' && row.r2Key
            ? await presignGet(r2Config(), row.r2Key)
            : row?.storageId
              ? await blobStore(ctx).getUrl(row.storageId)
              : null;
        invariant(url, 'SOURCE_UNAVAILABLE', 'Read the exact raw source or its recipe leaves.');
        target = { url, headers: {} };
      }
      result.push({ descriptor, target });
    }
    return canonicalPayload(result);
  },
});
