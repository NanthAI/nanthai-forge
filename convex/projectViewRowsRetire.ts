// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v, getDocumentSize } from 'convex/values';
import { internalMutation, internalAction, internalQuery } from './server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { projectPurgeWriter } from './projectFinishReadWriter';
import { workRecordTables, type WorkRecordTable } from './projectWorkRecordTables';
import { projectExecution } from './projectExecution';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';

/** Item c0af6cfa F1 (decision 582cdfbf): delete the legacy View detail, Lane-View and file-provenance
 * rows. They are derived, nothing reads them, and the source archive can rebuild them. Explicit
 * bounded operator run: no scheduler, cron or idle call. Lives only in the pinned in-between release
 * (P8 runbook); delete this module once every deployment has run it.
 * `run {apply:false}` counts rows and document bytes without writing. `run {apply:true}` deletes at
 * most 100 rows or 500 KB per page (restarting at the head of the range, so equal keys cannot
 * overrun a page), writes a receipt per page so a lost reply replays its stored result, and ends with
 * a rescan that must find no range left. Every run stops once its document reads reach `budgetBytes`
 * (default 350 MB; the hard stop is 400 MB). The budget counts the target documents read; the surveys add
 * one probe row per range (a few MB at most). viewAcceptances is not touched: a reader still uses it.
 * These collections never follow a partition's layout marker, but a partition from before the table
 * split could hold them in any of the three record tables, so every range is probed in all three.
 * Prerequisites (docs/operations/legacy-view-rows.md): deploy the server before the CLI, run with no
 * index build in flight (the run refuses otherwise), and use a fresh operationId after a stop: the
 * same one replays its receipts and stops at the same place. A finished apply also forgets its
 * receipts. Remove by 2026-12-31, once every deployment has run it. */
export const retiredViewCollections = [
  'viewFiles',
  'viewFiles:payload',
  'viewDetails',
  'viewDetails:payload',
  'laneViews',
  'laneViews:payload',
] as const;
const PAGE = { numItems: 100, maximumRowsRead: 100, maximumBytesRead: 500_000 };
const DEFAULT_BUDGET = 350_000_000;
const HARD_STOP = 400_000_000;
const MAX_PAGES = 3000;
const MAX_MS = 8 * 60 * 1000;
const tableValue = v.union(
  v.literal('projectWorkRecords'),
  v.literal('projectPlanningRecords'),
  v.literal('projectWorkDataRecords'),
);
const rangeValue = v.object({
  generationId: v.id('projectWorkGenerations'),
  collection: v.string(),
  table: tableValue,
});
type Range = { generationId: Id<'projectWorkGenerations'>; collection: string; table: WorkRecordTable };
type Totals = { pages: number; rows: number; readBytes: number; deletedBytes: number };

const range = (
  ctx: Pick<QueryCtx, 'db'>,
  generationId: Id<'projectWorkGenerations'>,
  collection: string,
  table: WorkRecordTable,
) =>
  ctx.db
    .query(table)
    .withIndex('by_generation_and_collection_and_position', q =>
      q.eq('generationId', generationId).eq('collection', collection),
    );
const known = (collection: string) => (retiredViewCollections as readonly string[]).includes(collection);

/** One bounded page of Work generations: the ranges that still hold a row, found by a one-row probe
 * per range. Also the final rescan, which must come back empty on every page. */
