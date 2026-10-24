// SPDX-License-Identifier: Apache-2.0
import { accountFor } from './urlIdentity';
import { blobStore } from './blobStore';
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query, internalMutation, internalQuery } from './cliServer';
import type { Doc } from './_generated/dataModel';
import { projectBackupPreview, projectDocument, projectBackupDocument, projectRemoval } from './schema';
import { invariant } from '../src/errors';
import { report } from './errors';
import { accessibleProject, activeOwnedProject } from './projectAuthority';
export { ownedProject } from './projectAuthority';

const item = (backup: Doc<'projectBackups'>, project: Doc<'hostedProjects'>) => ({
  id: backup._id,
  operationId: backup.operationId,
  projectId: project._id,
  name: project.name,
  status: backup.status,
  digest: backup.digest,
  size: backup.size,
  preview: backup.preview,
  previous: backup.previous,
  ...(backup.transport ? { transport: backup.transport } : {}),
  ...(backup.objectManifest ? { objectManifest: backup.objectManifest } : {}),
  ...(backup.archiveReceipt
    ? { originalArchive: { digest: backup.archiveReceipt.digest, size: backup.archiveReceipt.size } }
    : {}),
  current: project.currentBackup === backup._id,
  at: backup._creationTime,
});
import { storageDigest, scanComplete, duplicatePage, removeDuplicate } from './projectStorage';
export { storageDigest } from './projectStorage';
export const backupItem = v.object({
  objectManifest: v.optional(v.object({ digest: v.string(), size: v.number() })),
  originalArchive: v.optional(v.object({ digest: v.string(), size: v.number() })),
  transport: v.optional(v.literal('objects')),
  id: v.id('projectBackups'),
  operationId: v.string(),
  projectId: v.id('hostedProjects'),
  name: v.string(),
  status: v.union(v.literal('uploading'), v.literal('stored')),
  digest: v.string(),
  size: v.number(),
  preview: projectBackupPreview,
  previous: v.union(v.id('projectBackups'), v.null()),
  current: v.boolean(),
  at: v.number(),
});

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({
      id: v.id('hostedProjects'),
      key: v.string(),
      handle: v.optional(v.string()),
      slug: v.optional(v.string()),
      name: v.string(),
      currentBackup: v.union(v.id('projectBackups'), v.null()),
      revision: v.number(),
      removal: v.optional(projectRemoval),
    }),
  ),
  handler: async (ctx, { paginationOpts }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return { page: [], isDone: true, continueCursor: '' };
    const result = await ctx.db
      .query('hostedProjects')
      .withIndex('by_owner', q => q.eq('owner', user.subject))
      .order('desc')
      .paginate(paginationOpts);
    const account = await accountFor(ctx, user.subject);
    return {
      ...result,
      page: result.page.map(project => ({
        id: project._id,
        key: project.key,
        ...(account ? { handle: account.handle } : {}),
        ...(project.slug ? { slug: project.slug } : {}),
        name: project.name,
        currentBackup: project.currentBackup,
        revision: project.revision,
        ...(project.removal ? { removal: project.removal } : {}),
      })),
    };
  },
});
export const history = query({
  args: { projectId: v.id('hostedProjects'), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(backupItem),
  handler: async (ctx, { projectId, paginationOpts }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
      const project = await accessibleProject(ctx, projectId, user.subject);
      const result = await ctx.db
        .query('projectBackups')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .order('desc')
        .paginate(paginationOpts);
      return { ...result, page: result.page.map(backup => item(backup, project)) };
    } catch (error) {
      return report(error);
    }
  },
});
export const get = internalQuery({
  args: { id: v.id('projectBackups'), owner: v.string() },
  returns: v.object({ backup: projectBackupDocument, project: projectDocument, item: backupItem }),
  handler: async (ctx, { id, owner }) => {
    try {
      const backup = await ctx.db.get(id);
      invariant(backup, 'PROJECT_UNAVAILABLE', 'This Forge backup is unavailable with the current account.');
      const project = await accessibleProject(ctx, backup.projectId, owner);
      return { backup, project, item: item(backup, project) };
    } catch (error) {
      return report(error);
    }
  },
});

