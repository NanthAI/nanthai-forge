// SPDX-License-Identifier: Apache-2.0
import { scheduleR2Purge } from './projectPurgeScheduling';
import { ensureProjectSlug, slugTaken } from './urlIdentity';
import { blobStore } from './blobStore';
import { invariant as check } from '../src/errors';
import { purgeExchangeObjects } from './projectObjectLifecycle';
import { reconcileRemovedObjectUploads } from './projectObjectCleanup';
import { v } from 'convex/values';
import { mutation, internalMutation } from './cliServer';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { matchesUpload, scanComplete, removeDuplicate, removeExclusive } from './projectStorage';
import { invariant } from '../src/errors';
import { report } from './errors';

const args = { projectId: v.id('hostedProjects'), operationId: v.string(), expectedRevision: v.number() };
async function schedule(ctx: MutationCtx, project: Doc<'hostedProjects'>) {
  if (project.task) {
    const task = await ctx.db.system.get(project.task);
    if (task && ['pending', 'inProgress'].includes(task.state.kind)) return;
  }
  if (project.r2Purge && !project.r2PrefixPurged) return scheduleR2Purge(ctx, project);
  const task = await ctx.scheduler.runAfter(0, internal.projectLifecycle.purge, { projectId: project._id });
  await ctx.db.patch(project._id, { task });
}
export async function transition(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; operationId: string; expectedRevision: number },
  action: 'trash' | 'restore' | 'delete',
) {
  const user = await ctx.auth.getUserIdentity(),
    project = await ctx.db.get(input.projectId);
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to manage your Forge project.');
  // Delete reconciliation has no existence oracle.
  if (action === 'delete' && (!project || project.owner !== user.subject)) return null;
  invariant(
    project?.owner === user.subject,
    'PROJECT_UNAVAILABLE',
    'This Forge project is unavailable with the current account.',
  );
  invariant(
    input.operationId.trim() && Number.isSafeInteger(input.expectedRevision),
    'BAD_ARGUMENT',
    'Retain the original project operation and revision.',
  );
  if (project.lifecycle?.operationId === input.operationId) {
    invariant(
      project.lifecycle.action === action && project.lifecycle.expectedRevision === input.expectedRevision,
      'WORK_OPERATION_CHANGED',
      'Reconcile this original project operation.',
    );
    if (project.removal === 'deleting') await schedule(ctx, project);
    return null;
  }
  invariant(
    project.revision === input.expectedRevision,
    'WORK_STALE',
    'Project changed. Its original source and your operation remain available.',
  );
  if (action === 'delete' && ['deleting', 'deleted'].includes(project.removal ?? '')) {
    if (project.removal === 'deleting') await schedule(ctx, project);
    return null;
  }
  invariant(
    !['deleting', 'deleted'].includes(project.removal ?? ''),
    'PROJECT_UNAVAILABLE',
    'Permanent project removal is already underway.',
  );
  const removal =
    action === 'restore' ? undefined : action === 'trash' ? ('trash' as const) : ('deleting' as const);
  await ctx.db.patch(project._id, {
    removal,
    removedAt: removal ? (project.removedAt ?? Date.now()) : undefined,
    revision: project.revision + 1,
    lifecycle: { operationId: input.operationId, action, expectedRevision: input.expectedRevision },
  });
  if (action === 'delete') await schedule(ctx, (await ctx.db.get(project._id))!);
  return null;
}
export const rename = mutation({
  args: { ...args, name: v.string(), slug: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity(),
        project = await ctx.db.get(input.projectId);
      invariant(
        user && project?.owner === user.subject && !project.removal,
        'PROJECT_UNAVAILABLE',
        'This Forge project is unavailable with the current account.',
      );
      const name = input.name.trim();
      invariant(
        name && input.operationId.trim() && Number.isSafeInteger(input.expectedRevision),
        'BAD_ARGUMENT',
        'Enter a project name and retain the original operation.',
      );
      if (project.nameChange?.operationId === input.operationId) {
        invariant(
          project.nameChange.name === name &&
            project.nameChange.slug === input.slug &&
            project.nameChange.expectedRevision === input.expectedRevision,
          'WORK_OPERATION_CHANGED',
          'Reconcile the original rename request.',
        );
        return null;
      }
      invariant(
        project.revision === input.expectedRevision,
        'WORK_STALE',
        'Project changed. Refresh its current name before making another change.',
      );
      const previousSlug = await ensureProjectSlug(ctx, project);
      const slug = input.slug ?? previousSlug;
      check(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug),
        'BAD_ARGUMENT',
        'Use lowercase letters, numbers and hyphens for the project slug.',
      );
      check(
        !(await slugTaken(ctx, project.owner, slug, project._id)),
        'BAD_ARGUMENT',
        'This project slug is already taken.',
      );
      if (
        slug !== previousSlug &&
        !(await ctx.db
          .query('projectSlugs')
          .withIndex('by_owner_and_slug', q => q.eq('owner', project.owner).eq('slug', slug))
          .unique())
      )
        await ctx.db.insert('projectSlugs', { owner: project.owner, slug, projectId: project._id });
      await ctx.db.patch(project._id, {
        name,
        slug,
        revision: project.revision + 1,
        nameChange: {
          operationId: input.operationId,
          expectedRevision: input.expectedRevision,
          name,
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
        },
      });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export const trash = mutation({
  args,
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      return await transition(ctx, input, 'trash');
    } catch (error) {
      return report(error);
    }
  },
});
export const restore = mutation({
  args,
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      return await transition(ctx, input, 'restore');
    } catch (error) {
      return report(error);
    }
  },
});
export const permanentlyDelete = mutation({
  args,
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      return await transition(ctx, input, 'delete');
    } catch (error) {
      return report(error);
    }
  },
});

