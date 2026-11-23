// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v, getDocumentSize } from 'convex/values';
import { internalMutation, internalAction, internalQuery } from './server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { projectPurgeWriter } from './projectFinishReadWriter';
import { splitRecordTable } from './projectWorkRecordTables';
import {
  dataRoutedList,
  layoutMarker,
  layoutMarkerFields,
  noteLayout,
  partitionLayout,
  type RecordLayout,
} from './projectWorkRecordLayout';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';
import { projectExecution } from './projectExecution';

/** Item 411727ba row 3: move a partition's Item history and Work events (planningItems,
 * planningVersions, planningComments, events) from the 17-copy planning and 11-copy core tables to
 * the 8-copy data table. Explicit bounded operator run; no scheduler, cron or idle call.
 * Phases: copy (marker `copying`: reads stay on the legacy tables, the work writer mirrors every
 * write), cutover (marker `cleaning`: reads move, a fresh public generation makes open cursors fail
 * WORK_STALE once), cleanup (legacy copies deleted, marker `moved`). Every page writes a receipt, so
 * a lost reply replays its stored result instead of repeating work.
 * Budget (dev, Fable 2026-11-23: about 43K rows, 120 MB of documents): copy reads and writes about
 * 0.24 GB, cleanup reads and deletes about 0.24 GB: about 0.5 GB ($0.10); stop at 0.6 GB ($0.12).
 * See docs/operations/storage-inventory.md. */
const steps = dataRoutedList.map(collection => ({ table: splitRecordTable(collection), collection }));
const progressCollection = '_workStoreLayoutProgress';
type Selection = { step: number; cursor: string | null };
type Result = {
  isDone: boolean;
  nextCursor: string | null;
  readBytes: number;
  writtenBytes: number;
  deletedBytes: number;
  rows: number;
  publishedGenerationId?: Id<'projectWorkGenerations'>;
};
const done = (): Result => ({
  isDone: true,
  nextCursor: null,
  readBytes: 0,
  writtenBytes: 0,
  deletedBytes: 0,
  rows: 0,
});
const PAGE = { numItems: 100, maximumBytesRead: 512000 };

