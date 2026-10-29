// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { blobStore } from './blobStore';
import { artifactBlobId } from './artifactBlobFields';
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import { artifactMetadata } from './artifactStorage';
import { storageDigest, scanComplete } from './storageDigest';
import { derivedFields } from './derivedArtifactFields';
const key = { original: v.string(), kind: v.string(), pin: v.string() };
const find = (ctx: Pick<QueryCtx, 'db'>, args: { original: string; kind: string; pin: string }) =>
  ctx.db
    .query('derivedArtifacts')
    .withIndex('by_original_and_kind_and_pin', q =>
      q.eq('original', args.original).eq('kind', args.kind).eq('pin', args.pin),
    )
    .unique();
// Source-free reservations precede every storage side effect. Derived bytes never
// confer access; callers own current authorization and original source authority.
export const get = internalQuery({
  args: key,
  returns: v.any(),
  handler: async (ctx, args) => {
    const row = await find(ctx, args);
    return row?.removed ? null : row;
  },
});
export const reserve = internalMutation({
  args: { ...derivedFields, replace: v.optional(v.id('derivedArtifacts')) },
  returns: v.any(),
  handler: async (ctx, input) => {
    const { replace, ...args } = input,
      original = await artifactMetadata(ctx, args.original);
    if (
      !original ||
      original.size !== args.originalSize ||
      storageDigest(original.sha256) !== args.originalDigest
    )
      return null;
    const old = await find(ctx, args);
    if (old) {
      if (old.removed) return null;
      if (old._id !== replace) return old;
      const current = old.storageId ? await artifactMetadata(ctx, old.storageId) : null;
      const sameBytes =
        old.originalDigest === args.originalDigest &&
        old.originalSize === args.originalSize &&
        old.digest === args.digest &&
        old.size === args.size &&
        old.contentType === args.contentType;
      if (
        sameBytes &&
        ((current && current.size === old.size && storageDigest(current.sha256) === old.digest) ||
          (old.inline !== undefined && old.inline === args.inline))
      )
        return old;
      // Lost replies remain attributable by the original upload MIME. Missing stored
      // files may be rebuilt with the same reservation, preserving its cleanup owner.
      if (old.storageId) await blobStore(ctx).delete(old.storageId);
      await ctx.db.patch(old._id, {
        storageId: undefined,
        inline: args.inline,
        digest: args.digest,
        size: args.size,
        contentType: args.contentType,
      });
      return ctx.db.get(old._id);
    }
    const id = await ctx.db.insert('derivedArtifacts', args);
    return ctx.db.get(id);
  },
});
export const attach = internalMutation({
  args: { id: v.id('derivedArtifacts'), storageId: v.string() },
  returns: v.any(),
  handler: async (ctx, { id, storageId }) => {
    const row = await ctx.db.get(id),
      file = await artifactMetadata(ctx, storageId);
    if (
      !row ||
      !file ||
      file.contentType !== row.uploadType ||
      file.size !== row.size ||
      storageDigest(file.sha256) !== row.digest
    )
      return null;
    if (row.removed || !(await artifactMetadata(ctx, row.original))) {
      await blobStore(ctx).delete(storageId);
      return null;
    }
    if (row.storageId && row.storageId !== storageId) {
      await blobStore(ctx).delete(storageId);
      return row;
    }
    await ctx.db.patch(id, { storageId });
    return ctx.db.get(id);
  },
});
export const uploadPage = internalQuery({
  args: { id: v.id('derivedArtifacts'), cursor: v.union(v.string(), v.null()) },
  returns: v.any(),
  handler: async (ctx, { id, cursor }) => {
    const row = await ctx.db.get(id);
    if (!row || row.removed || !(await artifactMetadata(ctx, row.original)))
      return { storageId: null, isDone: true, cursor: '' };
    const page = await ctx.db.system.query('_storage').order('desc').paginate({ cursor, numItems: 100 });
    const found = page.page.find(
      file =>
        file.contentType === row.uploadType &&
        file.size === row.size &&
        storageDigest(file.sha256) === row.digest,
    );
    return {
      storageId: found?._id ?? null,
      isDone: scanComplete(page, row._creationTime),
      cursor: page.continueCursor,
    };
  },
});
export const discard = internalMutation({
  args: { id: v.id('derivedArtifacts'), storageId: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, storageId }) => {
    const row = await ctx.db.get(id),
      file = await artifactMetadata(ctx, storageId);
    if (
      row?.storageId !== storageId &&
      row &&
      file &&
      file.contentType === row.uploadType &&
      file.size === row.size &&
      storageDigest(file.sha256) === row.digest
    )
      await blobStore(ctx).delete(storageId);
    return null;
  },
});
export async function removeDerived(ctx: MutationCtx, original: string): Promise<void> {
  const rows = await ctx.db
    .query('derivedArtifacts')
    .withIndex('by_original_and_removed', q => q.eq('original', original).eq('removed', false))
    .take(50);
  for (const row of rows) {
    if (row.storageId) await blobStore(ctx).delete(row.storageId);
    if (row.uploadType) {
      await ctx.db.patch(row._id, { removed: true, storageId: undefined, inline: undefined });
      if (
        !row.uploadType.startsWith('application/x-forge-derived-r2-') &&
        !artifactBlobId(row.storageId ?? '')
      )
        await ctx.scheduler.runAfter(0, internal.derivedArtifacts.sweep, {
          id: row._id,
          cursor: null,
          followup: false,
        });
    } else await ctx.db.delete(row._id);
  }
  if (rows.length === 50) await ctx.scheduler.runAfter(0, internal.derivedArtifacts.purge, { original });
}
export const purge = internalMutation({
  args: { original: v.string() },
  returns: v.null(),
  handler: async (ctx, { original }) => {
    if (!(await artifactMetadata(ctx, original))) await removeDerived(ctx, original);
    return null;
  },
});
export const sweep = internalMutation({
  args: { id: v.id('derivedArtifacts'), cursor: v.union(v.string(), v.null()), followup: v.boolean() },
  returns: v.union(v.null(), v.object({ isDone: v.boolean(), cursor: v.string() })),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row?.removed || !row.uploadType) return null;
    if (row.uploadType.startsWith('application/x-forge-derived-r2-')) return { isDone: true, cursor: '' };
    const page = await ctx.db.system
      .query('_storage')
      .order('desc')
      .paginate({ cursor: args.cursor, numItems: 100 });
    for (const file of page.page)
      if (
        file.contentType === row.uploadType &&
        file.size === row.size &&
        storageDigest(file.sha256) === row.digest
      )
        await blobStore(ctx).delete(file._id);
    // Manual legacy purge only: the caller advances the returned cursor.
    // Retain the source-free binding for later late-outcome reconciliation. A timed
    // pass isn't proof that an unknown storage operation can never commit afterwards.
    return { isDone: scanComplete(page, row._creationTime), cursor: page.continueCursor };
  },
});
