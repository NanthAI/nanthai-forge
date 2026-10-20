// SPDX-License-Identifier: Apache-2.0
import { internal } from './_generated/api';
import { v } from 'convex/values';
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
    for (const ref of [partition.returnMetadataCursor, partition.returnMetadataSnapshot])
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
