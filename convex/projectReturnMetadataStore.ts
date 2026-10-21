// SPDX-License-Identifier: Apache-2.0
import { blobStore } from './blobStore';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { internalQuery, internalMutation } from './_generated/server';
import { activeOwnedProject } from './projectAuthority';
import { report } from './errors';
import { invariant } from '../src/errors';
const base = {
  projectId: v.id('hostedProjects'),
  owner: v.string(),
  partitionId: v.id('projectWorkGenerations'),
  key: v.string(),
  position: v.number(),
};
export const put = internalMutation({
  args: { ...base, body: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      await activeOwnedProject(ctx, input.projectId, input.owner);
      const partition = await ctx.db.get(input.partitionId);
      invariant(partition?.projectId === input.projectId, 'WORK_STALE', 'Return metadata partition changed.');
      const old = await ctx.db
        .query('projectReturnPages')
        .withIndex('by_partition_and_key_and_position', q =>
          q.eq('partitionId', input.partitionId).eq('key', input.key).eq('position', input.position),
        )
        .unique();
      invariant(!old || old.body === input.body, 'WORK_OPERATION_CHANGED', 'Return metadata page changed.');
      if (!old)
        await ctx.db.insert('projectReturnPages', {
          projectId: input.projectId,
          partitionId: input.partitionId,
          key: input.key,
          position: input.position,
          body: input.body,
        });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export const read = internalQuery({
  args: base,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await activeOwnedProject(ctx, input.projectId, input.owner);
      const partition = await ctx.db.get(input.partitionId);
      invariant(partition?.projectId === input.projectId, 'WORK_STALE', 'Return metadata partition changed.');
      const page = await ctx.db
        .query('projectReturnPages')
        .withIndex('by_partition_and_key_and_position', q =>
          q.eq('partitionId', input.partitionId).eq('key', input.key).eq('position', input.position),
        )
        .unique();
      invariant(page, 'WORK_STALE', 'Return metadata page is unavailable.');
      return page.body;
    } catch (error) {
      return report(error);
    }
  },
});
/** Replaces the old cursor-blob deletion with the same bounded metadata cleanup. */
export const retire = internalMutation({
  args: { partitionId: v.id('projectWorkGenerations'), key: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const partition = await ctx.db.get(input.partitionId);
    if (!partition) return null;
    for (const ref of [
      partition.returnMetadataCursor,
      partition.returnMetadataSnapshot,
      partition.returnPrepareCursor,
    ])
      if (ref && JSON.parse(ref).key === input.key) return null;
    const rows = await ctx.db
      .query('projectReturnPages')
      .withIndex('by_partition_and_key_and_position', q =>
        q.eq('partitionId', input.partitionId).eq('key', input.key),
      )
      .take(50);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === 50)
      await ctx.scheduler.runAfter(0, internal.projectReturnMetadataStore.retire, input);
    return null;
  },
});

/** Unpin all cursor metadata atomically with publication; cleanup runs separately. */
export async function detachReturnMetadata(ctx: MutationCtx, stage: Doc<'projectWorkGenerations'>) {
  const refs = [stage.returnMetadataCursor, stage.returnMetadataSnapshot, stage.returnPrepareCursor]
    .filter((ref): ref is string => !!ref)
    .map(ref => JSON.parse(ref));
  refs.push({ blobs: [stage.returnCursor, stage.returnSnapshot].filter(Boolean) });
  await ctx.db.patch(stage._id, {
    returnCleanupRefs: JSON.stringify(refs),
    returnCursor: undefined,
    returnSnapshot: undefined,
    returnMetadataCursor: undefined,
    returnMetadataSnapshot: undefined,
    returnPrepareCursor: undefined,
  });
  await ctx.scheduler.runAfter(0, internal.projectReturnMetadataStore.release, { partitionId: stage._id });
}

/** Detach private cursor references after publication and schedule bounded cleanup.
 * Cleanup lists can contain one key per output batch, regardless of Work size. */
export const release = internalMutation({
  args: { partitionId: v.id('projectWorkGenerations') },
  returns: v.null(),
  handler: async (ctx, { partitionId }) => {
    const stage = await ctx.db.get(partitionId);
    if (!stage) return null;
    const refs: { key?: string; cleanup?: string[]; blobs?: string[] }[] = stage.returnCleanupRefs
      ? JSON.parse(stage.returnCleanupRefs)
      : [stage.returnMetadataCursor, stage.returnMetadataSnapshot, stage.returnPrepareCursor]
          .filter((ref): ref is string => !!ref)
          .map(ref => JSON.parse(ref));
    if (!stage.returnCleanupRefs) {
      if (stage.returnCursor) await blobStore(ctx).delete(stage.returnCursor);
      if (stage.returnSnapshot) await blobStore(ctx).delete(stage.returnSnapshot);
      await ctx.db.patch(partitionId, {
        returnCleanupRefs: JSON.stringify(refs),
        returnCursor: undefined,
        returnSnapshot: undefined,
        returnMetadataCursor: undefined,
        returnMetadataSnapshot: undefined,
        returnPrepareCursor: undefined,
      });
    }
    const tasks = refs.flatMap(ref => [
      ...(ref.blobs ?? []).map(id => ({ blob: id })),
      ...[ref.key, ...(ref.cleanup ?? [])].filter((key): key is string => !!key).map(key => ({ key })),
    ]);
    const offset = stage.returnCleanupOffset ?? 0;
    for (const task of tasks.slice(offset, offset + 50)) {
      if ('blob' in task) await blobStore(ctx).delete(task.blob);
      else
        await ctx.scheduler.runAfter(0, internal.projectReturnMetadataStore.retire, {
          partitionId,
          key: task.key,
        });
    }
    const done = offset + 50 >= tasks.length;
    await ctx.db.patch(partitionId, {
      returnCleanupOffset: done ? undefined : offset + 50,
      ...(done ? { returnCleanupRefs: undefined } : {}),
    });
    if (!done) await ctx.scheduler.runAfter(0, internal.projectReturnMetadataStore.release, { partitionId });
    return null;
  },
});