export const survey = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    ranges: v.array(rangeValue),
    generations: v.array(v.id('projectWorkGenerations')),
    building: v.number(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, input) => {
    const page = await ctx.db
      .query('projectWorkGenerations')
      .paginate({ cursor: input.cursor, numItems: 25, maximumBytesRead: 1_000_000 });
    const ranges: Range[] = [];
    for (const generation of page.page)
      for (const collection of retiredViewCollections)
        for (const table of workRecordTables)
          if ((await range(ctx, generation._id, collection, table).take(1)).length)
            ranges.push({ generationId: generation._id, collection, table });
    return {
      ranges,
      generations: page.page.map(generation => generation._id),
      building: page.page.filter(generation => generation.status === 'building').length,
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

/** Dry run: one read-only page of a range, with its row count and document bytes. */
export const count = internalQuery({
  args: {
    generationId: v.id('projectWorkGenerations'),
    collection: v.string(),
    table: tableValue,
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    rows: v.number(),
    readBytes: v.number(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, input) => {
    invariant(known(input.collection), 'BAD_ARGUMENT', 'Select a retired View collection.');
    const page = await range(ctx, input.generationId, input.collection, input.table).paginate({
      cursor: input.cursor,
      ...PAGE,
    });
    return {
      rows: page.page.length,
      readBytes: page.page.reduce((sum, row) => sum + getDocumentSize(row), 0),
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const page = internalMutation({
  args: {
    generationId: v.id('projectWorkGenerations'),
    collection: v.string(),
    table: tableValue,
    operationId: v.string(),
  },
  returns: v.string(),
  handler: async (wrapped, input) => {
    invariant(known(input.collection), 'BAD_ARGUMENT', 'Select a retired View collection.');
    const ctx = projectPurgeWriter(wrapped);
    const generation = await ctx.db.get(input.generationId);
    invariant(generation, 'WORK_STALE', 'Select a retained Work generation.');
    projectExecution(ctx, generation.projectId);
    const receiptKey = `viewRowsRetire:${input.operationId}`;
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
        'Replay the original delete page.',
      );
      return JSON.stringify(previous.result);
    }
    // Deleted rows leave the range, so every page starts at its head.
    const part = await range(ctx, generation._id, input.collection, input.table).paginate({
      cursor: null,
      ...PAGE,
    });
    const result = { isDone: part.isDone, rows: part.page.length, readBytes: 0, deletedBytes: 0 };
    for (const row of part.page) {
      const size = getDocumentSize(row);
      result.readBytes += size;
      await ctx.db.delete(row._id);
      result.deletedBytes += size;
    }
    await ctx.db.insert('projectReturnPages', {
      projectId: generation.projectId,
      partitionId: generation._id,
      key: receiptKey,
      position: 0,
      body: JSON.stringify({ request: JSON.stringify(input), result }),
    });
    return JSON.stringify(result);
  },
});

/** Deletes this job's page receipts (key prefix `viewRowsRetire:`) once the rescan proved the rows gone. */
export const forget = internalMutation({
  args: { generationId: v.id('projectWorkGenerations') },
  returns: v.number(),
  handler: async (wrapped, input) => {
    const ctx = projectPurgeWriter(wrapped);
    const receipts = await ctx.db
      .query('projectReturnPages')
      .withIndex('by_partition_and_key_and_position', q =>
        q.eq('partitionId', input.generationId).gte('key', 'viewRowsRetire:').lt('key', 'viewRowsRetire;'),
      )
      .take(100);
    for (const receipt of receipts) await ctx.db.delete(receipt._id);
    return receipts.length;
  },
});

type Survey = {
  ranges: Range[];
  generations: Id<'projectWorkGenerations'>[];
  building: number;
  nextCursor: string | null;
};
export const run = internalAction({
  args: {
    operationId: v.string(),
    apply: v.boolean(),
    budgetBytes: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    const budget = Math.min(input.budgetBytes ?? DEFAULT_BUDGET, HARD_STOP - PAGE.maximumBytesRead),
      started = Date.now();
    const totals: Totals = { pages: 0, rows: 0, readBytes: 0, deletedBytes: 0 };
    const survey = async () => {
      const all: Survey = { ranges: [], generations: [], building: 0, nextCursor: null };
      for (let cursor: string | null = null; ;) {
        const part: Survey = await ctx.runQuery(internal.projectViewRowsRetire.survey, { cursor });
        all.ranges.push(...part.ranges);
        all.generations.push(...part.generations);
        all.building += part.building;
        if (!part.nextCursor) return all;
        cursor = part.nextCursor;
      }
    };
    const found = await survey();
    invariant(
      !input.apply || found.building === 0,
      'WORK_STALE',
      'Wait for index builds to finish: an old build can still write the retired rows.',
    );
    const ranges: (Range & { rows: number; bytes: number })[] = [];
    let stopped: string | null = null;
    const bounded = () =>
      totals.readBytes >= budget
        ? 'budget'
        : totals.pages >= MAX_PAGES
          ? 'pages'
          : Date.now() - started >= MAX_MS
            ? 'time'
            : null;
    for (const selected of found.ranges) {
      const entry = { ...selected, rows: 0, bytes: 0 };
      ranges.push(entry);
      let cursor: string | null = null;
      for (let n = 0; !(stopped = bounded()); n++) {
        if (input.apply) {
          const result = JSON.parse(
            await ctx.runMutation(internal.projectViewRowsRetire.page, {
              ...selected,
              operationId: digest(
                JSON.stringify([
                  input.operationId,
                  selected.generationId,
                  selected.table,
                  selected.collection,
                  n,
                ]),
              ),
            }),
          );
          totals.pages++;
          totals.rows += result.rows;
          totals.readBytes += result.readBytes;
          totals.deletedBytes += result.deletedBytes;
          entry.rows += result.rows;
          entry.bytes += result.readBytes;
          if (result.isDone) break;
        } else {
          const result: { rows: number; readBytes: number; nextCursor: string | null } = await ctx.runQuery(
            internal.projectViewRowsRetire.count,
            { ...selected, cursor },
          );
          totals.pages++;
          totals.rows += result.rows;
          totals.readBytes += result.readBytes;
          entry.rows += result.rows;
          entry.bytes += result.readBytes;
          if (!result.nextCursor) break;
          cursor = result.nextCursor;
        }
      }
      if (stopped) break;
    }
    // The rescan reads one row per range, never the ranges themselves.
    const proven = input.apply && !stopped;
    const remaining = proven ? (await survey()).ranges.length : null;
    let forgotten = 0;
    if (proven && remaining === 0)
      for (const generationId of found.generations)
        for (let n = 1; n; forgotten += n)
          n = await ctx.runMutation(internal.projectViewRowsRetire.forget, { generationId });
    return JSON.stringify({
      mode: input.apply ? 'apply' : 'dry-run',
      ...totals,
      budgetBytes: budget,
      stopped,
      ...(stopped ? { resume: 'run again with a fresh operationId' } : {}),
      rangesFound: found.ranges.length,
      buildingGenerations: found.building,
      remainingRanges: remaining,
      receiptsForgotten: forgotten,
      isDone: !stopped && (!input.apply || remaining === 0),
      ranges: ranges.map(({ generationId, table, collection, rows, bytes }) => ({
        generationId,
        table,
        collection,
        rows,
        bytes,
      })),
    });
  },
});
