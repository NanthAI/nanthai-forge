import type { PaginationResult } from 'convex/server';
import { inventoryPage } from './inventoryPage';
import { action } from './cliServer';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query, internalQuery, internalMutation, type QueryCtx, type MutationCtx } from './cliServer';
import type { Doc, Id } from './_generated/dataModel';
import { zoneDocument, zoneFields, zoneUpdate, zoneChange } from './schema';
import { trackArtifact } from './artifacts';
import { invariant } from '../src/errors';
import { report } from './errors';

async function owned(ctx: QueryCtx | MutationCtx, id: Id<'sourceZones'>, actor: string | undefined) {
  try {
    const zone = await ctx.db.get(id),
      job = zone && (await ctx.db.get(zone.importId));
    invariant(
      actor &&
        zone?.owner === actor &&
        job?.owner === actor &&
        job.visibility === 'private' &&
        job.removal !== 'deleting',
      'ZONE_UNAVAILABLE',
      'This source Zone is unavailable with the current access.',
    );
    return zone;
  } catch (error) {
    return report(error);
  }
}
export const created = internalQuery({
  args: { owner: v.string(), operationId: v.string() },
  returns: v.union(zoneDocument, v.null()),
  handler: (ctx, { owner, operationId }) =>
    ctx.db
      .query('sourceZones')
      .withIndex('by_owner_and_operationId', q => q.eq('owner', owner).eq('operationId', operationId))
      .unique(),
});
export const changed = internalQuery({
  args: { id: v.id('sourceZones'), owner: v.string(), operationId: v.string() },
  returns: v.union(v.object(zoneChange), v.null()),
  handler: async (ctx, { id, owner, operationId }) => {
    await owned(ctx, id, owner);
    const row = await ctx.db
      .query('zoneChanges')
      .withIndex('by_zoneId_and_operationId', q => q.eq('zoneId', id).eq('operationId', operationId))
      .unique();
    return row
      ? {
          zoneId: row.zoneId,
          operationId: row.operationId,
          request: row.request,
          previousRevision: row.previousRevision,
          revision: row.revision,
          at: row.at,
          update: row.update,
        }
      : null;
  },
});
export const issue = internalMutation({
  args: zoneFields,
  returns: zoneDocument,
  handler: async (ctx, input) => {
    try {
      const old = await ctx.db
        .query('sourceZones')
        .withIndex('by_owner_and_operationId', q =>
          q.eq('owner', input.owner).eq('operationId', input.operationId),
        )
        .unique();
      if (old) {
        invariant(
          old.request === input.request,
          'ZONE_OPERATION_CHANGED',
          'Reconcile the original source Zone request.',
        );
        return old;
      }
      const job = await ctx.db.get(input.importId);
      invariant(
        job &&
          !job.removal &&
          job.owner === input.owner &&
          job.visibility === 'private' &&
          job.artifactKey === input.artifactKey,
        'ZONE_SOURCE_CHANGED',
        'The import changed. Choose its snapshot explicitly.',
      );
      await trackArtifact(ctx, input.importId, input.artifactKey);
      const id = await ctx.db.insert('sourceZones', input);
      return (await ctx.db.get(id))!;
    } catch (error) {
      return report(error);
    }
  },
});
export const authorize = internalQuery({
  args: { id: v.id('sourceZones'), actor: v.string() },
  returns: zoneDocument,
  handler: async (ctx, { id, actor }) => {
    try {
      const zone = await ctx.db.get(id),
        job = zone && (await ctx.db.get(zone.importId));
      invariant(
        zone?.enabled &&
          job &&
          !job.removal &&
          job.owner === zone.owner &&
          job.visibility === 'private' &&
          (job.artifactKey === zone.artifactKey ||
            (await ctx.db
              .query('importArtifacts')
              .withIndex('by_importId_and_artifactKey', q =>
                q.eq('importId', zone.importId).eq('artifactKey', zone.artifactKey),
              )
              .unique())) &&
          (zone.owner === actor ||
            (await ctx.db
              .query('zoneReaders')
              .withIndex('by_zoneId_and_reader', q => q.eq('zoneId', id).eq('reader', actor))
              .unique())),
        'ZONE_UNAVAILABLE',
        'This source Zone is unavailable with the current access.',
      );
      return zone;
    } catch (error) {
      return report(error);
    }
  },
});
export const change = internalMutation({
  args: {
    id: v.id('sourceZones'),
    owner: v.string(),
    operationId: v.string(),
    request: v.string(),
    expectedRevision: v.number(),
    update: zoneUpdate,
  },
  returns: v.object(zoneChange),
  handler: async (ctx, { id, owner, operationId, request, expectedRevision, update }) => {
    try {
      const zone = await owned(ctx, id, owner);
      const previous = await ctx.db
        .query('zoneChanges')
        .withIndex('by_zoneId_and_operationId', q => q.eq('zoneId', id).eq('operationId', operationId))
        .unique();
      if (previous) {
        invariant(
          previous.request === request,
          'ZONE_OPERATION_CHANGED',
          'Reconcile the original source Zone change.',
        );
        const { _id: ignoredId, _creationTime: ignoredTime, ...receipt } = previous;
        void ignoredId;
        void ignoredTime;
        return receipt;
      }
      invariant(
        Number.isSafeInteger(expectedRevision) && zone.revision === expectedRevision,
        'ZONE_CHANGED',
        'The source Zone policy changed. Refresh before saving; original work is retained.',
      );
      if (update.kind === 'reader') {
        const row = await ctx.db
          .query('zoneReaders')
          .withIndex('by_zoneId_and_reader', q => q.eq('zoneId', id).eq('reader', update.reader))
          .unique();
        if (update.present && !row && update.reader !== owner)
          await ctx.db.insert('zoneReaders', { zoneId: id, reader: update.reader });
        if (!update.present && row) await ctx.db.delete(row._id);
      }
      const receipt = {
        zoneId: id,
        operationId,
        request,
        previousRevision: zone.revision,
        revision: zone.revision + 1,
        at: Date.now(),
        update,
      };
      await ctx.db.patch(id, {
        revision: receipt.revision,
        ...(update.kind === 'enabled' ? { enabled: update.enabled } : {}),
      });
      await ctx.db.insert('zoneChanges', receipt);
      return receipt;
    } catch (error) {
      return report(error);
    }
  },
});
export const listRows = internalQuery({
  args: { importId: v.id('imports'), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(zoneDocument),
  handler: async (ctx, { importId, paginationOpts }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return { page: [], isDone: true, continueCursor: '' };
    return ctx.db
      .query('sourceZones')
      .withIndex('by_owner_and_importId', q => q.eq('owner', user.subject).eq('importId', importId))
      .order('desc')
      .paginate(paginationOpts);
  },
});
export const list = action({
  args: { importId: v.id('imports'), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(zoneDocument),
  handler: (ctx, args): Promise<PaginationResult<Doc<'sourceZones'>>> =>
    inventoryPage(ctx, 'sourceZones:listRows', args),
});
export const readers = query({
  args: { id: v.id('sourceZones'), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ reader: v.string() })),
  handler: async (ctx, { id, paginationOpts }) => {
    try {
      await owned(ctx, id, (await ctx.auth.getUserIdentity())?.subject);
      const page = await ctx.db
        .query('zoneReaders')
        .withIndex('by_zoneId_and_reader', q => q.eq('zoneId', id))
        .paginate(paginationOpts);
      return { ...page, page: page.page.map(row => ({ reader: row.reader })) };
    } catch (error) {
      return report(error);
    }
  },
});
export const candidates = internalQuery({
  args: { actor: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.id('sourceZones')),
  handler: async (ctx, { actor, paginationOpts }) => {
    const result = await ctx.db
      .query('zoneReaders')
      .withIndex('by_reader_and_zoneId', q => q.eq('reader', actor))
      .paginate(paginationOpts);
    return { ...result, page: result.page.map(row => row.zoneId) };
  },
});

export async function purgeSourceZones(ctx: MutationCtx, importId: Id<'imports'>) {
  const zones = await ctx.db
    .query('sourceZones')
    .withIndex('by_importId', q => q.eq('importId', importId))
    .take(20);
  let remaining = zones.length === 20;
  for (const zone of zones) {
    await trackArtifact(ctx, importId, zone.artifactKey);
    const readers = await ctx.db
      .query('zoneReaders')
      .withIndex('by_zoneId_and_reader', q => q.eq('zoneId', zone._id))
      .take(50);
    const changes = await ctx.db
      .query('zoneChanges')
      .withIndex('by_zoneId', q => q.eq('zoneId', zone._id))
      .take(50);
    for (const row of [...readers, ...changes]) await ctx.db.delete(row._id);
    if (readers.length === 50 || changes.length === 50) remaining = true;
    else await ctx.db.delete(zone._id);
  }
  return remaining;
}
