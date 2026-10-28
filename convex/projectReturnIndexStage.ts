// SPDX-License-Identifier: Apache-2.0
import { requireActiveReturn } from './projectReturnSupersede';
import { indexActivity } from '../src/work-hosted-index';
import { blobStore } from './blobStore';
import { v } from 'convex/values';
import { report } from './errors';
import { internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { workProject } from './projectWorkHead';
import { activeOwnedProject } from './projectAuthority';
import { indexEntry, generationDocument } from './projectWorkIndexFields';
import { selectedGeneration, recordPartition } from './projectWorkIndexStore';
import { HOSTED_WORK_INDEX_FORMAT } from '../src/work-hosted-summary';
import { invariant } from '../src/errors';
const base = {
  projectId: v.id('hostedProjects'),
  owner: v.string(),
  generationId: v.optional(v.id('projectWorkGenerations')),
  revision: v.number(),
};
export const resume = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    backupId: v.id('projectBackups'),
    revision: v.number(),
    operationId: v.string(),
  },
  returns: v.union(generationDocument, v.null()),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.owner);
    await requireActiveReturn(ctx, input.projectId, input.operationId);
    const original = await ctx.db
      .query('projectWorkGenerations')
      .withIndex('by_project_and_return_operation', q =>
        q.eq('projectId', input.projectId).eq('returnOperationId', input.operationId),
      )
      .unique();
    invariant(
      !original || (original.backupId === input.backupId && original.revision === input.revision),
      'WORK_OPERATION_CHANGED',
      'Resume the original source-return checkpoint.',
    );
    return original;
  },
});
/** An uncommitted compatibility prepare is disposable when validated records can resume. */
export const restartRecords = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    partitionId: v.id('projectWorkGenerations'),
    expectedBackupId: v.id('projectBackups'),
    revision: v.number(),
    operationId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, input) => {
    await requireActiveReturn(ctx, input.projectId, input.operationId);
    const project = await workProject(ctx, await activeOwnedProject(ctx, input.projectId, input.owner));
    const stage = await ctx.db.get(input.partitionId);
    invariant(
      project.work?.backupId === input.expectedBackupId && project.work.revision === input.revision,
      'WORK_STALE',
      'Hosted source or Work changed before record return.',
    );
    if (!stage?.returnOperationId) return false;
    invariant(
      stage.projectId === input.projectId && stage.returnOperationId === input.operationId,
      'WORK_OPERATION_CHANGED',
      'Resume the original source-return stage.',
    );
    if (
      stage.status !== 'building' ||
      stage.nextBatch !== 0 ||
      (stage.returnStep ?? 0) !== 0 ||
      stage.returnCursor ||
      stage.returnMetadataCursor ||
      stage.returnCommitPlan
    )
      return false;
    const backup = await ctx.db.get(stage.backupId),
      prior = await ctx.db.get(input.expectedBackupId);
    invariant(
      backup?.validatedWorkRecords === 1 && prior?.validatedWorkRecords === 1,
      'WORK_RETURN_DELTA_UNAVAILABLE',
      'Both checkpoints must have validated records before restarting.',
    );
    await ctx.db.patch(stage._id, {
      returnOperationId: undefined,
      returnPrepareCursor: undefined,
      returnRetired: true,
    });
    await ctx.scheduler.runAfter(0, internal.projectReturnIndexStage.retirePartition, {
      projectId: input.projectId,
      partitionId: stage._id,
    });
    return true;
  },
});
export const begin = internalMutation({
  args: {
    ...base,
    backupId: v.id('projectBackups'),
    localRevision: v.number(),
    metadata: v.string(),
    operationId: v.optional(v.string()),
    at: v.optional(v.string()),
    progress: v.optional(v.boolean()),
  },
  returns: v.union(v.id('projectWorkGenerations'), v.null()),
  handler: async (ctx, input) => {
    try {
      const project = await workProject(ctx, await activeOwnedProject(ctx, input.projectId, input.owner));
      const generation = await selectedGeneration(ctx, project);
      if (generation?._id !== input.generationId || project.work?.revision !== input.revision) return null;
      if (input.operationId) {
        const original = await ctx.db
          .query('projectWorkGenerations')
          .withIndex('by_project_and_return_operation', q =>
            q.eq('projectId', input.projectId).eq('returnOperationId', input.operationId),
          )
          .unique();
        if (original) {
          invariant(
            original.backupId === input.backupId && original.revision === input.localRevision + 1,
            'WORK_OPERATION_CHANGED',
            'Resume the original source-return checkpoint.',
          );
          // Two actions can choose timestamps before either reserves the stage.
          // Only the first timestamp belongs to this operation. Let the loser
          // observe its receipt/cursor without throwing from this mutation.
          if (original.returnAt !== input.at) return null;
          if (input.progress && original.returnStep === undefined && original.nextBatch > 0) {
            // R3 persisted write-only batch numbers, not computational cursors.
            // Keep its timestamp but restart only the disposable private rows.
            await ctx.db.patch(original._id, { returnOperationId: undefined });
            await ctx.scheduler.runAfter(0, internal.projectReturnIndexStage.retirePartition, {
              projectId: input.projectId,
              partitionId: original._id,
            });
          } else {
            if (input.progress && original.returnStep === undefined)
              await ctx.db.patch(original._id, { returnStep: 0 });
            return original._id;
          }
        }
      }
      return ctx.db.insert('projectWorkGenerations', {
        ...(input.operationId ? { returnOperationId: input.operationId, returnAt: input.at } : {}),
        ...(input.progress ? { returnStep: 0 } : {}),
        projectId: input.projectId,
        backupId: input.backupId,
        revision: input.localRevision + 1,
        initialRevision: input.localRevision,
        metadata: input.metadata,
        status: 'building',
        format: HOSTED_WORK_INDEX_FORMAT,
        nextBatch: 0,
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const batch = internalMutation({
  args: {
    ...base,
    partitionId: v.id('projectWorkGenerations'),
    batch: v.number(),
    entries: v.array(indexEntry),
    last: v.boolean(),
    metadata: v.optional(v.string()),
    cursor: v.optional(v.id('_storage')),
    metadataCursor: v.optional(v.string()),
    metadataSnapshot: v.optional(v.string()),
    snapshot: v.optional(v.id('_storage')),
    progress: v.optional(v.string()),
    step: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, input) => {
    try {
      const project = await workProject(ctx, await activeOwnedProject(ctx, input.projectId, input.owner));
      const generation = await selectedGeneration(ctx, project),
        partition = await ctx.db.get(input.partitionId);
      if (generation?._id !== input.generationId || project.work?.revision !== input.revision) return false;
      invariant(partition?.projectId === project._id, 'WORK_STALE', 'Return index staging changed.');
      invariant(!partition.returnRetired, 'WORK_STALE', 'Return stage was retired.');
      // An action that started before deployment must not append write-only
      // batches into a partition owned by the new computational cursor.
      if (partition.returnStep !== undefined && input.step === undefined) return false;
      if (input.step !== undefined && input.step !== (partition.returnStep ?? 0)) return false;
      if (input.batch < partition.nextBatch) return true;
      invariant(partition.status === 'building', 'WORK_STALE', 'Return index staging is already complete.');
      invariant(input.batch === partition.nextBatch, 'WORK_STALE', 'Resume the original return index batch.');
      invariant(input.entries.length <= 1000, 'BAD_ARGUMENT', 'Stage return rows in bounded batches.');
      for (const entry of input.entries)
        await ctx.db.insert('projectWorkRecords', {
          ...entry,
          ...indexActivity(entry),
          projectId: project._id,
          generationId: partition._id,
        });
      invariant(
        !partition.returnSnapshot || !input.snapshot || partition.returnSnapshot === input.snapshot,
        'WORK_OPERATION_CHANGED',
        'Resume the original source-return snapshot.',
      );
      invariant(
        !partition.returnMetadataSnapshot ||
          !input.metadataSnapshot ||
          partition.returnMetadataSnapshot === input.metadataSnapshot,
        'WORK_OPERATION_CHANGED',
        'Resume the original source-return metadata snapshot.',
      );
      if (input.cursor && partition.returnCursor) await blobStore(ctx).delete(partition.returnCursor);
      if (input.metadataCursor && partition.returnMetadataCursor)
        await ctx.scheduler.runAfter(0, internal.projectReturnMetadataStore.retire, {
          partitionId: partition._id,
          key: JSON.parse(partition.returnMetadataCursor).key,
        });
      await ctx.db.patch(partition._id, {
        nextBatch: input.batch + 1,
        ...(input.snapshot ? { returnSnapshot: input.snapshot } : {}),
        ...(input.metadataSnapshot ? { returnMetadataSnapshot: input.metadataSnapshot } : {}),
        ...(input.metadataCursor
          ? { returnMetadataCursor: input.metadataCursor, returnStep: (input.step ?? 0) + 1 }
          : {}),
        ...(input.progress ? { returnProgress: input.progress } : {}),
        ...(input.cursor ? { returnCursor: input.cursor, returnStep: (input.step ?? 0) + 1 } : {}),
        ...(input.last ? { status: 'ready' as const } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
      return true;
    } catch (error) {
      return report(error);
    }
  },
});
/** Preparation has its own CAS cursor and never makes a partition publishable. */
export const prepare = internalMutation({
  args: {
    ...base,
    partitionId: v.id('projectWorkGenerations'),
    operationId: v.string(),
    expectedBackupId: v.id('projectBackups'),
    expectedCursor: v.optional(v.string()),
    cursor: v.string(),
    progress: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, input) => {
    const project = await workProject(ctx, await activeOwnedProject(ctx, input.projectId, input.owner));
    const partition = await ctx.db.get(input.partitionId);
    invariant(
      project.work?.backupId === input.expectedBackupId &&
        project.work.revision === input.revision &&
        project.work.generationId === input.generationId &&
        partition?.projectId === input.projectId &&
        partition.returnOperationId === input.operationId,
      'WORK_STALE',
      'Hosted Work changed during return preparation.',
    );
    if (partition.returnPrepareCursor !== input.expectedCursor) return false;
    await ctx.db.patch(partition._id, { returnPrepareCursor: input.cursor, returnProgress: input.progress });
    if (input.expectedCursor)
      await ctx.scheduler.runAfter(0, internal.projectReturnMetadataStore.retire, {
        partitionId: partition._id,
        key: JSON.parse(input.expectedCursor).key,
      });
    return true;
  },
});
// A stable public generation can have an obsolete physical partition at its own
// ID. Remove only disposable rows, leaving the selected public identity intact.
export const retirePartition = internalMutation({
  args: { projectId: v.id('hostedProjects'), partitionId: v.id('projectWorkGenerations') },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const stored = await ctx.db.get(input.projectId);
      const project = stored ? await workProject(ctx, stored) : null;
      const selected = project?.work?.generationId ? await ctx.db.get(project.work.generationId) : null;
      if (selected && recordPartition(selected) === input.partitionId) return null;
      const partition = await ctx.db.get(input.partitionId);
      if (partition?.retainedForIntentMigration) return null;
      if (partition?.returnRetired) {
        const pages = await ctx.db
          .query('projectReturnPages')
          .withIndex('by_partition_and_key_and_position', q => q.eq('partitionId', input.partitionId))
          .paginate({ cursor: null, numItems: 200, maximumRowsRead: 200, maximumBytesRead: 6000000 });
        for (const row of pages.page) await ctx.db.delete(row._id);
        if (!pages.isDone) {
          await ctx.scheduler.runAfter(0, internal.projectReturnIndexStage.retirePartition, input);
          return null;
        }
      }
      const page = await ctx.db
        .query('projectWorkRecords')
        .withIndex('by_generation', q => q.eq('generationId', input.partitionId))
        .paginate({ cursor: null, numItems: 100, maximumBytesRead: 500000, maximumRowsRead: 100 });
      for (const row of page.page) await ctx.db.delete(row._id);
      if (!page.isDone)
        await ctx.scheduler.runAfter(0, internal.projectReturnIndexStage.retirePartition, input);
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
