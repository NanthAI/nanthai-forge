// SPDX-License-Identifier: Apache-2.0
import { blobStore } from './blobStore';
import { internal } from './_generated/api';
import { v, type Infer } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
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
const putArgs = v.object({ ...base, body: v.string() });
async function putPage(ctx: MutationCtx, input: Infer<typeof putArgs>, authorized = false) {
  try {
    if (!authorized) await activeOwnedProject(ctx, input.projectId, input.owner);
    const partition = await ctx.db.get(input.partitionId);
    invariant(partition?.projectId === input.projectId, 'WORK_STALE', 'Return metadata partition changed.');
    invariant(
      !partition.returnRetired &&
        !(partition.status === 'ready' && !partition.returnCursor && !partition.returnMetadataCursor),
      'WORK_STALE',
      'Return metadata stage was retired.',
    );
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
}
export const put = internalMutation({ args: putArgs.fields, returns: v.null(), handler: putPage });
async function readPage(ctx: QueryCtx, input: Omit<Infer<typeof putArgs>, 'body'>, authorized = false) {
  try {
    if (!authorized) await activeOwnedProject(ctx, input.projectId, input.owner);
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
}
export const read = internalQuery({ args: base, returns: v.string(), handler: readPage });
export const putBatch = internalMutation({
  args: { ...base, bodies: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, input) => {
    invariant(
      input.bodies.length > 0 &&
        input.bodies.length <= 64 &&
        input.bodies.reduce((sum, body) => sum + new TextEncoder().encode(body).byteLength, 0) <=
          2 * 1024 * 1024,
      'BAD_ARGUMENT',
      'Write return metadata in bounded pages.',
    );
    await activeOwnedProject(ctx, input.projectId, input.owner);
    for (const [index, body] of input.bodies.entries())
      await putPage(ctx, { ...input, position: input.position + index, body }, true);
    return null;
  },
});
export const readBatch = internalQuery({
  args: { ...base, count: v.number() },
  returns: v.array(v.string()),
  handler: async (ctx, input) => {
    invariant(
      Number.isSafeInteger(input.count) && input.count > 0 && input.count <= 64,
      'BAD_ARGUMENT',
      'Read return metadata in bounded pages.',
    );
    await activeOwnedProject(ctx, input.projectId, input.owner);
    const bodies: string[] = [];
    let bytes = 0;
    for (let index = 0; index < input.count; index++) {
      const body = await readPage(ctx, { ...input, position: input.position + index }, true);
      if (index && bytes + new TextEncoder().encode(body).byteLength > 2 * 1024 * 1024) break;
      bodies.push(body);
      bytes += new TextEncoder().encode(body).byteLength;
    }
    return bodies;
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
    const blobs = refs.flatMap(ref => ref.blobs ?? []);
    const offset = stage.returnCleanupOffset ?? 0;
    for (const blob of blobs.slice(offset, offset + 50)) await blobStore(ctx).delete(blob);
    if (offset + 50 < blobs.length) {
      await ctx.db.patch(partitionId, { returnCleanupOffset: offset + 50 });
      await ctx.scheduler.runAfter(0, internal.projectReturnMetadataStore.release, { partitionId });
      return null;
    }
    // Every cursor/output reference is detached. Drain the partition together,
    // including unreferenced pages from a lost write, rather than one task/key.
    const page = await ctx.db
      .query('projectReturnPages')
      .withIndex('by_partition_and_key_and_position', q => q.eq('partitionId', partitionId))
      .paginate({ cursor: null, numItems: 200, maximumRowsRead: 200, maximumBytesRead: 6000000 });
    for (const row of page.page) await ctx.db.delete(row._id);
    await ctx.db.patch(partitionId, {
      returnCleanupOffset: page.isDone ? undefined : blobs.length,
      ...(page.isDone ? { returnCleanupRefs: undefined } : {}),
    });
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.projectReturnMetadataStore.release, { partitionId });
    return null;
  },
});
