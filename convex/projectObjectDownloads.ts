// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { isR2Object } from './projectObjectFields';
import { r2Config, r2Key, presignGet } from './r2';
import { invariant } from '../src/errors';
import { report } from './errors';

/** The single choke point for reading R2 bytes: a signed GET (5 minutes) for each requested digest
 * that is a committed R2 object of this project, after a fresh access check on every call. Anything
 * else (unknown, pending, another project's, or stored in Convex) is simply absent from the result,
 * so the caller learns nothing beyond what it can already list. A mutation so that results are never
 * cached across calls and a URL is always freshly signed. It writes nothing. Public projects sign
 * without sign-in. Committed rows stay readable when `FORGE_BLOBS` is unset, while the R2 settings
 * are configured; without them this fails closed.
 * TODO(owner): anonymous signing for public projects has no budget counter yet (docs/r2-storage-plan.md). */
export const signDownloads = mutation({
  args: { projectId: v.id('hostedProjects'), digests: v.array(v.string()) },
  returns: v.array(v.object({ digest: v.string(), size: v.number(), url: v.string() })),
  handler: async (ctx, { projectId, digests }) => {
    try {
      invariant(digests.length <= 100, 'BAD_ARGUMENT', 'Sign downloads in pages of at most 100.');
      const user = await ctx.auth.getUserIdentity();
      if (user) await accessibleProject(ctx, projectId, user.subject);
      else {
        const project = await ctx.db.get(projectId);
        invariant(
          project && project.visibility === 'public' && !project.removal,
          'PROJECT_UNAVAILABLE',
          'This Forge project is unavailable with the current account.',
        );
      }
      const found = [];
      for (const digest of new Set(digests)) {
        if (!/^[0-9a-f]{64}$/.test(digest)) continue;
        const row = await ctx.db
          .query('projectObjects')
          .withIndex('by_project_and_digest', q => q.eq('projectId', projectId).eq('digest', digest))
          .unique();
        if (row && !row.removed && isR2Object(row) && row.r2Key === r2Key(projectId, digest))
          found.push({ digest, size: row.size, key: row.r2Key });
      }
      if (!found.length) return [];
      const config = r2Config();
      return await Promise.all(
        found.map(async ({ digest, size, key }) => ({ digest, size, url: await presignGet(config, key) })),
      );
    } catch (error) {
      return report(error);
    }
  },
});
