// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { action, mutation, internalQuery, internalMutation } from './cliServer';
import { internal } from './_generated/api';
import { activeProject, activeOwnedProject } from './projectAuthority';
import { r2Config, headObject, checksumOf, type HeadResult } from './r2';
import { invariant } from '../src/errors';
import { report } from './errors';

const pending = v.object({
  id: v.id('projectObjects'),
  digest: v.string(),
  size: v.number(),
  key: v.string(),
});
/** Rows of this caller's R2 uploads that still need a HEAD check. */
export const pendingRows = internalQuery({
  args: { actor: v.string(), ids: v.array(v.id('projectObjects')) },
  returns: v.array(pending),
  handler: async (ctx, { actor, ids }) => {
    try {
      const rows = [];
      for (const id of ids) {
        const row = await ctx.db.get(id);
        invariant(row, 'PROJECT_UNAVAILABLE', 'This original upload is unavailable.');
        await activeProject(ctx, row.projectId, actor);
        invariant(
          row.location === 'r2' && row.r2Key,
          'BAD_ARGUMENT',
          'This object is not in object storage.',
        );
        if (!row.removed && !row.r2Committed)
          rows.push({ id, digest: row.digest, size: row.size, key: row.r2Key });
      }
      return rows;
    } catch (error) {
      return report(error);
    }
  },
});
export const markCommitted = internalMutation({
  args: { ids: v.array(v.id('projectObjects')) },
  returns: v.null(),
  handler: async (ctx, { ids }) => {
    for (const id of ids) {
      const row = await ctx.db.get(id);
      if (row && row.location === 'r2' && !row.removed && !row.r2Committed)
        await ctx.db.patch(id, { r2Committed: true });
    }
    return null;
  },
});

/** The first reason an object fails verification, or null when it matches. */
function mismatch(row: { digest: string; size: number }, head: HeadResult) {
  if (head.status === 'missing')
    return ['R2_OBJECT_MISSING', 'An uploaded object is not in object storage yet. Upload it again.'];
  if (head.status === 'error')
    return ['R2_VERIFY_FAILED', `Object storage could not confirm an upload (${head.detail}). Retry.`];
  if (head.size !== row.size)
    return ['R2_OBJECT_SIZE_MISMATCH', 'An uploaded object has a different size than declared.'];
  if (head.checksum && head.checksum !== checksumOf(row.digest))
    return ['R2_OBJECT_CHECKSUM_MISMATCH', 'An uploaded object has a different checksum than declared.'];
  return null;
}
/** Verify each new R2 object with one signed HEAD (in parallel), then mark the verified rows
 * committed. Failures leave their rows pending; retrying the same call is safe and cheap. */
export const commitBatch = action({
  args: { objects: v.array(v.object({ id: v.id('projectObjects') })) },
  returns: v.null(),
  handler: async (ctx, { objects }): Promise<null> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to exchange project source.');
      invariant(objects.length <= 100, 'BAD_ARGUMENT', 'Commit content in pages of at most 100.');
      const rows: { id: (typeof objects)[number]['id']; digest: string; size: number; key: string }[] =
        await ctx.runQuery(internal.projectObjectCommit.pendingRows, {
          actor: user.subject,
          ids: objects.map(object => object.id),
        });
      if (!rows.length) return null;
      const config = r2Config();
      const results = await Promise.all(
        rows.map(async row => ({ row, failure: mismatch(row, await headObject(config, row.key)) })),
      );
      const verified = results.filter(r => !r.failure).map(r => r.row.id);
      if (verified.length)
        await ctx.runMutation(internal.projectObjectCommit.markCommitted, { ids: verified });
      const failed = results.find(r => r.failure);
      invariant(!failed, failed?.failure?.[0] ?? '', failed?.failure?.[1] ?? '');
      return null;
    } catch (error) {
      return report(error);
    }
  },
});

/** Owner-only per-project opt-in for new objects in R2 (also needs FORGE_BLOBS=r2). */
export const setR2Writes = mutation({
  args: { projectId: v.id('hostedProjects'), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { projectId, enabled }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to change project settings.');
      const project = await activeOwnedProject(ctx, projectId, user.subject);
      if ((project.r2Writes ?? false) !== enabled) await ctx.db.patch(projectId, { r2Writes: enabled });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
/** Deployment-admin switch for smoke tests: `npx convex run projectObjectCommit:setR2WritesAdmin`. */
export const setR2WritesAdmin = internalMutation({
  args: { projectId: v.id('hostedProjects'), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { projectId, enabled }) => {
    await ctx.db.patch(projectId, { r2Writes: enabled });
    return null;
  },
});