async function setLayout(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  partition: Id<'projectWorkGenerations'>,
  layout: RecordLayout,
) {
  const marker = await layoutMarker(ctx, partition);
  const fields = layoutMarkerFields(projectId, partition, layout);
  if (marker) await ctx.db.patch(marker._id, { value: fields.value });
  else await ctx.db.insert('projectWorkDataRecords', fields);
  noteLayout(ctx.db, partition, layout);
}
const progressRow = (ctx: MutationCtx, partition: Id<'projectWorkGenerations'>) =>
  ctx.db
    .query('projectWorkDataRecords')
    .withIndex('by_generation_and_collection_and_key', q =>
      q.eq('generationId', partition).eq('collection', progressCollection).eq('key', 'tables'),
    )
    .unique();

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
    const partition = generation._id;
    const layout = await partitionLayout(ctx, partition);
    invariant(
      !input.cleanup || layout === 'cleaning' || layout === 'moved',
      'WORK_STALE',
      'Finish copying before cleanup.',
    );
    if (layout === 'moved' || (!input.cleanup && layout === 'cleaning')) return JSON.stringify(done());
    const progress = await progressRow(ctx, partition);
    const prior = progress
      ? (JSON.parse(progress.value) as { phase: string; nextCursor: string | null })
      : null;
    invariant(
      input.cursor === (prior?.phase === phase ? prior.nextCursor : null),
      'WORK_STALE',
      'Resume the saved migration cursor.',
    );
    if (layout === 'legacy') await setLayout(ctx, generation.projectId, partition, 'copying');
    const selection: Selection = input.cursor ? JSON.parse(input.cursor) : { step: 0, cursor: null };
    const result = { ...done(), isDone: false };
    // Convex allows one paginate per transaction, so a page reads at most one collection range and
    // the next page starts the next collection.
    if (selection.step < steps.length) {
      const { table, collection } = steps[selection.step]!;
      // Cleanup deletes what it reads, so it always restarts at the head of the range.
      const part = await ctx.db
        .query(table)
        .withIndex('by_generation_and_collection_and_position', q =>
          q.eq('generationId', partition).eq('collection', collection),
        )
        .paginate({
          cursor: input.cleanup ? null : selection.cursor,
          numItems: PAGE.numItems,
          maximumRowsRead: PAGE.numItems,
          maximumBytesRead: PAGE.maximumBytesRead,
        });
      for (const row of part.page) {
        result.readBytes += getDocumentSize(row);
        result.rows++;
        if (input.cleanup) {
          await ctx.db.delete(row._id);
          result.deletedBytes += getDocumentSize(row);
          continue;
        }
        // The writer already mirrored rows written since the copy began.
        const copy = await ctx.db
          .query('projectWorkDataRecords')
          .withIndex('by_generation_and_collection_and_key', q =>
            q.eq('generationId', partition).eq('collection', collection).eq('key', row.key),
          )
          .unique();
        if (copy) continue;
        const { _id, _creationTime, ...fields } = row;
        void _id;
        void _creationTime;
        await ctx.db.insert('projectWorkDataRecords', fields);
        result.writtenBytes += getDocumentSize(fields);
      }
      if (part.isDone) {
        selection.step++;
        selection.cursor = null;
      } else selection.cursor = part.continueCursor;
    }
    result.isDone = selection.step === steps.length;
    result.nextCursor = result.isDone ? null : JSON.stringify(selection);
    if (result.isDone && !input.cleanup) {
      await setLayout(ctx, generation.projectId, partition, 'cleaning');
      // Native range cursors are table-bound. Publish a fresh public generation at cutover so
      // existing cursor bindings fail WORK_STALE before querying the new table.
      const project = await ctx.db.get(generation.projectId);
      const selected = project?.work?.generationId ? await ctx.db.get(project.work.generationId) : null;
      if (project?.work && selected && (selected.recordsGenerationId ?? selected._id) === partition) {
        const { _id, _creationTime, recordTablesProgress, planRowsPreparation, ...fields } = selected;
        void _id;
        void _creationTime;
        void recordTablesProgress;
        void planRowsPreparation;
        result.publishedGenerationId = await ctx.db.insert('projectWorkGenerations', {
          ...fields,
          recordsGenerationId: partition,
        });
        await ctx.db.patch(project._id, {
          work: { ...project.work, generationId: result.publishedGenerationId },
        });
      }
    }
    if (result.isDone && input.cleanup) await setLayout(ctx, generation.projectId, partition, 'moved');
    const value = JSON.stringify({ phase, nextCursor: result.nextCursor });
    if (result.isDone && input.cleanup) {
      if (progress) await ctx.db.delete(progress._id);
    } else if (progress) await ctx.db.patch(progress._id, { value });
    else
      await ctx.db.insert('projectWorkDataRecords', {
        projectId: generation.projectId,
        generationId: partition,
        collection: progressCollection,
        key: 'tables',
        parent: '',
        position: 0,
        value,
      });
    await ctx.db.insert('projectReturnPages', {
      projectId: generation.projectId,
      partitionId: partition,
      key: receiptKey,
      position: 0,
      body: JSON.stringify({ request: JSON.stringify(input), result }),
    });
    return JSON.stringify(result);
  },
});

/** Record partitions whose history has not moved yet, one bounded page of generations per call. */
export const pending = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    partitions: v.array(v.object({ generationId: v.id('projectWorkGenerations'), layout: v.string() })),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, input) => {
    const page = await ctx.db
      .query('projectWorkGenerations')
      .paginate({ cursor: input.cursor, numItems: 50, maximumBytesRead: 1_000_000 });
    const partitions = [];
    for (const generation of page.page) {
      if (generation.recordsGenerationId) continue;
      const layout = await partitionLayout(ctx, generation._id);
      if (layout !== 'moved') partitions.push({ generationId: generation._id, layout });
    }
    return { partitions, nextCursor: page.isDone ? null : page.continueCursor };
  },
});

/** A bounded foreground driver batches mutation pages without CLI startup per page. Resume the
 * returned phase/cursor with the same operation id; each page identity derives from those pins.
 * It stops early once `budgetBytes` (read + written + deleted) is spent. */
export const run = internalAction({
  args: {
    generationId: v.id('projectWorkGenerations'),
    operationId: v.string(),
    cursor: v.union(v.string(), v.null()),
    cleanup: v.optional(v.boolean()),
    budgetBytes: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    let cursor = input.cursor,
      cleanup = !!input.cleanup;
    const totals = { pages: 0, readBytes: 0, writtenBytes: 0, deletedBytes: 0, rows: 0 };
    const spent = () => totals.readBytes + totals.writtenBytes + totals.deletedBytes;
    for (let i = 0; i < 100 && spent() < (input.budgetBytes ?? Infinity); i++) {
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
