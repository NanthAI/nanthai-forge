// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { blobStore } from './blobStore';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { currentAccess } from './access';
import { invariant } from '../src/errors';

export const prepare = internalAction({
  args: { id: v.id('imports'), generation: v.number() },
  returns: v.union(v.null(), v.object({ repository: v.string(), ref: v.string(), uploadUrl: v.string() })),
  handler: async (
    ctx,
    { id, generation },
  ): Promise<{ repository: string; ref: string; uploadUrl: string } | null> => {
    const job = await ctx.runQuery(internal.imports.get, { id });
    if (!job || job.visibility !== 'public' || !job.remote || job.generation !== generation) return null;
    await currentAccess(ctx, id, undefined);
    if (!(await ctx.runMutation(internal.imports.claim, { id, generation }))) return null;
    return { repository: job.repository, ref: job.ref, uploadUrl: await blobStore(ctx).generateUploadUrl() };
  },
});
export const update = internalAction({
  args: {
    id: v.id('imports'),
    generation: v.number(),
    phase: v.union(v.literal('fetching'), v.literal('indexing'), v.literal('ready'), v.literal('error')),
    processed: v.optional(v.number()),
    total: v.optional(v.number()),
    error: v.optional(v.string()),
    artifactKey: v.optional(v.id('_storage')),
    head: v.optional(v.string()),
    analysisVersion: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    for (const value of [args.processed, args.total])
      invariant(
        value === undefined || (Number.isSafeInteger(value) && value >= 0),
        'BAD_ARGUMENT',
        'Invalid worker progress.',
      );
    const job = await ctx.runQuery(internal.imports.get, { id: args.id });
    if (!job || job.removal) {
      if (
        args.artifactKey &&
        !(await ctx.runQuery(internal.imports.artifactInUse, { artifactKey: args.artifactKey }))
      )
        await blobStore(ctx).delete(args.artifactKey);
      return false;
    }
    if (job.visibility !== 'public' || !job.remote) return false;
    // Reconcile an uncertain successful callback before cleaning up any new upload.
    if (args.artifactKey && job.artifactKey === args.artifactKey) return true;
    let published = false;
    try {
      if (
        job.generation !== args.generation ||
        !job.workerClaimed ||
        !['queued', 'fetching', 'indexing'].includes(job.phase)
      )
        return false;
      if (args.phase === 'ready') {
        invariant(
          args.artifactKey && args.head && /^[a-f0-9]{40,64}$/.test(args.head) && args.analysisVersion,
          'INVALID_ARTIFACT',
          'Worker publication metadata is incomplete.',
        );
        await currentAccess(ctx, args.id, undefined);
      }
      const { artifactKey: _key, head: _head, analysisVersion: _version, ...progress } = args;
      void _key;
      void _head;
      void _version;
      published = await ctx.runMutation(internal.imports.update, args.phase === 'ready' ? args : progress);
      return published;
    } finally {
      if (args.artifactKey && !(published && args.phase === 'ready')) {
        const current = await ctx.runQuery(internal.imports.get, { id: args.id });
        if (current?.artifactKey !== args.artifactKey) await blobStore(ctx).delete(args.artifactKey);
      }
    }
  },
});
