// SPDX-License-Identifier: Apache-2.0
import { scheduleR2Purge } from './projectPurgeScheduling';
import { ensureProjectSlug, slugTaken } from './urlIdentity';
import { blobStore } from './blobStore';
import { invariant as check } from '../src/errors';
import { purgeExchangeObjects } from './projectObjectLifecycle';
import { v } from 'convex/values';
import { mutation } from './cliServer';
import { internalMutation, type MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { matchesUpload, scanComplete, removeDuplicate, removeExclusive } from './projectStorage';
import { invariant } from '../src/errors';
import { report } from './errors';
import { projectExecution } from './projectExecution';
import { startRetention, stopRetention, purgeSettleMs } from './projectRetention';
import { purgeProjectRowsPage } from './projectPurgeRows';

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
  input: { projectId: Id<'hostedProjects'>; operationId: string; expectedRevision: number; confirm?: string },
  action: 'trash' | 'restore' | 'delete',
  /** Account deletion carries its own reviewed plan as the confirmation. */
  options: { confirmed?: boolean } = {},
) {
  const user = await ctx.auth.getUserIdentity(),
    project = await ctx.db.get(input.projectId);
  projectExecution(
    ctx,
    input.projectId,
    user && project?.owner === user.subject ? project.name : undefined,
    user && project?.owner === user.subject ? project.key : undefined,
  );
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
  // SM-D guards (machine M1): restoring an active project and trashing a trashed one already
  // hold the state they ask for. They return before the revision check and write nothing, so a stale
  // second tab neither bumps the revision (which would fail every other holder with WORK_STALE) nor
  // re-measures retention and moves its expiry.
  if ((action === 'restore' && !project.removal) || (action === 'trash' && project.removal === 'trash'))
    return null;
  invariant(
    project.revision === input.expectedRevision,
    'WORK_STALE',
    'Project changed. Its original source and your operation remain available.',
  );
  if (action === 'delete' && ['deleting', 'deleted'].includes(project.removal ?? '')) {
    // A pre-receipt `deleting` row gets its owner-confirmed purge grant from this retry.
    if (project.removal === 'deleting' && !project.purge)
      await ctx.db.patch(project._id, {
        purge: {
          operationId: input.operationId,
          reason: 'owner',
          startedAt: Date.now(),
          rows: 0,
          bytes: 0,
          pages: 0,
        },
      });
    if (project.removal === 'deleting') await schedule(ctx, (await ctx.db.get(project._id))!);
    return null;
  }
  invariant(
    !['deleting', 'deleted'].includes(project.removal ?? ''),
    'PROJECT_UNAVAILABLE',
    'Permanent project removal is already underway.',
  );
  if (action === 'delete')
    invariant(
      options.confirmed ||
        (!!input.confirm?.trim() && input.confirm.trim() === (project.slug ?? project.name)),
      'BAD_ARGUMENT',
      'Type the project slug to confirm permanent deletion.',
    );
  if (action === 'restore') {
    invariant(
      !project.retention || Date.now() < project.retention.purgeAt,
      'PROJECT_UNAVAILABLE',
      'The 90-day restore window for this project has ended.',
    );
    invariant(
      !project.retention?.revoking,
      'WORK_STALE',
      'Access revocation for this deletion is still finishing. Retry restore shortly.',
    );
  }
  await stopRetention(ctx, project);
  const removal =
    action === 'restore' ? undefined : action === 'trash' ? ('trash' as const) : ('deleting' as const);
  await ctx.db.patch(project._id, {
    removal,
    removedAt: removal ? (project.removedAt ?? Date.now()) : undefined,
    revision: project.revision + 1,
    lifecycle: { operationId: input.operationId, action, expectedRevision: input.expectedRevision },
    retention: undefined,
    ...(action === 'delete'
      ? {
          purge: {
            operationId: input.operationId,
            reason: 'owner' as const,
            startedAt: Date.now(),
            rows: 0,
            bytes: 0,
            pages: 0,
          },
        }
      : {}),
  });
  if (action === 'trash') await startRetention(ctx, project._id);
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
      projectExecution(
        ctx,
        input.projectId,
        user && project?.owner === user.subject ? project.name : undefined,
        user && project?.owner === user.subject ? project.key : undefined,
      );
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
  args: { ...args, confirm: v.optional(v.string()) },
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
  const r2Only = row.location === 'r2' && !row.storageId;
  if (r2Only) {
    const artifact = await ctx.db
      .query('artifactBlobs')
      .withIndex('by_namespace_and_digest', q =>
        q.eq('namespace', `v1/p/${project._id}/archives/${row._id}`).eq('digest', row.digest),
      )
      .unique();
    if (artifact) await blobStore(ctx).delete(`r2blob:${artifact._id}`);
  }
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
    pending: !r2Only,
    ...(r2Only ? { r2Key: row.r2Key } : {}),
  });
  return (await ctx.db.get(id))!;
}
// One metadata page per transaction. Keep original upload bindings for known late outcomes.
async function sweep(ctx: MutationCtx, binding: Doc<'projectUploadCleanup'>) {
  if (binding.r2Key) return true;
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
  if (binding.r2Key) return;
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
    projectExecution(ctx, projectId, project?.name, project?.key);
    if (project?.removal !== 'deleting' || (project.r2Purge && !project.r2PrefixPurged)) return null;
    // Access is already revoked. Signed uploads issued before deletion can still finish
    // until they expire; purging after that means no bytes or receipts can arrive later.
    const settleAt = (project.removedAt ?? 0) + purgeSettleMs;
    if (Date.now() < settleAt) {
      const task = await ctx.scheduler.runAt(settleAt, internal.projectLifecycle.purge, { projectId });
      await ctx.db.patch(projectId, { task });
      return null;
    }
    const imports = await ctx.db
      .query('projectGithubImports')
      .withIndex('by_project', q => q.eq('projectId', projectId))
      .take(50);
    for (const job of imports) {
      if (job.task) {
        const task = await ctx.db.system.get(job.task);
        if (task && task.state.kind === 'pending') await ctx.scheduler.cancel(job.task);
      }
      if (job.protocol === undefined) await blobStore(ctx).delete(job.cursor);
      await ctx.db.delete(job._id);
    }
    if (imports.length === 50) {
      await ctx.db.patch(projectId, { task: undefined });
      await schedule(ctx, (await ctx.db.get(projectId))!);
      return null;
    }

    // Plain project rows (grants, Work, journals, settings) go in the inventory-guarded
    // row stage below, which also cancels their scheduled functions and frees their files.
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
    // Every remaining project-owned row (inventory-guarded), one bounded page per call.
    if (!(await purgeProjectRowsPage(ctx, project))) {
      await ctx.db.patch(projectId, { task: undefined });
      await schedule(ctx, (await ctx.db.get(projectId))!);
      return null;
    }
    // Every project writes R2, so every deletion purges its R2 prefix once.
    if (!project.r2PrefixPurged) {
      await scheduleR2Purge(ctx, project);
      return null;
    }
    // The owner/key tombstone prevents an old initial-upload retry from silently recreating this project.
    const finished = (await ctx.db.get(projectId))!;
    await ctx.db.patch(projectId, {
      name: '',
      slug: undefined,
      ...(finished.purge ? { purge: { ...finished.purge, completedAt: Date.now() } } : {}),
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
