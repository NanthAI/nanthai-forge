// SPDX-License-Identifier: Apache-2.0
import { workRecordTable } from './projectWorkRecordTables';
import type { Id } from './_generated/dataModel';
import { v } from 'convex/values';
import { internalMutation, internalQuery, type QueryCtx } from './server';
import { activeOwnedProject } from './projectAuthority';
import { findObject, findStoredObject, objectRow } from './projectObjectFind';
import { validStateGeneration } from '../src/state/generation';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { channelRow } from './projectHostedChannels';
import { invariant } from '../src/errors';

const generationOperator = {
  projectId: v.id('hostedProjects'),
  actor: v.string(),
  operationId: v.string(),
};
async function readLevels(ctx: QueryCtx, projectId: Id<'hostedProjects'>, heads: string[]) {
  const result = [];
  for (const head of heads) {
    const row = await findStoredObject(ctx, projectId, head);
    result.push({
      head,
      size: row && !row.removed ? row.size : null,
      generation: row && !row.removed ? (row.stateGeneration ?? null) : null,
    });
  }
  return result;
}
/** Operator-only finite scan. The creation order normally puts verified parents
 * before children; dependency work also covers imported/intermediate States. */
export const page = internalQuery({
  args: {
    ...generationOperator,
    cursor: v.union(v.string(), v.null()),
    pending: v.array(v.string()),
    preview: v.boolean(),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    const project = await activeOwnedProject(ctx, input.projectId, input.actor);
    invariant(input.pending.length <= 100, 'BAD_ARGUMENT', 'Read one generation page.');
    type Cursor = { phase: 'hosted' | 'imported' | 'done'; page: string | null; partition: string | null };
    let cursor: Cursor;
    if (input.cursor) cursor = JSON.parse(input.cursor);
    else {
      const generation = await selectedGeneration(ctx, project);
      cursor = { phase: 'hosted', page: null, partition: generation ? recordPartition(generation) : null };
    }
    invariant(
      ['hosted', 'imported', 'done'].includes(cursor.phase),
      'BAD_ARGUMENT',
      'Resume the original generation cursor.',
    );
    const heads = [...input.pending];
    if (!heads.length && cursor.phase === 'hosted') {
      const scan = await ctx.db
        .query('projectHostedStates')
        .withIndex('by_project', q => q.eq('projectId', input.projectId))
        .paginate({ cursor: cursor.page, numItems: 100 });
      heads.push(...scan.page.map(row => row.head));
      cursor = {
        ...cursor,
        page: scan.isDone ? null : scan.continueCursor,
        phase: scan.isDone ? 'imported' : 'hosted',
      };
    } else if (!heads.length && cursor.phase === 'imported') {
      // Old imported/seeded States were not publication rows. This index only
      // discovers candidate identities; its parent hints never establish levels.
      if (cursor.partition) {
        const partition = cursor.partition as Id<'projectWorkGenerations'>;
        const generation = await ctx.db.get(partition);
        invariant(
          generation?.projectId === input.projectId,
          'SOURCE_UNAVAILABLE',
          'Generation partition belongs to another project.',
        );
        const scan = await ctx.db
          .query(await workRecordTable(ctx, partition, 'sourceStateParents'))
          .withIndex('by_generation_and_collection_and_key', q =>
            q.eq('generationId', partition).eq('collection', 'sourceStateParents'),
          )
          .paginate({ cursor: cursor.page, numItems: 100 });
        heads.push(...scan.page.map(row => row.key));
        cursor = {
          ...cursor,
          page: scan.isDone ? null : scan.continueCursor,
          phase: scan.isDone ? 'done' : 'imported',
        };
      } else cursor = { ...cursor, phase: 'done' };
      if (cursor.phase === 'done') {
        const main = await channelRow(ctx, input.projectId);
        const backup = !main && project.currentBackup ? await ctx.db.get(project.currentBackup) : null;
        const head = main ? JSON.parse(main.selection).head : backup?.preview.head;
        if (typeof head === 'string' && /^[a-f0-9]{64}$/.test(head)) heads.push(head);
      }
    }
    const uniqueHeads = [...new Set(heads)];
    const rows = [];
    let bytes = 0,
      position = 0;
    for (; position < uniqueHeads.length; position++) {
      if (!input.preview && bytes >= 2 * 1024 * 1024) break;
      const head = uniqueHeads[position]!,
        object = await findStoredObject(ctx, input.projectId, head);
      invariant(object && !object.removed, 'SOURCE_UNAVAILABLE', 'A retained State object is unavailable.');
      if (
        !input.preview &&
        bytes &&
        object.stateGeneration === undefined &&
        bytes + object.size > 2 * 1024 * 1024
      )
        break;
      rows.push({ head, size: object.size, generation: object.stateGeneration ?? null });
      if (object.stateGeneration === undefined) bytes += object.size;
    }
    return JSON.stringify({
      rows,
      bytes,
      remaining: uniqueHeads.slice(position),
      cursor: JSON.stringify(cursor),
      done: cursor.phase === 'done',
    });
  },
});
/** Bounded parent-level pages, independent of State fan-in. Only immutable
 * levels are returned; missing metadata keeps its dependent State unresolved. */
export const levels = internalQuery({
  args: { ...generationOperator, heads: v.array(v.string()) },
  returns: v.array(
    v.object({
      head: v.string(),
      size: v.union(v.number(), v.null()),
      generation: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    invariant(input.heads.length <= 100, 'BAD_ARGUMENT', 'Read one parent-level page.');
    return readLevels(ctx, input.projectId, input.heads);
  },
});
/** Only the fixed action submits levels derived from hash-verified parent
 * bytes and bounded, freshly authorized server metadata pages. No public
 * request or continuation accepts these values. Like source output publication,
 * this transaction authenticates the current binding and immutable result. */
export const commit = internalMutation({
  args: {
    ...generationOperator,
    states: v.array(v.object({ head: v.string(), size: v.number(), generation: v.number() })),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    invariant(input.states.length <= 100, 'BAD_ARGUMENT', 'Commit one verified generation page.');
    let assigned = 0;
    for (const { head, size, generation } of input.states) {
      invariant(
        validStateGeneration(generation),
        'SOURCE_CLOSURE_INVALID',
        'State generation is not an exact topological level.',
      );
      const row = await findObject(ctx, input.projectId, head);
      invariant(
        row && !row.removed && row.size === size,
        'SOURCE_HASH_MISMATCH',
        'Verified State binding changed.',
      );
      invariant(
        row.stateGeneration === undefined || row.stateGeneration === generation,
        'SOURCE_HASH_MISMATCH',
        'Immutable State generation differs.',
      );
      if (row.stateGeneration !== undefined) continue;
      assigned++;
      const stored = await objectRow(ctx, row);
      await ctx.db.patch(stored._id, { stateGeneration: generation });
    }
    return JSON.stringify({ assigned });
  },
});
