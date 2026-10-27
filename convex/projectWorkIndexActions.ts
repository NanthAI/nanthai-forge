// SPDX-License-Identifier: Apache-2.0
'use node';
import { buildRecordIndex } from './projectWorkIndexBuild';
import { workProjection } from './projectSourceProjection';
import { v, ConvexError } from 'convex/values';
import { action, internalAction, type ActionCtx } from './cliServer';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { caller, load } from './projectWorkActions';
import { digest } from '../src/hash';
import { workBytes } from '../src/work-metadata';
import { report } from './errors';
import { ForgeError } from '../src/errors';
import { longActionExpired } from '../src/long-action';
import { indexReadContext, indexTransient } from './projectWorkIndexRetry';
import { resume } from './projectWorkIndexBuildTypes';
async function ensureIndex(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  owner: string,
  resumable = true,
): Promise<Id<'projectWorkGenerations'> | { pending: true; progress: string }> {
  ctx = indexReadContext(ctx);
  const paged = await buildRecordIndex(ctx, { projectId, owner });
  if (paged) {
    if (typeof paged === 'string' || resumable) return paged;
    let result = paged as Id<'projectWorkGenerations'> | { pending: true; progress: string };
    while (typeof result !== 'string') result = (await buildRecordIndex(ctx, { projectId, owner }))!;
    return result;
  }
  const started = Date.now();
  const expired = () => resumable && longActionExpired(started);
  while (true) {
    const existing: Doc<'projectWorkGenerations'> | null = await ctx.runQuery(
      internal.projectWorkIndexStore.current,
      { projectId, owner },
    );
    if (existing) return existing._id;
    const snapshot = await load(ctx, projectId, owner),
      projection = await workProjection(ctx, snapshot, owner);
    const generation: Doc<'projectWorkGenerations'> | null = await ctx.runMutation(
      internal.projectWorkIndexStore.begin,
      {
        projectId,
        owner,
        backupId: snapshot.backup._id,
        revision: snapshot.data.revision,
        initialRevision: snapshot.project.work!.initialRevision,
        metadata: JSON.stringify(projection.metadata),
      },
    );
    const pending = () => ({
      pending: true as const,
      progress: JSON.stringify({
        phase: 'index',
        step: generation?.nextBatch ?? 0,
        done: generation?.nextBatch ?? 0,
        total: 0,
      }),
    });
    if (!generation) {
      if (expired()) return pending();
      continue;
    }
    if (generation.status === 'ready') {
      if (
        await ctx.runMutation(internal.projectWorkIndexStore.publish, {
          projectId,
          owner,
          generationId: generation._id,
          batches: generation.nextBatch,
          metadata: JSON.stringify(projection.metadata),
        })
      )
        return generation._id;
      if (expired()) return pending();
      continue;
    }
    let current = true,
      batch = 0;
    for await (const entries of projection.batches()) {
      if (batch >= generation.nextBatch) {
        current = await ctx.runMutation(internal.projectWorkIndexStore.batch, {
          projectId,
          owner,
          generationId: generation._id,
          batch,
          entries,
        });
      }
      batch++;
      if (!current) break;
      if (batch > generation.nextBatch && expired())
        return {
          pending: true,
          progress: JSON.stringify({ phase: 'index', step: batch, done: batch, total: 0 }),
        };
    }
    if (
      current &&
      (await ctx.runMutation(internal.projectWorkIndexStore.publish, {
        projectId,
        owner,
        generationId: generation._id,
        batches: batch,
        metadata: JSON.stringify(projection.metadata),
      }))
    )
      return generation._id;
    if (expired()) return pending();
  }
}
export const ensureInternal = internalAction({
  args: { projectId: v.id('hostedProjects'), owner: v.string() },
  returns: v.id('projectWorkGenerations'),
  handler: async (ctx, input): Promise<Id<'projectWorkGenerations'>> => {
    const result = await ensureIndex(ctx, input.projectId, input.owner, false);
    if (typeof result === 'string') return result;
    // Internal commands retain their existing receipt-only contract. Their
    // caller cannot consume an index continuation as a completed command.
    throw new ForgeError('INTERNAL_ERROR', 'Internal index preparation returned an unexpected continuation.');
  },
});
export const ensure = action({
  args: { projectId: v.id('hostedProjects'), continuation: v.optional(v.boolean()) },
  returns: v.union(
    v.id('projectWorkGenerations'),
    v.object({ pending: v.literal(true), progress: v.string() }),
  ),
  handler: async (ctx, { projectId }) => {
    let owner: string | undefined;
    try {
      owner = await caller(ctx);
      return await ensureIndex(ctx, projectId, owner);
    } catch (error) {
      if (owner && indexTransient(error)) {
        // Read the durable position afresh, including after an unknown CAS reply.
        let generation: Doc<'projectWorkGenerations'> | null = null;
        try {
          generation = await indexReadContext(ctx).runQuery(resume, { projectId, owner });
        } catch (resumeError) {
          if (!indexTransient(resumeError)) throw resumeError;
        }
        return {
          pending: true as const,
          progress: JSON.stringify({
            phase: 'index',
            step: generation?.nextBatch ?? 0,
            buildPhase: generation?.ensureCursor ? JSON.parse(generation.ensureCursor).phase : 'settings',
            done: 0,
            total: 0,
            retryable: true,
          }),
        };
      }
      // Preserve the server's application code/message at this boundary. In
      // particular, do not replace an index failure with an empty HTTP Error.
      if (error instanceof ConvexError) throw error;
      if (error instanceof Error && !(error instanceof ForgeError)) {
        const code = (error as Error & { code?: unknown }).code;
        return report(
          new ForgeError(
            typeof code === 'string' ? code : 'WORK_INDEX_BUILD_FAILED',
            error.message || 'The Work index action failed without a diagnostic message.',
          ),
        );
      }
      return report(error);
    }
  },
});

export const checksum = action({
  args: { projectId: v.id('hostedProjects') },
  returns: v.string(),
  handler: async (ctx, { projectId }) => {
    try {
      const snapshot = await load(ctx, projectId, await caller(ctx));
      return JSON.stringify({
        backupId: snapshot.backup._id,
        revision: snapshot.data.revision,
        workDigest: digest(workBytes(snapshot.data)),
      });
    } catch (error) {
      return report(error);
    }
  },
});
