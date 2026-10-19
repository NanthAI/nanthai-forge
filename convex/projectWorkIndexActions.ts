// SPDX-License-Identifier: Apache-2.0
'use node';
import { workProjection } from './projectSourceProjection';
import { v } from 'convex/values';
import { action, internalAction, type ActionCtx } from './cliServer';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { caller, load } from './projectWorkActions';
import { digest } from '../src/hash';
import { workBytes } from '../src/work-metadata';
import { report } from './errors';
async function ensureIndex(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  owner: string,
): Promise<Id<'projectWorkGenerations'>> {
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
    if (!generation) continue;
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
  }
}
export const ensureInternal = internalAction({
  args: { projectId: v.id('hostedProjects'), owner: v.string() },
  returns: v.id('projectWorkGenerations'),
  handler: async (ctx, input) => ensureIndex(ctx, input.projectId, input.owner),
});
export const ensure = action({
  args: { projectId: v.id('hostedProjects') },
  returns: v.id('projectWorkGenerations'),
  handler: async (ctx, { projectId }) => {
    try {
      return await ensureIndex(ctx, projectId, await caller(ctx));
    } catch (error) {
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
