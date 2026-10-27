// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalQuery, internalMutation, type QueryCtx, type MutationCtx } from './_generated/server';
import { accessibleProject } from './projectAuthority';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { invariant } from '../src/errors';
import type { Id } from './_generated/dataModel';
const selection = {
  projectId: v.id('hostedProjects'),
  actor: v.string(),
  generationId: v.id('projectWorkGenerations'),
  viewId: v.string(),
};
async function selected(
  ctx: QueryCtx | MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    generationId: Id<'projectWorkGenerations'>;
    viewId: string;
  },
) {
  const project = await accessibleProject(ctx, input.projectId, input.actor),
    generation = await selectedGeneration(ctx, project);
  invariant(generation?._id === input.generationId, 'WORK_STALE', 'Refresh the selected Work generation.');
  const partition = recordPartition(generation),
    row = await record(ctx, partition, 'views', input.viewId);
  invariant(row, 'NOT_FOUND', 'View not found.');
  const view = JSON.parse(row.value);
  invariant(view.head && view.status !== 'conflict', 'SOURCE_UNAVAILABLE', 'View has no composed source.');
  return { partition, view, key: `${view.base}:${view.head}` };
}
export const read = internalQuery({
  args: selection,
  returns: v.string(),
  handler: async (ctx, input) => {
    const { partition, view, key } = await selected(ctx, input),
      stats = await record(ctx, partition, 'diffstats', key);
    const pins = await Promise.all(
      [view.base, view.head].map(async head => {
        const row = await record(ctx, partition, 'sourceBlobs', head);
        invariant(row, 'SOURCE_UNAVAILABLE', 'View source pin is unavailable.');
        return JSON.parse(row.value);
      }),
    );
    return JSON.stringify({
      base: view.base,
      head: view.head,
      pins,
      changes: stats ? JSON.parse(stats.value) : (view.changes ?? null),
    });
  },
});
export const save = internalMutation({
  args: {
    ...selection,
    base: v.string(),
    head: v.string(),
    stats: v.object({
      files: v.number(),
      add: v.optional(v.number()),
      del: v.optional(v.number()),
      exact: v.boolean(),
      provenance: v.literal('server-computed'),
    }),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    const { partition, view, key } = await selected(ctx, input);
    invariant(view.base === input.base && view.head === input.head, 'WORK_STALE', 'View source changed.');
    const row = await record(ctx, partition, 'diffstats', key);
    if (row && JSON.parse(row.value).provenance === 'server-computed') return row.value;
    const value = JSON.stringify(input.stats);
    if (row) await ctx.db.patch(row._id, { value });
    else
      await ctx.db.insert('projectWorkRecords', {
        projectId: input.projectId,
        generationId: partition,
        collection: 'diffstats',
        key,
        parent: '',
        position: 0,
        value,
      });
    return value;
  },
});
