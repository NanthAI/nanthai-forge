// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalQuery, type QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { mirrorJob } from './projectGithubMirrorQueue';
import { isStored } from './projectObjectFields';
import { presignGet, r2Config } from './r2';
import { invariant } from '../src/errors';
import { findObject } from './projectObjectFind';
import { packRange, packHeaders } from '../src/object-pack-range';
/** Read descriptors and signed R2 GETs for at most 100 stored source objects of one
 * project, as JSON. Callers check access before passing the project. */
export async function resolveObjects(ctx: QueryCtx, projectId: Id<'hostedProjects'>, digests: string[]) {
  invariant(digests.length <= 100, 'BAD_ARGUMENT', 'Resolve source in bounded windows.');
  const result = [];
  for (const digest of digests) {
    const row = await findObject(ctx, projectId, digest);
    invariant(row && !row.removed && isStored(row), 'SOURCE_UNAVAILABLE', 'Mirror source object is absent.');
    const descriptor = {
      object: { sha256: row.digest, size: row.size },
      recipe: row.recipe ? { sha256: row.recipe.digest, size: row.recipe.size } : null,
    };
    result.push({
      descriptor,
      storageId: row.location === 'r2' && row.r2Key ? null : (row.storageId ?? null),
      url:
        row.location === 'r2' && row.r2Key
          ? await presignGet(r2Config(), row.r2Key, packHeaders(packRange(row), row.size))
          : null,
      ...(row.pack ? { range: packRange(row)! } : {}),
    });
  }
  return JSON.stringify(result);
}
export const resolve = internalQuery({
  args: { jobId: v.id('projectGithubMirrorJobs'), step: v.number(), digests: v.array(v.string()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    const active = await mirrorJob(ctx, input);
    invariant(active, 'GITHUB_SYNC_PENDING', 'Mirror step changed.');
    return resolveObjects(ctx, active.job.projectId, input.digests);
  },
});
