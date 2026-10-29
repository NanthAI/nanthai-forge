// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalQuery } from './_generated/server';
import { mirrorJob } from './projectGithubMirrorQueue';
import { isStored } from './projectObjectFields';
import { presignGet, r2Config } from './r2';
import { invariant } from '../src/errors';
export const resolve = internalQuery({
  args: { jobId: v.id('projectGithubMirrorJobs'), step: v.number(), digests: v.array(v.string()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    const active = await mirrorJob(ctx, input);
    invariant(active, 'GITHUB_SYNC_PENDING', 'Mirror step changed.');
    invariant(input.digests.length <= 100, 'BAD_ARGUMENT', 'Resolve source in bounded windows.');
    const result = [];
    for (const digest of input.digests) {
      const row = await ctx.db
        .query('projectObjects')
        .withIndex('by_project_and_digest', q => q.eq('projectId', active.job.projectId).eq('digest', digest))
        .unique();
      invariant(
        row && !row.removed && isStored(row),
        'SOURCE_UNAVAILABLE',
        'Mirror source object is absent.',
      );
      const descriptor = {
        object: { sha256: row.digest, size: row.size },
        recipe: row.recipe ? { sha256: row.recipe.digest, size: row.recipe.size } : null,
      };
      result.push({
        descriptor,
        storageId: row.storageId ?? null,
        url: row.location === 'r2' && row.r2Key ? await presignGet(r2Config(), row.r2Key) : null,
      });
    }
    return JSON.stringify(result);
  },
});
