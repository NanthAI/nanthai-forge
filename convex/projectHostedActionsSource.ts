// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { actionsSession, sessionArgs } from './projectHostedActionsSession';
import { isStored } from './projectObjectFields';
import { presignGet, r2Config } from './r2';
import { blobStore } from './blobStore';
import { directSourceWindow, directSourceBatch } from '../src/hosted-actions-direct';
import { invariant } from '../src/errors';
import { findObjects } from './projectObjectFind';
import { packRange, packHeaders } from '../src/object-pack-range';
import { signRecipeClosure } from './projectRecipeClosure';
/** One bounded descriptor+GET window. Bytes go storage→runner, never via Convex. */
export const resolve = internalMutation({
  args: {
    ...sessionArgs,
    digests: v.array(v.string()),
    batch: v.optional(v.literal(true)),
    closures: v.optional(v.literal(true)),
  },
  returns: v.any(),
  handler: async (ctx, input) => {
    await actionsSession(ctx, input, false);
    invariant(
      input.digests.length > 0 &&
        input.digests.length <= (input.batch ? directSourceBatch : directSourceWindow),
      'BAD_ARGUMENT',
      'Resolve one source window.',
    );
    const result = [];
    let sourceBytes = 0;
    let replyBytes = 2;
    invariant(
      input.digests.every(digest => /^[a-f0-9]{64}$/.test(digest)),
      'BAD_ARGUMENT',
      'Select exact source hashes.',
    );
    // A sparse historical catalog can cost two index reads per digest. Leave room
    // for the next 100 lookups and catalog pages; continue in a fresh transaction
    // instead of retrying a deterministic transaction-limit failure.
    for (let start = 0; start < input.digests.length; start += 100) {
      // Keep large-file grants as close to use as the legacy 400-object path.
      if (input.batch && start >= directSourceWindow && sourceBytes >= 8 * 1024 * 1024) break;
      if (input.batch && start) {
        const remaining = await ctx.meta.getTransactionMetrics();
        if (remaining.databaseQueries.remaining < 512 || remaining.bytesRead.remaining < 4 * 1024 * 1024)
          break;
      }
      const rows = await findObjects(ctx, input.projectId, input.digests.slice(start, start + 100));
      for (const row of rows) {
        invariant(
          row && !row.removed && isStored(row),
          'SOURCE_UNAVAILABLE',
          'Exact project object is unavailable.',
        );
        sourceBytes += row.size;
        const url =
          row.location === 'r2' && row.r2Key
            ? await presignGet(r2Config(), row.r2Key, packHeaders(packRange(row), row.size))
            : row.storageId
              ? await blobStore(ctx).getUrl(row.storageId)
              : null;
        invariant(url || row.recipe, 'SOURCE_UNAVAILABLE', 'Source storage binding is unavailable.');
        const value = {
          descriptor: {
            object: { sha256: row.digest, size: row.size },
            recipe: row.recipe ? { sha256: row.recipe.digest, size: row.recipe.size } : null,
          },
          url,
          ...(row.pack ? { range: packRange(row)! } : {}),
          ...(input.batch && input.closures && row.recipe && row.recipeClosure
            ? { closure: await signRecipeClosure(row) }
            : {}),
        };
        // Signed leaves can outweigh their parent descriptor. Keep the existing
        // prefix protocol below the Convex value limit without capping the tree.
        const bytes = new TextEncoder().encode(JSON.stringify(value)).length + 1;
        if (input.batch && result.length && replyBytes + bytes > 4 * 1024 * 1024)
          return JSON.stringify(result);
        result.push(value);
        replyBytes += bytes;
      }
    }
    return input.batch ? JSON.stringify(result) : result;
  },
});
