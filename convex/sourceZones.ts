// SPDX-License-Identifier: Apache-2.0

import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { internalQuery, type MutationCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { zoneDocument } from './schema';
import { trackArtifact } from './artifacts';
import { invariant } from '../src/errors';
import { report } from './errors';

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
      .withIndex('by_zoneId_and_operationId', q => q.eq('zoneId', zone._id))
      .take(50);
    for (const row of [...readers, ...changes]) await ctx.db.delete(row._id);
    if (readers.length === 50 || changes.length === 50) remaining = true;
    else await ctx.db.delete(zone._id);
  }
  return remaining;
}