export const register = internalMutation({
  args: {
    owner: v.string(),
    key: v.string(),
    name: v.string(),
    operationId: v.string(),
    request: v.string(),
    nonce: v.string(),
    previous: v.union(v.id('projectBackups'), v.null()),
    digest: v.string(),
    size: v.number(),
    preview: projectBackupPreview,
  },
  returns: v.id('projectBackups'),
  handler: async (ctx, input) => {
    try {
      const project = await ctx.db
        .query('hostedProjects')
        .withIndex('by_owner_and_key', q => q.eq('owner', input.owner).eq('key', input.key))
        .unique();
      invariant(
        project,
        'ARCHIVE_TRANSPORT_RETIRED',
        'New backups use object exchange. Existing archive uploads remain resumable.',
      );
      await activeOwnedProject(ctx, project._id, input.owner);
      const original = await ctx.db
        .query('projectBackups')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', project._id).eq('operationId', input.operationId),
        )
        .unique();
      invariant(
        original,
        'ARCHIVE_TRANSPORT_RETIRED',
        'New backups use object exchange. Existing archive uploads remain resumable.',
      );
      invariant(
        original.request === input.request,
        'WORK_OPERATION_CHANGED',
        'Reconcile the original backup pins.',
      );
      return original._id;
    } catch (error) {
      return report(error);
    }
  },
});
export const uploadUrl = internalMutation({
  args: { id: v.id('projectBackups'), owner: v.string() },
  returns: v.string(),
  handler: async (ctx, { id, owner }) => {
    try {
      const backup = await ctx.db.get(id);
      invariant(backup, 'PROJECT_UNAVAILABLE', 'This Forge backup is unavailable.');
      await activeOwnedProject(ctx, backup.projectId, owner);
      invariant(backup.status === 'uploading', 'PROJECT_CHANGED', 'This original backup is already stored.');
      return blobStore(ctx).generateUploadUrl();
    } catch (error) {
      return report(error);
    }
  },
});
export const findUpload = internalQuery({
  args: { id: v.id('projectBackups'), owner: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ id: v.union(v.id('_storage'), v.null()), isDone: v.boolean(), cursor: v.string() }),
  handler: async (ctx, { id, owner, cursor }) => {
    try {
      const backup = await ctx.db.get(id);
      invariant(backup, 'PROJECT_UNAVAILABLE', 'This Forge backup is unavailable.');
      await activeOwnedProject(ctx, backup.projectId, owner);
      // ponytail: scan native file metadata on unknown uploads; use a bound streaming upload endpoint if measured storage volume warrants it.
      const page = await ctx.db.system.query('_storage').order('desc').paginate({ numItems: 100, cursor });
      const file = page.page.find(
        file =>
          file.contentType === `application/x-forge-backup-${backup.nonce}` &&
          file.size === backup.size &&
          storageDigest(file.sha256) === backup.digest,
      );
      return {
        id: file?._id ?? null,
        isDone: scanComplete(page, backup._creationTime),
        cursor: page.continueCursor,
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const complete = internalMutation({
  args: { id: v.id('projectBackups'), owner: v.string(), storageId: v.id('_storage') },
  returns: backupItem,
  handler: async (ctx, { id, owner, storageId }) => {
    try {
      const backup = await ctx.db.get(id);
      invariant(backup, 'PROJECT_UNAVAILABLE', 'This Forge backup is unavailable.');
      const project = await activeOwnedProject(ctx, backup.projectId, owner);
      if (backup.status === 'stored') {
        if (storageId !== backup.storageId) await removeDuplicate(ctx, backup, 'backup', storageId);
        return item(backup, project);
      }
      const file = await ctx.db.system.get(storageId);
      invariant(
        file &&
          file.contentType === `application/x-forge-backup-${backup.nonce}` &&
          file.size === backup.size &&
          storageDigest(file.sha256) === backup.digest,
        'INVALID_WORK_BACKUP',
        'Uploaded bytes are not this owner-bound archive. Original project and backups remain available.',
      );
      await ctx.db.patch(id, { status: 'stored', storageId });
      // Store a concurrent candidate without silently replacing a newer remote backup pointer.
      if (project.currentBackup === backup.previous)
        await ctx.db.patch(project._id, { currentBackup: id, revision: project.revision + 1 });
      return item((await ctx.db.get(id))!, (await ctx.db.get(project._id))!);
    } catch (error) {
      return report(error);
    }
  },
});

export const reconcileDuplicates = internalMutation({
  args: { id: v.id('projectBackups'), owner: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ cursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, { id, owner, cursor }) => {
    try {
      const row = await ctx.db.get(id);
      invariant(row && row.status === 'stored', 'PROJECT_UNAVAILABLE', 'Select this original stored upload.');

      await activeOwnedProject(ctx, row.projectId, owner);
      return await duplicatePage(ctx, row, 'backup', cursor);
    } catch (error) {
      return report(error);
    }
  },
});
