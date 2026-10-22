// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { backfillKind, backfillPin } from './r2BackfillFields';
import { current, pinFor, selected, tableFor } from './r2BackfillRows';
import { checkPass, maintenanceEnabled, maintenancePageSize, purgeable, verifiedPass } from './r2Maintenance';
import { invariant } from '../src/errors';
import { blobStore } from './blobStore';

const args = { projectId: v.id('hostedProjects'), pass: verifiedPass };
export const page = internalQuery({
  args: { ...args, kind: backfillKind, cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    pins: v.array(backfillPin),
    scanned: v.number(),
    cursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, { projectId, pass, kind, cursor }) => {
    checkPass(await ctx.db.get(projectId), pass);
    const result = await ctx.db
      .query(tableFor[kind])
      .withIndex('by_project', q => q.eq('projectId', projectId))
      .paginate({ cursor, numItems: maintenancePageSize });
    return {
      pins: result.page.flatMap(row => {
        const source = selected(row, kind),
          pin = pinFor(row, kind);
        return source && pin && purgeable(source, projectId, pass) ? [pin] : [];
      }),
      scanned: result.page.length,
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});
/** At most 100 row reads + 6 two-row reference probes + storage metadata per row + project.
 * < 1,401 document reads. No derived-cache scans or unbounded cleanup in this mutation. */
export const removeCopies = internalMutation({
  args: { ...args, pins: v.array(backfillPin) },
  returns: v.object({ deleted: v.number(), skipped: v.number() }),
  handler: async (ctx, { projectId, pass, pins }) => {
    maintenanceEnabled();
    checkPass(await ctx.db.get(projectId), pass);
    invariant(pins.length <= maintenancePageSize, 'BAD_ARGUMENT', 'Use one maintenance page.');
    let deleted = 0,
      skipped = 0;
    for (const pin of pins) {
      const { row, source, matches } = await current(ctx, projectId, pin);
      if (!matches || !row || !source || !purgeable(source, projectId, pass)) {
        skipped++;
        continue;
      }
      // Do not remove another row's sole copy, including another project's reference.
      const references = await Promise.all([
        ctx.db
          .query('projectObjects')
          .withIndex('by_storage', q => q.eq('storageId', pin.storageId))
          .take(2),
        ctx.db
          .query('projectBackups')
          .withIndex('by_storage', q => q.eq('storageId', pin.storageId))
          .take(2),
        ctx.db
          .query('projectProposals')
          .withIndex('by_storage', q => q.eq('storageId', pin.storageId))
          .take(2),
        ctx.db
          .query('projectBackups')
          .withIndex('by_archive_storage', q => q.eq('archiveReceipt.storageId', pin.storageId))
          .take(2),
        ctx.db
          .query('imports')
          .withIndex('by_artifactKey', q => q.eq('artifactKey', pin.storageId))
          .take(2),
        ctx.db
          .query('importArtifacts')
          .withIndex('by_artifactKey', q => q.eq('artifactKey', pin.storageId))
          .take(2),
      ]);
      if (
        references.some(rows => rows.some(ref => ref._id !== pin.id)) ||
        (pin.kind === 'archives' && row.storageId === pin.storageId) ||
        (pin.kind !== 'archives' &&
          'archiveReceipt' in row &&
          row.archiveReceipt?.storageId === pin.storageId)
      ) {
        skipped++;
        continue;
      }
      if (await ctx.db.system.get(pin.storageId)) await blobStore(ctx).delete(pin.storageId);
      // Retain storageId as the immutable archive lookup alias and retry pin, not as a live file claim.
      if (pin.kind === 'archives' && 'archiveReceipt' in row && row.archiveReceipt)
        await ctx.db.patch(row._id, { archiveReceipt: { ...row.archiveReceipt, r2ConvexPurged: true } });
      else await ctx.db.patch(row._id, { r2ConvexPurged: true });
      deleted++;
    }
    return { deleted, skipped };
  },
});
