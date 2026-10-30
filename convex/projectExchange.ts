// SPDX-License-Identifier: Apache-2.0

import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { activeOwnedProject } from './projectAuthority';
import { isStored } from './projectObjectFields';

import { invariant } from '../src/errors';
import { removeExclusive } from './projectStorage';
import { report } from './errors';

export const migrateArchive = internalMutation({
  args: {
    backupId: v.id('projectBackups'),
    owner: v.string(),
    operationId: v.string(),
    originalDigest: v.string(),
    originalStorageId: v.optional(v.id('_storage')),
    originalR2Key: v.optional(v.string()),
    manifestDigest: v.string(),
    manifestSize: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const backup = await ctx.db.get(input.backupId);
      invariant(backup, 'PROJECT_UNAVAILABLE', 'Original archive is unavailable.');
      await activeOwnedProject(ctx, backup.projectId, input.owner);
      if (backup.transport === 'objects') {
        invariant(
          backup.archiveReceipt?.operationId === input.operationId &&
            backup.objectManifest?.digest === input.manifestDigest,
          'WORK_OPERATION_CHANGED',
          'Reconcile this original migration.',
        );
        return null;
      }
      invariant(
        backup.storageId === input.originalStorageId &&
          (!input.originalR2Key || (backup.r2Key === input.originalR2Key && backup.r2Committed)) &&
          (input.originalStorageId || input.originalR2Key) &&
          backup.digest === input.originalDigest &&
          backup.preview.format === 'native' &&
          backup.status === 'stored',
        'PROJECT_CHANGED',
        'Original archive changed during migration.',
      );
      const object = await ctx.db
        .query('projectObjects')
        .withIndex('by_project_and_digest', q =>
          q.eq('projectId', backup.projectId).eq('digest', input.manifestDigest),
        )
        .unique();
      invariant(
        object && isStored(object) && !object.removed && object.size === input.manifestSize,
        'INVALID_WORK_BACKUP',
        'The complete migrated manifest is unavailable.',
      );
      await ctx.db.patch(backup._id, {
        transport: 'objects',
        storageId: object.storageId,
        location: undefined,
        r2Key: undefined,
        r2Committed: undefined,
        r2ConvexPurged: undefined,
        objectManifest: { digest: input.manifestDigest, size: input.manifestSize },
        archiveReceipt: {
          digest: backup.digest,
          size: backup.size,
          ...(input.originalStorageId ? { storageId: input.originalStorageId } : {}),
          ...(backup.location ? { location: backup.location } : {}),
          ...(backup.r2Key ? { r2Key: backup.r2Key, r2Committed: backup.r2Committed } : {}),
          operationId: input.operationId,
          at: Date.now(),
        },
      });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});

export const retireArchive = internalMutation({
  args: { backupId: v.id('projectBackups'), owner: v.string(), operationId: v.string() },
  returns: v.object({
    backupId: v.id('projectBackups'),
    manifestDigest: v.string(),
    originalArchiveDigest: v.string(),
    retired: v.boolean(),
  }),
  handler: async (ctx, input) => {
    try {
      const backup = await ctx.db.get(input.backupId);
      invariant(backup, 'PROJECT_UNAVAILABLE', 'Original migration is unavailable.');
      await activeOwnedProject(ctx, backup.projectId, input.owner);
      invariant(
        backup.transport === 'objects' &&
          backup.objectManifest &&
          backup.archiveReceipt?.operationId === input.operationId,
        'WORK_OPERATION_CHANGED',
        'Reconcile this original migration.',
      );
      const retired = backup.archiveReceipt.storageId
        ? await removeExclusive(ctx, backup.archiveReceipt.storageId)
        : true;
      return {
        backupId: backup._id,
        manifestDigest: backup.objectManifest.digest,
        originalArchiveDigest: backup.archiveReceipt.digest,
        retired,
      };
    } catch (error) {
      return report(error);
    }
  },
});

export const retireArchiveR2 = internalMutation({
  args: { backupId: v.id('projectBackups'), owner: v.string(), operationId: v.string(), key: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const backup = await ctx.db.get(input.backupId);
    invariant(backup, 'PROJECT_UNAVAILABLE', 'Original archive migration is unavailable.');
    await activeOwnedProject(ctx, backup.projectId, input.owner);
    invariant(
      backup.archiveReceipt?.operationId === input.operationId && backup.archiveReceipt.r2Key === input.key,
      'WORK_OPERATION_CHANGED',
      'Retire only the original archive representation.',
    );
    const artifact = await ctx.db
      .query('artifactBlobs')
      .withIndex('by_namespace_and_digest', q =>
        q
          .eq('namespace', `v1/p/${backup.projectId}/archives/${backup._id}`)
          .eq('digest', backup.archiveReceipt!.digest),
      )
      .unique();
    if (artifact?.r2Key === input.key) await ctx.db.patch(artifact._id, { removed: true });
    await ctx.db.patch(backup._id, { archiveReceipt: { ...backup.archiveReceipt, r2Committed: false } });
    return null;
  },
});
