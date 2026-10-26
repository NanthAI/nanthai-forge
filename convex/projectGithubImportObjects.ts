// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { blobStore } from './blobStore';
import { internalMutation, internalQuery } from './_generated/server';
import { activeOwnedProject } from './projectAuthority';
import { storageDigest } from './projectStorage';
import { r2Enabled } from './r2';
import { isStored } from './projectObjectFields';
import { invariant } from '../src/errors';
const pin = { projectId: v.id('hostedProjects'), actor: v.string(), digest: v.string(), size: v.number() };
/** Internal only: the importer has verified these bytes against the Git object.
 * No cross-project digest-existence oracle is exposed to clients. */
export const reuse = internalMutation({
  args: pin,
  returns: v.boolean(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const bound = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q => q.eq('projectId', input.projectId).eq('digest', input.digest))
      .unique();
    if (bound) {
      invariant(
        bound.size === input.size && !bound.removed,
        'INVALID_WORK_BACKUP',
        'Object binding changed.',
      );
      if (isStored(bound)) return true;
    }
    const shared = await ctx.db
      .query('projectObjects')
      .withIndex('by_digest_and_removed', q => q.eq('digest', input.digest).eq('removed', false))
      .take(20);
    const row = shared.find(row => row.size === input.size && row.storageId);
    if (!row) return false;
    const stored = await ctx.db.system.get(row.storageId!);
    if (!stored || stored.size !== input.size || storageDigest(stored.sha256) !== input.digest) return false;
    if (bound) await ctx.db.patch(bound._id, { storageId: row.storageId });
    else
      await ctx.db.insert('projectObjects', {
        projectId: input.projectId,
        digest: input.digest,
        size: input.size,
        nonce: crypto.randomUUID(),
        removed: false,
        storageId: row.storageId!,
      });
    return true;
  },
});
export const bind = internalMutation({
  args: { ...pin, storageId: v.id('_storage'), nonce: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const stored = await ctx.db.system.get(input.storageId);
    invariant(
      stored &&
        stored.size === input.size &&
        storageDigest(stored.sha256) === input.digest &&
        stored.contentType === `application/x-forge-object-${input.nonce}`,
      'INVALID_WORK_BACKUP',
      'Imported object differs from verified source.',
    );
    const own = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q => q.eq('projectId', input.projectId).eq('digest', input.digest))
      .unique();
    if (own && isStored(own)) {
      if (own.storageId !== input.storageId) await blobStore(ctx).delete(input.storageId);
      return null;
    }
    const shared = await ctx.db
      .query('projectObjects')
      .withIndex('by_digest_and_removed', q => q.eq('digest', input.digest).eq('removed', false))
      .take(20);
    const existing = shared.find(row => row.storageId && row.size === input.size);
    const storageId = existing?.storageId ?? input.storageId;
    if (own) await ctx.db.patch(own._id, { storageId });
    else
      await ctx.db.insert('projectObjects', {
        projectId: input.projectId,
        digest: input.digest,
        size: input.size,
        nonce: input.nonce,
        removed: false,
        storageId,
      });
    if (storageId !== input.storageId) await blobStore(ctx).delete(input.storageId);
    return null;
  },
});
export const stored = internalQuery({
  args: pin,
  returns: v.boolean(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const row = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q => q.eq('projectId', input.projectId).eq('digest', input.digest))
      .unique();
    return !!(row && !row.removed && row.size === input.size && isStored(row));
  },
});

/** Reserve the nonce before storage so explicit project removal can reconcile
 * uploads whose action stopped before recording their storage ID. */
export const reserve = internalMutation({
  args: pin,
  returns: v.string(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const row = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q => q.eq('projectId', input.projectId).eq('digest', input.digest))
      .unique();
    if (row) {
      invariant(row.size === input.size && !row.removed, 'INVALID_WORK_BACKUP', 'Object binding changed.');
      return row.nonce;
    }
    const nonce = crypto.randomUUID();
    await ctx.db.insert('projectObjects', {
      projectId: input.projectId,
      digest: input.digest,
      size: input.size,
      nonce,
      removed: false,
    });
    return nonce;
  },
});

export const placement = internalQuery({
  args: { projectId: v.id('hostedProjects'), actor: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { projectId, actor }) => {
    const project = await activeOwnedProject(ctx, projectId, actor);
    return !!(r2Enabled() && project.r2Writes);
  },
});
