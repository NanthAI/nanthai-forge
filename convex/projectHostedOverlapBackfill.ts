// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One-off (Item 411727ba, line (b) step 2): moves the saved change list of every overlap Lane row that still holds it
// inline into projectHostedOverlapChanges buckets and leaves the row slim, exactly what the Lane record write now does
// on its next write. Run it once per deployment after the bucket readers are deployed:
//   npx convex run projectHostedOverlapBackfill:run '{"budgetBytes":50000000}'
// Idempotent: a slim row is read and skipped, a converted row is never rewritten, a record write that races a page
// conflicts and retries as a normal mutation. Self-continuing; it schedules the next page only while a whole further page
// fits `budgetBytes` of row bytes read (a page reads at most PAGE_BYTES, so a run never exceeds its budget by more than
// that), and logs one `projectHostedOverlapBackfill` line when it ends: `done` with the totals, or `stopped` with the
// cursor to continue from (`npx convex logs`, no database read). A run that ends `done` with `converted` 0 in a repeat run
// proves no inline row is left.
import { getDocumentSize, v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation } from './server';
import { presencePaths } from '../src/hosted-presence';
import { hasSymbolFacts, writeOverlapBuckets } from './projectHostedOverlapChanges';

const PAGE_ROWS = 25;
const PAGE_BYTES = 2_000_000;

const cursor = v.union(v.string(), v.null());

export const run = internalMutation({
  args: {
    cursor: v.optional(cursor),
    /** Totals of the earlier pages of this run (carried by the continuation). */
    readBytes: v.optional(v.number()),
    scanned: v.optional(v.number()),
    converted: v.optional(v.number()),
    /** Stop continuing once this many row bytes were read (the stated I/O budget of the run). */
    budgetBytes: v.number(),
  },
  returns: v.object({
    scanned: v.number(),
    converted: v.number(),
    readBytes: v.number(),
    writeBytes: v.number(),
    next: v.union(v.object({ cursor: v.string(), readBytes: v.number() }), v.null()),
  }),
  handler: async (ctx, input) => {
    const page = await ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_project_and_lane', q => q)
      .paginate({
        cursor: input.cursor ?? null,
        numItems: PAGE_ROWS,
        maximumRowsRead: PAGE_ROWS,
        maximumBytesRead: PAGE_BYTES,
      });
    let converted = 0;
    let read = 0;
    let written = 0;
    for (const row of page.page) {
      read += getDocumentSize(row);
      const list = row.changes;
      if (list === undefined) continue;
      await writeOverlapBuckets(ctx, row.projectId, row.laneId, list);
      await ctx.db.patch(row._id, {
        changes: undefined,
        pathSummary: presencePaths(list),
        ...(hasSymbolFacts(list) ? { symbolFacts: true as const } : {}),
      });
      written += new TextEncoder().encode(list).byteLength;
      converted++;
    }
    const totals = {
      readBytes: (input.readBytes ?? 0) + read,
      scanned: (input.scanned ?? 0) + page.page.length,
      converted: (input.converted ?? 0) + converted,
    };
    const next = page.isDone ? null : { cursor: page.continueCursor, ...totals };
    if (next && totals.readBytes + PAGE_BYTES <= input.budgetBytes)
      await ctx.scheduler.runAfter(0, internal.projectHostedOverlapBackfill.run, {
        ...next,
        budgetBytes: input.budgetBytes,
      });
    else
      console.log(
        'projectHostedOverlapBackfill',
        JSON.stringify({ state: next ? 'stopped' : 'done', next, ...totals }),
      );
    return {
      scanned: page.page.length,
      converted,
      readBytes: totals.readBytes,
      writeBytes: written,
      next: next && { cursor: next.cursor, readBytes: next.readBytes },
    };
  },
});
