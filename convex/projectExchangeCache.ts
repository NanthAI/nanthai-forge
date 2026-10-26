// SPDX-License-Identifier: Apache-2.0
// Only verified legacy-reader materialization calls these internal functions.
// It shares object bindings and explicit project cleanup with ordinary uploads.
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { accessibleProject } from './projectAuthority';
import { storageDigest, scanComplete, removeExclusive } from './projectStorage';
import { isStored } from './projectObjectFields';
import { r2Enabled, r2Config, r2Key } from './r2';
import { invariant } from '../src/errors';
export const prepare = internalMutation({
  args: { projectId: v.id('hostedProjects'), actor: v.string(), digest: v.string(), size: v.number() },
  returns: v.object({
    id: v.id('projectObjects'),
    stored: v.boolean(),
    created: v.boolean(),
    contentType: v.string(),
    r2Key: v.optional(v.string()),
  }),
  handler: async (ctx, input) => {
    const project = await accessibleProject(ctx, input.projectId, input.actor);
    const r2 = r2Enabled() && project.r2Writes;
    if (r2) r2Config();
    invariant(
      /^[0-9a-f]{64}$/.test(input.digest) && Number.isSafeInteger(input.size) && input.size >= 0,
      'INVALID_WORK_BACKUP',
      'Use verified logical metadata pins.',
    );
    let row = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q => q.eq('projectId', input.projectId).eq('digest', input.digest))
      .unique();
    invariant(
      !row || (row.size === input.size && !row.removed),
      'INVALID_WORK_BACKUP',
      'Logical metadata differs from its original object binding.',
    );
    const created = !row;
    if (!row) {
      const id = await ctx.db.insert('projectObjects', {
        projectId: input.projectId,
        digest: input.digest,
        size: input.size,
        nonce: crypto.randomUUID(),
        removed: false,
        ...(r2 ? { location: 'r2' as const, r2Key: r2Key(input.projectId, input.digest) } : {}),
      });
      row = (await ctx.db.get(id))!;
    }
    if (!isStored(row) && r2 && row.location !== 'r2') {
      await ctx.db.patch(row._id, { location: 'r2', r2Key: r2Key(input.projectId, input.digest) });
      row = (await ctx.db.get(row._id))!;
    } else if (!isStored(row) && !r2 && row.location === 'r2') {
      await ctx.db.patch(row._id, { location: 'convex', r2Key: undefined });
      row = (await ctx.db.get(row._id))!;
    }
    return {
      id: row._id,
      created,
      stored: isStored(row),
      contentType: `application/x-forge-object-${row.nonce}`,
      ...(row.location === 'r2' ? { r2Key: row.r2Key } : {}),
    };
  },
});
export const reconcile = internalMutation({
  args: { id: v.id('projectObjects'), actor: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ stored: v.boolean(), done: v.boolean(), cursor: v.string() }),
  handler: async (ctx, { id, actor, cursor }) => {
    const row = await ctx.db.get(id);
    invariant(row && !row.removed, 'PROJECT_UNAVAILABLE', 'Original metadata binding is unavailable.');
    await accessibleProject(ctx, row.projectId, actor);
    if (isStored(row)) return { stored: true, done: true, cursor: '' };
    if (row.location === 'r2') return { stored: false, done: true, cursor: '' };
    const page = await ctx.db.system.query('_storage').order('desc').paginate({ cursor, numItems: 100 });
    const file = page.page.find(
      item =>
        item.contentType === `application/x-forge-object-${row.nonce}` &&
        item.size === row.size &&
        storageDigest(item.sha256) === row.digest,
    );
    if (file) await ctx.db.patch(id, { storageId: file._id });
    return {
      stored: !!file,
      done: !!file || scanComplete(page, row._creationTime),
      cursor: page.continueCursor,
    };
  },
});
export const complete = internalMutation({
  args: { id: v.id('projectObjects'), actor: v.string(), storageId: v.id('_storage') },
  returns: v.null(),
  handler: async (ctx, { id, actor, storageId }) => {
    const row = await ctx.db.get(id),
      file = await ctx.db.system.get(storageId);
    invariant(
      row &&
        file &&
        file.contentType === `application/x-forge-object-${row.nonce}` &&
        file.size === row.size &&
        storageDigest(file.sha256) === row.digest,
      'INVALID_WORK_BACKUP',
      'Materialized metadata differs from its bound bytes.',
    );
    const project = await ctx.db.get(row.projectId);
    if (row.removed || !project || ['deleting', 'deleted'].includes(project.removal ?? '')) {
      await removeExclusive(ctx, storageId);
      return null;
    }
    await accessibleProject(ctx, row.projectId, actor);
    if (row.storageId || row.recipe) {
      if (row.storageId !== storageId) await removeExclusive(ctx, storageId);
      return null;
    }
    await ctx.db.patch(id, { storageId });
    return null;
  },
});

/** Internal actions call this only after a successful signed HEAD verification. */
export const completeR2 = internalMutation({
  args: { id: v.id('projectObjects'), actor: v.string(), key: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, actor, key }) => {
    const row = await ctx.db.get(id);
    invariant(
      row && !row.removed && row.location === 'r2' && row.r2Key === key,
      'INVALID_WORK_BACKUP',
      'Original artifact object binding changed.',
    );
    await accessibleProject(ctx, row.projectId, actor);
    if (!row.r2Committed) await ctx.db.patch(id, { r2Committed: true });
    return null;
  },
});

export const placement = internalQuery({
  args: { projectId: v.id('hostedProjects'), actor: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { projectId, actor }) => {
    const project = await accessibleProject(ctx, projectId, actor);
    return project.r2Writes ?? false;
  },
});