export async function retainUploadCleanup(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  row: Doc<'projectBackups'> | Doc<'projectProposals'>,
  kind: 'backup' | 'proposal',
) {
  const old = await ctx.db
    .query('projectUploadCleanup')
    .withIndex('by_upload', q => q.eq('uploadId', row._id))
    .unique();
  if (old) return old;
  const id = await ctx.db.insert('projectUploadCleanup', {
    projectId: project._id,
    owner: project.owner,
    actor: 'actor' in row ? row.actor : project.owner,
    uploadId: row._id,
    operationId: row.operationId,
    kind,
    nonce: row.nonce,
    digest: row.digest,
    size: row.size,
    pending: true,
  });
  return (await ctx.db.get(id))!;
}
// One metadata page per transaction. Keep original upload bindings for known late outcomes.
async function sweep(ctx: MutationCtx, binding: Doc<'projectUploadCleanup'>) {
  const page = await ctx.db.system
    .query('_storage')
    .order('desc')
    .paginate({ cursor: binding.cursor ?? null, numItems: 100 });
  for (const file of page.page)
    if (matchesUpload(file, binding, binding.kind)) await removeExclusive(ctx, file._id);
  const done = scanComplete(page, (await ctx.db.get(binding.projectId))?._creationTime);
  await ctx.db.patch(binding._id, {
    cursor: done ? undefined : page.continueCursor,
    pending: !done,
    ...(done ? { task: undefined } : {}),
  });
  return done;
}
export async function scheduleUploadSweep(ctx: MutationCtx, binding: Doc<'projectUploadCleanup'>) {
  if (binding.task) {
    const task = await ctx.db.system.get(binding.task);
    if (task && ['pending', 'inProgress'].includes(task.state.kind)) return;
  }
  const task = await ctx.scheduler.runAfter(0, internal.projectLifecycle.sweepUpload, { id: binding._id });
  await ctx.db.patch(binding._id, { task });
}
export async function retryRemovedUpload(ctx: MutationCtx, uploadId: string, owner: string) {
  const binding = await ctx.db
    .query('projectUploadCleanup')
    .withIndex('by_upload', q => q.eq('uploadId', uploadId))
    .unique();
  if (binding?.owner === owner) await scheduleUploadSweep(ctx, binding);
}
export const purge = internalMutation({
  args: { projectId: v.id('hostedProjects') },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const project = await ctx.db.get(projectId);
    if (project?.removal !== 'deleting' || (project.r2Purge && !project.r2PrefixPurged)) return null;
    const imports = await ctx.db
      .query('projectGithubImports')
      .withIndex('by_project', q => q.eq('projectId', projectId))
      .take(50);
    for (const job of imports) {
      if (job.task) {
        const task = await ctx.db.system.get(job.task);
        if (task && task.state.kind === 'pending') await ctx.scheduler.cancel(job.task);
      }
      await blobStore(ctx).delete(job.cursor);
      await ctx.db.delete(job._id);
    }
    if (imports.length === 50) {
      await ctx.db.patch(projectId, { task: undefined });
      await schedule(ctx, (await ctx.db.get(projectId))!);
      return null;
    }

    for (const table of [
      'projectPublicationPages',
      'projectPublicationAttempts',
      'projectReturnPages',
      'projectPublications',
      'projectCheckRequests',
      'projectCheckRunners',
      'projectWorkRecords',
      'projectWorkGenerations',
    ] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .take(50);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length === 50) {
        await ctx.db.patch(projectId, { task: undefined });
        await schedule(ctx, (await ctx.db.get(projectId))!);
        return null;
      }
    }
    // Personal operations may carry an incidental projectId; scope remains authoritative.
    // Existing compound indexes also bound briefing and policy scans by project.
    for (const readBatch of [
      () =>
        ctx.db
          .query('projectBriefingSources')
          .withIndex('by_projectId_and_backupId_and_head_and_part', q => q.eq('projectId', projectId))
          .take(50),
      () =>
        ctx.db
          .query('agentGuidanceOperations')
          .withIndex('by_project_and_scope', q => q.eq('projectId', projectId).eq('scope', 'project'))
          .take(50),
      () =>
        ctx.db
          .query('agentGuidanceMaintainerOperations')
          .withIndex('by_project', q => q.eq('projectId', projectId))
          .take(50),
      () =>
        ctx.db
          .query('projectPolicyChanges')
          .withIndex('by_project_and_operation', q => q.eq('projectId', projectId))
          .take(50),
    ]) {
      const rows = await readBatch();
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length === 50) {
        await ctx.db.patch(projectId, { task: undefined });
        await schedule(ctx, (await ctx.db.get(projectId))!);
        return null;
      }
    }
    for (const table of [
      'projectActorNames',
      'projectCoordinationSessions',
      'projectCoordinationEvents',
      'projectCoordinationReceipts',
      'projectCoordinationClaims',
    ] as const) {
      const rows =
        table === 'projectCoordinationSessions'
          ? await ctx.db
              .query(table)
              .withIndex('by_project_and_session', q => q.eq('projectId', projectId))
              .take(50)
          : table === 'projectCoordinationClaims'
            ? await ctx.db
                .query(table)
                .withIndex('by_project_and_claim', q => q.eq('projectId', projectId))
                .take(50)
            : await ctx.db
                .query(table)
                .withIndex('by_project', q => q.eq('projectId', projectId))
                .take(50);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length === 50) {
        await ctx.db.patch(projectId, { task: undefined });
        await schedule(ctx, (await ctx.db.get(projectId))!);
        return null;
      }
    }
    for (const table of [
      'projectReaders',
      'projectReaderOperations',
      'projectContributors',
      'projectWorkHeads',
      'projectWorkEvents',
      'projectRecoveryConnections',
    ] as const) {
      const rows =
        table === 'projectReaders'
          ? await ctx.db
              .query('projectReaders')
              .withIndex('by_project_and_reader', q => q.eq('projectId', projectId))
              .take(50)
          : table === 'projectReaderOperations'
            ? await ctx.db
                .query('projectReaderOperations')
                .withIndex('by_project_and_operation', q => q.eq('projectId', projectId))
                .take(50)
            : table === 'projectContributors'
              ? await ctx.db
                  .query('projectContributors')
                  .withIndex('by_project_and_contributor', q => q.eq('projectId', projectId))
                  .take(50)
              : table === 'projectRecoveryConnections'
                ? await ctx.db
                    .query('projectRecoveryConnections')
                    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId))
                    .take(50)
                : table === 'projectWorkHeads'
                  ? await ctx.db
                      .query('projectWorkHeads')
                      .withIndex('by_project', q => q.eq('projectId', projectId))
                      .take(50)
                  : await ctx.db
                      .query('projectWorkEvents')
                      .withIndex('by_project_and_revision', q => q.eq('projectId', projectId))
                      .take(50);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length === 50) {
        await ctx.db.patch(projectId, { task: undefined });
        await schedule(ctx, (await ctx.db.get(projectId))!);
        return null;
      }
    }
    for (const table of ['projectProposals', 'projectBackups'] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .take(1);
      if (!rows.length) continue;
      const row = rows[0]!,
        binding = await retainUploadCleanup(
          ctx,
          project,
          row,
          table === 'projectBackups' ? 'backup' : 'proposal',
        );
      // Remove this row's exclusive recorded object first, then sweep any nonce-bound duplicates.
      if (row.storageId) await removeExclusive(ctx, row.storageId, row._id);
      await ctx.db.delete(row._id);
      if (!(await sweep(ctx, binding))) {
        // Remaining pages are handled below even though the source record has been erased.
        await ctx.db.patch(projectId, { task: undefined });
        await schedule(ctx, (await ctx.db.get(projectId))!);
        return null;
      }
      await ctx.db.patch(projectId, { task: undefined });
      await schedule(ctx, (await ctx.db.get(projectId))!);
      return null;
    }
    const pending = await ctx.db
      .query('projectUploadCleanup')
      .withIndex('by_project_and_pending', q => q.eq('projectId', projectId).eq('pending', true))
      .take(1);
    if (pending.length) {
      await sweep(ctx, pending[0]!);
      await ctx.db.patch(projectId, { task: undefined });
      await schedule(ctx, (await ctx.db.get(projectId))!);
      return null;
    }
    if (!(await purgeExchangeObjects(ctx, project))) {
      await ctx.db.patch(projectId, { task: undefined });
      await schedule(ctx, (await ctx.db.get(projectId))!);
      return null;
    }
    if (
      (project.r2StorageUsed ||
        project.r2BackfillRevision ||
        project.r2Writes ||
        process.env.FORGE_R2_MAINTENANCE === '1') &&
      !project.r2PrefixPurged
    ) {
      await scheduleR2Purge(ctx, project);
      return null;
    }
    // The owner/key tombstone prevents an old initial-upload retry from silently recreating this project.
    await ctx.db.patch(projectId, {
      name: '',
      nameChange: undefined,
      hostingRequest: undefined,
      agentGuidance: undefined,
      autonomyPolicy: undefined,
      currentBackup: null,
      work: undefined,
      removal: 'deleted',
      task: undefined,
      purgeBlocked: undefined,
    });
    return null;
  },
});
export const cleanupUpload = internalMutation({
  args: { uploadId: v.string(), actor: v.string(), storageId: v.id('_storage') },
  returns: v.null(),
  handler: async (ctx, { uploadId, actor, storageId }) => {
    const binding = await ctx.db
      .query('projectUploadCleanup')
      .withIndex('by_upload', q => q.eq('uploadId', uploadId))
      .unique();
    invariant(
      binding && (binding.owner === actor || binding.actor === actor),
      'PROJECT_UNAVAILABLE',
      'This original upload is unavailable.',
    );
    await removeDuplicate(ctx, binding, binding.kind, storageId);
    return null;
  },
});
export const sweepUpload = internalMutation({
  args: { id: v.id('projectUploadCleanup') },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const binding = await ctx.db.get(id);
    if (!binding) return null;
    if (!(await sweep(ctx, binding))) {
      await ctx.db.patch(id, { task: undefined });
      await scheduleUploadSweep(ctx, (await ctx.db.get(id))!);
    }
    return null;
  },
});
export const reconcile = mutation({
  args: { projectId: v.id('hostedProjects'), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ cursor: v.union(v.string(), v.null()), isDone: v.boolean() }),
  handler: async (ctx, { projectId, cursor }) => {
    try {
      const user = await ctx.auth.getUserIdentity(),
        project = await ctx.db.get(projectId);
      invariant(
        user && project?.owner === user.subject && project.removal === 'deleted',
        'PROJECT_UNAVAILABLE',
        'Select your removed project’s cleanup metadata.',
      );
      const objectPrefix = 'forge-object-after:';
      if (cursor?.startsWith(objectPrefix))
        return reconcileRemovedObjectUploads(ctx, projectId, cursor.slice(objectPrefix.length) || null);
      // Convex allows one paginated query per transaction; reserve it for the storage sweep.
      // An old receipt-page cursor can resume by a harmless full replay, after validating it.
      const prefix = 'forge-upload-after:';
      if (cursor !== null && !cursor.startsWith(prefix)) {
        await ctx.db
          .query('projectUploadCleanup')
          .withIndex('by_project', q => q.eq('projectId', projectId))
          .paginate({ cursor, numItems: 1 });
        return { cursor: null, isDone: false };
      }
      const after = cursor?.slice(prefix.length) ?? '';
      const rows = await ctx.db
        .query('projectUploadCleanup')
        .withIndex('by_project_and_upload', q => q.eq('projectId', projectId).gt('uploadId', after))
        .take(2);
      const binding = rows[0];
      if (!binding) return reconcileRemovedObjectUploads(ctx, projectId, null);
      if (!(await sweep(ctx, binding))) return { cursor, isDone: false };
      // The final archive/proposal receipt is followed by the object sweep. Late
      // signed uploads can finish after the original permanent-removal sweep.
      return { cursor: prefix + binding.uploadId, isDone: false };
    } catch (error) {
      return report(error);
    }
  },
});
