import { artifactMetadata } from './artifactStorage';
import { removeDerived } from './derivedArtifacts';
import { blobStore } from './blobStore';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { query, mutation, internalMutation, internalQuery } from './cliServer';
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { trackArtifact } from './artifacts';
import { purgeAgentGrants } from './agentGrants';
import { purgeSourceZones } from './sourceZones';
import { invariant } from '../src/errors';
import { report } from './errors';

const item = v.object({
  id: v.id('imports'),
  repository: v.string(),
  ref: v.string(),
  phase: v.string(),
  removal: v.optional(v.union(v.literal('trash'), v.literal('deleting'))),
  removedAt: v.optional(v.number()),
  snapshotInfoSupported: v.literal(true),
});
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({ page: v.array(item), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, { paginationOpts }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return { page: [], isDone: true, continueCursor: '' };
    const result = await ctx.db
      .query('imports')
      .withIndex('by_owner_and_visibility', q => q.eq('owner', user.subject).eq('visibility', 'private'))
      .order('desc')
      .paginate(paginationOpts);
    // Approved ownership-only metadata for cleanup, even after GitHub access is revoked.
    return {
      page: result.page
        .filter(job => job.removal !== 'deleting')
        .map(job => ({
          id: job._id,
          repository: job.repository,
          ref: job.ref,
          phase: job.phase,
          snapshotInfoSupported: true as const,
          ...(job.removal ? { removal: job.removal, removedAt: job.removedAt } : {}),
        })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

async function stop(ctx: MutationCtx, job: Doc<'imports'>) {
  if (job.task) {
    const task = await ctx.db.system.get(job.task);
    if (task?.state.kind === 'pending') await ctx.scheduler.cancel(job.task);
  }
  await trackArtifact(ctx, job._id, job.artifactKey);
}
export const trash = mutation({
  args: { id: v.id('imports') },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    try {
      const user = await ctx.auth.getUserIdentity(),
        job = await ctx.db.get(id);
      invariant(
        user && job?.visibility === 'private' && job.owner === user.subject,
        'GITHUB_UNAVAILABLE',
        'This Codescape is unavailable with the current access.',
      );
      if (job.removal) return null;
      await stop(ctx, job);
      await ctx.db.patch(id, {
        removal: 'trash',
        removedAt: Date.now(),
        generation: job.generation + 1,
        syncRevision: (job.syncRevision ?? 0) + 1,
        task: undefined,
        phase: job.artifactKey ? 'ready' : 'error',
        error: job.artifactKey ? undefined : 'Import removed before completion. Retry after restoring it.',
      });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export const restore = internalMutation({
  args: { id: v.id('imports'), owner: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, owner }) => {
    const job = await ctx.db.get(id);
    invariant(
      job?.visibility === 'private' && job.owner === owner && job.removal !== 'deleting',
      'GITHUB_UNAVAILABLE',
      'This Codescape is unavailable with the current access.',
    );
    await ctx.db.patch(id, { removal: undefined, removedAt: undefined });
    return null;
  },
});
export async function deleteImport(ctx: MutationCtx, id: Doc<'imports'>['_id']) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'GITHUB_UNAVAILABLE', 'This Codescape is unavailable with the current access.');
  const job = await ctx.db.get(id);
  // Identical no-op for missing or another owner's ID; no existence oracle, and lost successful replies reconcile.
  if (!job || job.visibility !== 'private' || job.owner !== user.subject) return null;
  if (job.removal === 'deleting' && job.task) {
    const task = await ctx.db.system.get(job.task);
    if (task && ['pending', 'inProgress'].includes(task.state.kind)) return null;
  }
  await stop(ctx, job);
  const task = await ctx.scheduler.runAfter(0, internal.lifecycle.purge, { id });
  await ctx.db.patch(id, {
    removal: 'deleting',
    removedAt: job.removedAt ?? Date.now(),
    generation: job.generation + 1,
    syncRevision: (job.syncRevision ?? 0) + 1,
    task,
  });
  return null;
}
export const permanentlyDelete = mutation({
  args: { id: v.id('imports') },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    try {
      return await deleteImport(ctx, id);
    } catch (error) {
      return report(error);
    }
  },
});
export const purge = internalMutation({
  args: { id: v.id('imports') },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const job = await ctx.db.get(id);
    if (!job || job.removal !== 'deleting') return null;
    if (await purgeAgentGrants(ctx, id)) {
      const task = await ctx.scheduler.runAfter(0, internal.lifecycle.purge, { id });
      await ctx.db.patch(id, { task });
      return null;
    }
    if (await purgeSourceZones(ctx, id)) {
      const task = await ctx.scheduler.runAfter(0, internal.lifecycle.purge, { id });
      await ctx.db.patch(id, { task });
      return null;
    }
    // Deleting the first indexed page is a stable drain cursor: deleted rows never shift a numeric offset.
    for (const table of ['savedViews', 'projectInterests', 'interestChanges'] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex('by_importId', q => q.eq('importId', id))
        .take(50);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length === 50) {
        const task = await ctx.scheduler.runAfter(0, internal.lifecycle.purge, { id });
        await ctx.db.patch(id, { task });
        return null;
      }
    }
    const readers = await ctx.db
      .query('importReaders')
      .withIndex('by_importId_and_reader', q => q.eq('importId', id))
      .take(50);
    for (const reader of readers) await ctx.db.delete(reader._id);
    if (readers.length === 50) {
      const task = await ctx.scheduler.runAfter(0, internal.lifecycle.purge, { id });
      await ctx.db.patch(id, { task });
      return null;
    }
    const teams = await ctx.db
      .query('teamImports')
      .withIndex('by_importId_and_teamId', q => q.eq('importId', id))
      .take(50);
    for (const team of teams) await ctx.db.delete(team._id);
    if (teams.length === 50) {
      const task = await ctx.scheduler.runAfter(0, internal.lifecycle.purge, { id });
      await ctx.db.patch(id, { task });
      return null;
    }
    const artifacts = await ctx.db
      .query('importArtifacts')
      .withIndex('by_importId_and_artifactKey', q => q.eq('importId', id))
      .take(50);
    for (const artifact of artifacts) {
      const [owners, current] = await Promise.all([
        ctx.db
          .query('importArtifacts')
          .withIndex('by_artifactKey', q => q.eq('artifactKey', artifact.artifactKey))
          .take(2),
        ctx.db
          .query('imports')
          .withIndex('by_artifactKey', q => q.eq('artifactKey', artifact.artifactKey))
          .take(2),
      ]);
      if (!owners.some(row => row.importId !== id) && !current.some(row => row._id !== id)) {
        await blobStore(ctx).delete(artifact.artifactKey);
        await removeDerived(ctx, artifact.artifactKey);
      }
      await ctx.db.delete(artifact._id);
    }
    if (artifacts.length === 50) {
      const task = await ctx.scheduler.runAfter(0, internal.lifecycle.purge, { id });
      await ctx.db.patch(id, { task });
    } else await ctx.db.delete(id);
    return null;
  },
});
export const fileInfo = internalQuery({
  args: { id: v.string() },
  returns: v.union(
    v.null(),
    v.object({ size: v.number(), sha256: v.string(), contentType: v.optional(v.string()) }),
  ),
  handler: async (ctx, { id }) => {
    const file = await artifactMetadata(ctx, id);
    return file
      ? {
          size: file.size,
          sha256: file.sha256,
          ...(file.contentType ? { contentType: file.contentType } : {}),
        }
      : null;
  },
});
