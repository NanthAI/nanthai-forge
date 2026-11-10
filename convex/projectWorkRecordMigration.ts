// SPDX-License-Identifier: Apache-2.0
import { v, getDocumentSize } from 'convex/values';
import { internalMutation, internalAction } from './server';
import { internal } from './_generated/api';
import { projectPurgeWriter } from './projectFinishReadWriter';
import { splitRecordTable } from './projectWorkRecordTables';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';
import { projectExecution } from './projectExecution';

/** Explicit bounded migration, with no scheduler or idle calls. Copy receipts retain legacy ids,
 * so cleanup reads compact receipts instead of scanning all payload bytes a second time. */
export const page = internalMutation({
  args: {
    generationId: v.id('projectWorkGenerations'),
    operationId: v.string(),
    cursor: v.union(v.string(), v.null()),
    cleanup: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (wrapped, input) => {
    const ctx = projectPurgeWriter(wrapped);
    const generation = await ctx.db.get(input.generationId);
    invariant(generation, 'WORK_STALE', 'Select a retained Work generation.');
    projectExecution(ctx, generation.projectId);
    const phase = input.cleanup ? 'cleanup' : 'copy';
    const receiptKey = `workRecordTables:${phase}:${input.operationId}`;
    const receipt = await ctx.db
      .query('projectReturnPages')
      .withIndex('by_partition_and_key_and_position', q =>
        q.eq('partitionId', generation._id).eq('key', receiptKey).eq('position', 0),
      )
      .unique();
    if (receipt) {
      const previous = JSON.parse(receipt.body);
      invariant(
        previous.request === JSON.stringify(input),
        'WORK_OPERATION_CHANGED',
        'Replay the original migration page.',
      );
      return JSON.stringify(previous.result);
    }
    invariant(
      !generation.recordsGenerationId,
      'BAD_ARGUMENT',
      'Migrate the record partition, not its source-return wrapper.',
    );
    const prior = generation.recordTablesProgress ? JSON.parse(generation.recordTablesProgress) : null;
    invariant(
      !input.cleanup || generation.recordTables === 'split',
      'WORK_STALE',
      'Finish copying before cleanup.',
    );
    const currentCursor = prior?.phase === phase ? prior.result.nextCursor : null;
    invariant(input.cursor === currentCursor, 'WORK_STALE', 'Resume the saved migration cursor.');
    if (
      (!input.cleanup && generation.recordTables === 'split') ||
      (input.cleanup && prior?.phase === phase && prior.result.isDone)
    )
      return JSON.stringify({
        isDone: true,
        nextCursor: null,
        readBytes: 0,
        writtenBytes: 0,
        deletedBytes: 0,
        rows: 0,
      });
    if (!input.cleanup && generation.recordTables !== 'copying')
      await ctx.db.patch(generation._id, { recordTables: 'copying' });
    const legacyIds: string[] = [];
    let readBytes = 0,
      writtenBytes = 0,
      deletedBytes = 0,
      rows = 0,
      legacyBytes = 0;
    let isDone: boolean, nextCursor: string | null;
    if (input.cleanup) {
      const receipts = await ctx.db
        .query('projectReturnPages')
        .withIndex('by_partition_and_key_and_position', q =>
          q
            .eq('partitionId', generation._id)
            .gte('key', 'workRecordTables:copy:')
            .lt('key', 'workRecordTables:copy:\uffff'),
        )
        .paginate({ cursor: input.cursor, numItems: 1, maximumRowsRead: 1, maximumBytesRead: 512000 });
      for (const batch of receipts.page) {
        readBytes += getDocumentSize(batch);
        const plan = JSON.parse(batch.body) as { legacyIds: typeof legacyIds; legacyBytes: number };
        await Promise.all(
          plan.legacyIds.map(id =>
            ctx.db.delete(id as import('./_generated/dataModel').Id<'projectWorkRecords'>),
          ),
        );
        rows += plan.legacyIds.length;
        deletedBytes += plan.legacyBytes;
      }
      isDone = receipts.isDone;
      nextCursor = isDone ? null : receipts.continueCursor;
    } else {
      const page = await ctx.db
        .query('projectWorkRecords')
        .withIndex('by_generation', q => q.eq('generationId', generation._id))
        .paginate({ cursor: input.cursor, numItems: 100, maximumRowsRead: 100, maximumBytesRead: 512000 });
      for (const row of page.page) {
        readBytes += getDocumentSize(row);
        const table = splitRecordTable(row.collection);
        if (table === 'projectWorkRecords') continue;
        legacyIds.push(row._id);
        legacyBytes += getDocumentSize(row);
        const old = await ctx.db
          .query(table)
          .withIndex('by_generation_and_collection_and_key', q =>
            q.eq('generationId', generation._id).eq('collection', row.collection).eq('key', row.key),
          )
          .unique();
        if (old) {
          readBytes += getDocumentSize(old);
          continue;
        }
        const { _id, _creationTime, ...fields } = row;
        void _id;
        void _creationTime;
        await ctx.db.insert(table, fields);
        writtenBytes += getDocumentSize(fields);
        rows++;
      }
      isDone = page.isDone;
      nextCursor = isDone ? null : page.continueCursor;
    }
    // Native range/search cursors are table-bound. Publish a fresh public generation at
    // cutover so existing cursor bindings fail WORK_STALE before querying the new table.
    let publishedGenerationId: typeof generation._id | undefined;
    if (!input.cleanup && isDone) {
      const project = await ctx.db.get(generation.projectId);
      const selected = project?.work?.generationId ? await ctx.db.get(project.work.generationId) : null;
      if (selected && (selected.recordsGenerationId ?? selected._id) === generation._id) {
        const { _id, _creationTime, recordTablesProgress, ...fields } = selected;
        void _id;
        void _creationTime;
        void recordTablesProgress;
        publishedGenerationId = await ctx.db.insert('projectWorkGenerations', {
          ...fields,
          recordTables: 'split',
          recordsGenerationId: generation._id,
        });
        await ctx.db.patch(project!._id, {
          work: { ...project!.work!, generationId: publishedGenerationId },
        });
      }
    }
    const result = {
      isDone,
      nextCursor,
      readBytes,
      writtenBytes,
      deletedBytes,
      rows,
      ...(publishedGenerationId ? { publishedGenerationId } : {}),
    };
    await ctx.db.patch(generation._id, {
      ...(!input.cleanup && isDone ? { recordTables: 'split' as const } : {}),
      recordTablesProgress: JSON.stringify({ phase, result }),
    });
    await ctx.db.insert('projectReturnPages', {
      projectId: generation.projectId,
      partitionId: generation._id,
      key: receiptKey,
      position: 0,
      body: JSON.stringify({
        request: JSON.stringify(input),
        result,
        ...(!input.cleanup ? { legacyIds, legacyBytes } : {}),
      }),
    });
    return JSON.stringify(result);
  },
});

/** A bounded foreground driver batches mutation pages without CLI startup per page. Resume the
 * returned phase/cursor with the same operation id; each page identity derives from those pins. */
export const run = internalAction({
  args: {
    generationId: v.id('projectWorkGenerations'),
    operationId: v.string(),
    cursor: v.union(v.string(), v.null()),
    cleanup: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    let cursor = input.cursor,
      cleanup = !!input.cleanup;
    const totals = { pages: 0, readBytes: 0, writtenBytes: 0, deletedBytes: 0, rows: 0 };
    for (let i = 0; i < 100; i++) {
      const operationId = digest(JSON.stringify([input.operationId, cleanup, cursor]));
      const result = JSON.parse(
        await ctx.runMutation(internal.projectWorkRecordMigration.page, {
          generationId: input.generationId,
          operationId,
          cursor,
          ...(cleanup ? { cleanup: true } : {}),
        }),
      );
      totals.pages++;
      for (const key of ['readBytes', 'writtenBytes', 'deletedBytes', 'rows'] as const)
        totals[key] += result[key];
      cursor = result.nextCursor;
      if (result.isDone) {
        if (cleanup) return JSON.stringify({ ...totals, isDone: true, nextCursor: null, cleanup: true });
        cleanup = true;
        cursor = null;
      }
    }
    return JSON.stringify({ ...totals, isDone: false, nextCursor: cursor, cleanup });
  },
});
