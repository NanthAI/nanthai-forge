// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { activeOwnedProject } from './projectAuthority';
import { workProject } from './projectWorkHead';
import { requireActiveReturn } from './projectReturnSupersede';
import { selectedGeneration, recordPartition, record } from './projectWorkIndexStore';
import { generationDocument, indexEntry } from './projectWorkIndexFields';
import { indexActivity } from '../src/work-hosted-index';
import { report } from './errors';
import { invariant } from '../src/errors';

/** Copy then patch a private partition. Cursor/offset advancement and row writes
 * share a transaction, so a lost reply never repeats or exposes a partial batch. */
export const batch = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    generationId: v.id('projectWorkGenerations'),
    partitionId: v.id('projectWorkGenerations'),
    expectedBackupId: v.id('projectBackups'),
    revision: v.number(),
    operationId: v.string(),
    plan: v.string(),
    copy: v.boolean(),
    cursor: v.union(v.string(), v.null()),
    offset: v.number(),
    total: v.number(),
    entries: v.array(indexEntry),
    removed: v.array(v.object({ collection: v.string(), key: v.string() })),
  },
  returns: generationDocument,
  handler: async (ctx, input) => {
    try {
      const project = await workProject(ctx, await activeOwnedProject(ctx, input.projectId, input.owner));
      await requireActiveReturn(ctx, input.projectId, input.operationId);
      const generation = await selectedGeneration(ctx, project),
        stage = await ctx.db.get(input.partitionId);
      invariant(
        generation?._id === input.generationId &&
          project.work?.backupId === input.expectedBackupId &&
          project.work.revision === input.revision &&
          stage?.projectId === project._id &&
          stage.returnOperationId === input.operationId &&
          stage.status === 'ready' &&
          recordPartition(generation) !== stage._id,
        'WORK_STALE',
        'Hosted Work changed during private return commit.',
      );
      invariant(
        !stage.returnCommitPlan || stage.returnCommitPlan === input.plan,
        'WORK_OPERATION_CHANGED',
        'Resume the original return projection.',
      );
      invariant(
        input.entries.length + input.removed.length <= 1000,
        'BAD_ARGUMENT',
        'Split private return writes into bounded batches.',
      );
      if (stage.returnCommitDone) return stage;
      if (input.copy) {
        if (stage.returnCommitCopied || input.cursor !== (stage.returnCommitCursor ?? null)) return stage;
        const page = await ctx.db
          .query('projectWorkRecords')
          .withIndex('by_generation', q => q.eq('generationId', recordPartition(generation)))
          .paginate({
            cursor: stage.returnCommitCursor ?? null,
            numItems: 1000,
            maximumRowsRead: 1000,
            maximumBytesRead: 500000,
          });
        for (const row of page.page) {
          const { _id: _id, _creationTime: _time, ...entry } = row;
          void _id;
          void _time;
          const old = await record(ctx, stage._id, row.collection, row.key);
          if (old) await ctx.db.replace(old._id, { ...entry, generationId: stage._id });
          else await ctx.db.insert('projectWorkRecords', { ...entry, generationId: stage._id });
        }
        await ctx.db.patch(stage._id, {
          returnCommitPlan: input.plan,
          returnCommitCursor: page.isDone ? undefined : page.continueCursor,
          returnCommitCopied: page.isDone,
        });
      } else if (input.offset === (stage.returnCommitOffset ?? 0)) {
        invariant(
          stage.returnCommitCopied,
          'WORK_STALE',
          'Copy the private return baseline before applying replacements.',
        );
        for (const pin of input.removed) {
          const old = await record(ctx, stage._id, pin.collection, pin.key);
          if (old) await ctx.db.delete(old._id);
        }
        for (const entry of input.entries) {
          const old = await record(ctx, stage._id, entry.collection, entry.key);
          const value = { ...entry, ...indexActivity(entry), status: entry.status };
          if (old) await ctx.db.patch(old._id, value);
          else
            await ctx.db.insert('projectWorkRecords', {
              ...value,
              projectId: project._id,
              generationId: stage._id,
            });
        }
        const offset = input.offset + input.entries.length + input.removed.length;
        invariant(
          offset <= input.total && (offset > input.offset || offset === input.total),
          'WORK_OPERATION_CHANGED',
          'Resume the original return projection batches.',
        );
        await ctx.db.patch(stage._id, {
          returnCommitOffset: offset,
          returnCommitDone: offset === input.total,
        });
      }
      return (await ctx.db.get(stage._id))!;
    } catch (error) {
      return report(error);
    }
  },
});
