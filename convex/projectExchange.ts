// SPDX-License-Identifier: Apache-2.0
import { requireSourceAuthority } from '../src/hosted-source-authority';
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { activeOwnedProject } from './projectAuthority';
import { isStored } from './projectObjectFields';
import { projectBackupPreview } from './schema';
import { invariant } from '../src/errors';
import { removeExclusive } from './projectStorage';
import { report } from './errors';
import { emitChange } from './coordinationWrite';
// A committed publication receipt already binds the exact validated immutable
// root. Reconcile it before repeating storage reads, with current owner authority.
export const published = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    operationId: v.string(),
    request: v.string(),
    authorityEpoch: v.optional(v.number()),
  },
  returns: v.union(v.id('projectBackups'), v.null()),
  handler: async (ctx, input) => {
    try {
      const project = await activeOwnedProject(ctx, input.projectId, input.owner);
      requireSourceAuthority(project, { mode: 'native-owner', epoch: input.authorityEpoch ?? 0 });
      const original = await ctx.db
        .query('projectBackups')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .unique();
      if (!original) return null;
      invariant(
        original.request === input.request,
        'WORK_OPERATION_CHANGED',
        'Reconcile this exchange using its original manifest and previous checkpoint.',
      );
      return original._id;
    } catch (error) {
      return report(error);
    }
  },
});

export const publish = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    operationId: v.string(),
    request: v.string(),
    authorityEpoch: v.optional(v.number()),
    previous: v.union(v.id('projectBackups'), v.null()),
    digest: v.string(),
    size: v.number(),
    preview: projectBackupPreview,
    historyBackfilling: v.optional(v.boolean()),
    retainCandidate: v.optional(v.boolean()),
    validatedClosure: v.optional(v.literal(1)),
    displayProtocol: v.optional(v.literal(3)),
    validatedWorkRecords: v.optional(v.literal(1)),
    metadataPublication: v.optional(v.id('projectPublications')),
    ownerDerived: v.optional(v.object({ sha256: v.string(), size: v.number() })),
  },
  returns: v.id('projectBackups'),
  handler: async (ctx, input) => {
    try {
      const project = await activeOwnedProject(ctx, input.projectId, input.owner);
      requireSourceAuthority(project, { mode: 'native-owner', epoch: input.authorityEpoch ?? 0 });
      const original = await ctx.db
        .query('projectBackups')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .unique();
      if (original) {
        invariant(
          original.request === input.request,
          'WORK_OPERATION_CHANGED',
          'Reconcile this exchange using its original manifest and previous checkpoint.',
        );
        return original._id;
      }
      if (input.metadataPublication) {
        const metadata = await ctx.db.get(input.metadataPublication);
        invariant(
          project.r2Writes,
          'PUBLICATION_CAPABILITY_CHANGED',
          'Use the existing publication path after R2 opt-out.',
        );
        invariant(
          metadata &&
            metadata.validated &&
            metadata.projectId === input.projectId &&
            metadata.owner === input.owner &&
            metadata.operationId === input.operationId &&
            metadata.request === input.request &&
            metadata.digest === input.digest &&
            metadata.size === input.size,
          'WORK_OPERATION_CHANGED',
          'Publish only the validated original metadata session.',
        );
      }
      // Compare-and-set: a stale `previous` must fail loudly instead of forking
      // the checkpoint chain. Uploaded objects are immutable, so a retry after
      // pulling is cheap. The caller's original receipt is reconciled above.
      invariant(
        project.currentBackup === input.previous || input.retainCandidate,
        'PROJECT_CHANGED',
        'Another push changed this project after your previous checkpoint. Pull the latest checkpoint, reconcile, and push again; nothing was published.',
      );
      if (input.previous)
        invariant(
          (await ctx.db.get(input.previous))?.projectId === input.projectId,
          'PROJECT_CHANGED',
          'Select a previous checkpoint in this project.',
        );
      const content = await ctx.db
        .query('projectObjects')
        .withIndex('by_project_and_digest', q =>
          q.eq('projectId', input.projectId).eq('digest', input.digest),
        )
        .unique();
      invariant(
        content && isStored(content) && !content.removed && content.size === input.size,
        'INVALID_WORK_BACKUP',
        'Original exchange manifest is unavailable.',
      );
      const id = await ctx.db.insert('projectBackups', {
        projectId: input.projectId,
        operationId: input.operationId,
        request: input.request,
        nonce: content.nonce,
        previous: input.previous,
        digest: input.digest,
        size: input.size,
        preview: input.preview,
        status: 'stored',
        ...(input.historyBackfilling ? { historyBackfilling: true } : {}),
        ...(input.validatedClosure ? { validatedClosure: input.validatedClosure } : {}),
        ...(input.validatedWorkRecords ? { validatedWorkRecords: input.validatedWorkRecords } : {}),
        ...(content.storageId ? { storageId: content.storageId } : {}),
        transport: 'objects',
        ...(input.metadataPublication ? { metadataPublication: input.metadataPublication } : {}),
        ...(input.ownerDerived ? { ownerDerived: input.ownerDerived } : {}),
        ...(input.displayProtocol ? { displayProtocol: input.displayProtocol } : {}),
      });
      await ctx.db.patch(project._id, {
        currentBackup: project.currentBackup === input.previous ? id : project.currentBackup,
        revision: project.revision + 1,
      });
      await emitChange(ctx, {
        projectId: input.projectId,
        actor: input.owner,
        operationId: `exchange:${input.operationId}`,
        source: 'exchange',
        head: input.preview.head,
      });
      return id;
    } catch (error) {
      return report(error);
    }
  },
});

export const migrateArchive = internalMutation({
  args: {
    backupId: v.id('projectBackups'),
    owner: v.string(),
    operationId: v.string(),
    originalDigest: v.string(),
    originalStorageId: v.id('_storage'),
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
        objectManifest: { digest: input.manifestDigest, size: input.manifestSize },
        archiveReceipt: {
          digest: backup.digest,
          size: backup.size,
          storageId: input.originalStorageId,
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
      const retired = await removeExclusive(ctx, backup.archiveReceipt.storageId);
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

export const completeHistory = internalMutation({
  args: { backupId: v.id('projectBackups'), owner: v.string() },
  returns: v.null(),
  handler: async (ctx, { backupId, owner }) => {
    try {
      const backup = await ctx.db.get(backupId);
      invariant(backup, 'PROJECT_UNAVAILABLE', 'Original checkpoint is unavailable.');
      await activeOwnedProject(ctx, backup.projectId, owner);
      if (backup.historyBackfilling) await ctx.db.patch(backupId, { historyBackfilling: false });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
