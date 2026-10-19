// SPDX-License-Identifier: Apache-2.0
import { ConvexError, v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { internalMutation, internalQuery } from './_generated/server';
import { jobDocument } from './schema';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { trackArtifact } from './artifacts';

export const get = internalQuery({
  args: { id: v.id('imports') },
  returns: v.union(jobDocument, v.null()),
  handler: async (ctx, { id }) => {
    const job = await ctx.db.get(id);
    if (!job?.task || !['queued', 'fetching', 'indexing'].includes(job.phase)) return job;
    const task = await ctx.db.system.get(job.task);
    if (!task || ['failed', 'canceled'].includes(task.state.kind)) {
      return {
        ...job,
        phase: 'error' as const,
        error: 'The import worker stopped before completing. Retry to rebuild; previous source is retained.',
      };
    }
    return job;
  },
});
export const begin = internalMutation({
  args: {
    repository: v.string(),
    ref: v.string(),
    owner: v.string(),
    visibility: v.union(v.literal('public'), v.literal('private')),
  },
  returns: v.object({ id: v.id('imports'), run: v.boolean(), generation: v.number() }),
  handler: async (ctx, args): Promise<{ id: Id<'imports'>; run: boolean; generation: number }> => {
    const scope = args.visibility === 'private' ? args.owner : 'public';
    const previous = await ctx.db
      .query('imports')
      .withIndex('by_scope_and_repository_and_ref', q =>
        q.eq('scope', scope).eq('repository', args.repository).eq('ref', args.ref),
      )
      .unique();
    if (previous) {
      if (previous.removal)
        throw new ConvexError({
          code: 'IMPORT_REMOVED',
          message: 'Restore this private import before re-indexing it.',
        });
      const task = previous.task ? await ctx.db.system.get(previous.task) : null;
      if (
        ['queued', 'fetching', 'indexing'].includes(previous.phase) &&
        task &&
        ['pending', 'inProgress'].includes(task.state.kind)
      ) {
        return { id: previous._id, run: false, generation: previous.generation };
      }
      const generation = previous.generation + 1;
      const scheduled = await ctx.scheduler.runAfter(0, internal.indexer.run, {
        id: previous._id,
        generation,
      });
      await ctx.db.patch(previous._id, {
        phase: 'queued',
        error: undefined,
        processed: 0,
        total: 0,
        generation,
        task: scheduled,
        remote: undefined,
        workerClaimed: undefined,
      });
      return { id: previous._id, run: true, generation };
    }
    const id = await ctx.db.insert('imports', {
      ...args,
      scope,
      phase: 'queued',
      processed: 0,
      total: 0,
      generation: 1,
    });
    const task = await ctx.scheduler.runAfter(0, internal.indexer.run, { id, generation: 1 });
    await ctx.db.patch(id, { task });
    return { id, run: true, generation: 1 };
  },
});
export const update = internalMutation({
  args: {
    id: v.id('imports'),
    generation: v.number(),
    phase: v.union(v.literal('fetching'), v.literal('indexing'), v.literal('ready'), v.literal('error')),
    processed: v.optional(v.number()),
    total: v.optional(v.number()),
    error: v.optional(v.string()),
    artifactKey: v.optional(v.string()),
    head: v.optional(v.string()),
    analysisVersion: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, { id, generation, ...changes }) => {
    const previous = await ctx.db.get(id);
    if (
      !previous ||
      previous.removal ||
      previous.generation !== generation ||
      (previous.remote && !['queued', 'fetching', 'indexing'].includes(previous.phase))
    )
      return false;
    if (changes.artifactKey) {
      await trackArtifact(ctx, id, previous.artifactKey);
      await trackArtifact(ctx, id, changes.artifactKey);
    }
    const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
    await ctx.db.patch(id, defined);
    return true;
  },
});

export const handoff = internalMutation({
  args: { id: v.id('imports'), generation: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { id, generation }) => {
    const job = await ctx.db.get(id);
    if (!job || job.removal || job.visibility !== 'public' || job.generation !== generation || job.remote)
      return false;
    // The watchdog matches Netlify's existing fifteen-minute provider ceiling.
    const task = await ctx.scheduler.runAfter(900_000, internal.imports.expire, { id, generation });
    await ctx.db.patch(id, { task, remote: true, workerClaimed: false });
    return true;
  },
});
export const claim = internalMutation({
  args: { id: v.id('imports'), generation: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { id, generation }) => {
    const job = await ctx.db.get(id);
    if (
      !job ||
      job.removal ||
      job.visibility !== 'public' ||
      !job.remote ||
      job.workerClaimed ||
      job.generation !== generation ||
      !['queued', 'fetching', 'indexing'].includes(job.phase)
    )
      return false;
    await ctx.db.patch(id, { workerClaimed: true });
    return true;
  },
});
export const expire = internalMutation({
  args: { id: v.id('imports'), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, { id, generation }) => {
    const job = await ctx.db.get(id);
    if (
      job?.remote &&
      job.generation === generation &&
      ['queued', 'fetching', 'indexing'].includes(job.phase)
    ) {
      await ctx.db.patch(id, {
        phase: 'error',
        error: 'The import worker stopped before completing. Retry to rebuild; previous source is retained.',
      });
    }
    return null;
  },
});

// Recent means import creation order, not popularity or source freshness.
export const publicPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({ page: v.array(v.id('imports')), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, { paginationOpts }) => {
    const result = await ctx.db
      .query('imports')
      .withIndex('by_visibility', q => q.eq('visibility', 'public'))
      .order('desc')
      .paginate(paginationOpts);
    return {
      page: result.page
        .filter(job => !job.removal && job.phase === 'ready' && job.artifactKey && job.head)
        .map(job => job._id),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

// Late worker callbacks must not delete a blob retained by another analysis.
export const artifactInUse = internalQuery({
  args: { artifactKey: v.id('_storage') },
  returns: v.boolean(),
  handler: async (ctx, { artifactKey }) => {
    const current = await ctx.db
      .query('imports')
      .withIndex('by_artifactKey', q => q.eq('artifactKey', artifactKey))
      .take(1);
    const retained = await ctx.db
      .query('importArtifacts')
      .withIndex('by_artifactKey', q => q.eq('artifactKey', artifactKey))
      .take(1);
    return current.length > 0 || retained.length > 0;
  },
});
