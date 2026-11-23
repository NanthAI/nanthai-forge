// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ConvexError, v } from 'convex/values';

import { internalMutation, internalQuery } from './server';
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
    // A job handed to the retired analysis worker (`remote`, Item ef6aa22a) has no callback left: it has stopped.
    const task = job.remote ? null : await ctx.db.system.get(job.task);
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
      // A job handed to the retired analysis worker (`remote`) has no callback left, so it is never still running.
      if (
        !previous.remote &&
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
    if (!previous || previous.removal || previous.generation !== generation) return false;
    if (changes.artifactKey) {
      await trackArtifact(ctx, id, previous.artifactKey);
      await trackArtifact(ctx, id, changes.artifactKey);
    }
    const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
    await ctx.db.patch(id, defined);
    return true;
  },
});

// Late worker callbacks must not delete a blob retained by another analysis.
export const artifactInUse = internalQuery({
  args: { artifactKey: v.string() },
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
