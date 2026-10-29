// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { blobStore } from './blobStore';
import { artifactBlobId } from './artifactBlobFields';
import { r2Config, presignPut } from './r2';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import { currentAccess } from './access';
import { invariant } from '../src/errors';

async function discard(ctx: ActionCtx, ref: string, id: string, generation: number) {
  if (artifactBlobId(ref)) {
    const row = await ctx.runQuery(internal.artifactStorage.get, { ref });
    if (
      row?.namespace !== `v1/i/${id}/g/${generation}` ||
      (await ctx.runQuery(internal.imports.artifactInUse, { artifactKey: ref }))
    )
      return;
  }
  await blobStore(ctx).delete(ref);
}

export const prepare = internalAction({
  args: { id: v.id('imports'), generation: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      repository: v.string(),
      ref: v.string(),
      uploadUrl: v.optional(v.string()),
      r2: v.optional(v.boolean()),
    }),
  ),
  handler: async (
    ctx,
    { id, generation },
  ): Promise<{ repository: string; ref: string; uploadUrl?: string; r2?: boolean } | null> => {
    const job = await ctx.runQuery(internal.imports.get, { id });
    if (!job || job.visibility !== 'public' || !job.remote || job.generation !== generation) return null;
    await currentAccess(ctx, id, undefined);
    if (!(await ctx.runMutation(internal.imports.claim, { id, generation }))) return null;
    return {
      repository: job.repository,
      ref: job.ref,
      r2: true,
    };
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
    artifactKey: v.optional(v.string()),
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
        await discard(ctx, args.artifactKey, args.id, args.generation);
      return false;
    }
    if (job.visibility !== 'public' || !job.remote) return false;
    // Reconcile an uncertain successful callback before cleaning up any new upload.
    if (args.artifactKey && job.artifactKey === args.artifactKey) return true;
    let published = false,
      keepPending = false;
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
        if (artifactBlobId(args.artifactKey)) {
          const bound = await ctx.runQuery(internal.artifactStorage.get, { ref: args.artifactKey });
          invariant(
            bound?.namespace === `v1/i/${args.id}/g/${args.generation}`,
            'INVALID_ARTIFACT',
            'Worker artifact belongs to another import.',
          );
          // HEAD failures leave the exact reservation retryable, like projectObjects.
          keepPending = true;
          await ctx.runAction(internal.artifactStorage.commit, { ref: args.artifactKey });
        }
      }
      const { artifactKey: _key, head: _head, analysisVersion: _version, ...progress } = args;
      void _key;
      void _head;
      void _version;
      published = await ctx.runMutation(internal.imports.update, args.phase === 'ready' ? args : progress);
      return published;
    } finally {
      if (args.artifactKey && !(published && args.phase === 'ready') && !keepPending) {
        const current = await ctx.runQuery(internal.imports.get, { id: args.id });
        if (current?.artifactKey !== args.artifactKey)
          await discard(ctx, args.artifactKey, args.id, args.generation);
      }
    }
  },
});

/** The runner computes pins after building the artifact; only metadata crosses
 * the callback. R2 credentials stay on the backend. */
export const uploadTarget = internalAction({
  args: { id: v.id('imports'), generation: v.number(), digest: v.string(), size: v.number() },
  returns: v.object({
    ref: v.string(),
    target: v.object({ kind: v.literal('r2'), url: v.string(), headers: v.record(v.string(), v.string()) }),
  }),
  handler: async (
    ctx,
    { id, generation, digest, size },
  ): Promise<{ ref: string; target: { kind: 'r2'; url: string; headers: Record<string, string> } }> => {
    const job = await ctx.runQuery(internal.imports.get, { id });
    invariant(
      job &&
        !job.removal &&
        job.visibility === 'public' &&
        job.remote &&
        job.workerClaimed &&
        job.generation === generation,
      'INVALID_ARTIFACT',
      'Original worker import is unavailable.',
    );
    await currentAccess(ctx, id, undefined);
    const row = await ctx.runMutation(internal.artifactStorage.reserve, {
      namespace: `v1/i/${id}/g/${generation}`,
      digest,
      size,
      contentType: 'application/gzip',
    });
    return { ref: `r2blob:${row._id}`, target: await presignPut(r2Config(), row.r2Key, row) };
  },
});
