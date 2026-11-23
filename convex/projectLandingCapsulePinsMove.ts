// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v, getDocumentSize } from 'convex/values';
import { internalAction, internalMutation } from './server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { LandingCapsulePointer } from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';
import { capsuleKind, splitCapsulePins } from './projectLandingCapsulePins';

/** One-off move of existing capsule pointers to the slim layout (Item 411727ba, row 5). Operator
 * run only: no scheduler, cron or idle call. Each page is one transaction and is idempotent (a
 * moved pointer is skipped), so replaying a cursor after an unknown outcome reconciles.
 * Budget: about 1,000 pointers x 8.7 KB read, 6 KB body + 3 KB pointer written: about 0.02 GB;
 * stop at 0.05 GB ($0.01). See docs/operations/storage-inventory.md. */
export const page = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    isDone: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
    rows: v.number(),
    moved: v.number(),
    readBytes: v.number(),
    writtenBytes: v.number(),
  }),
  handler: async (ctx, input) => {
    const page = await ctx.db
      .query('projectFinishReadRows')
      .withIndex('by_kind_and_source', q => q.eq('kind', capsuleKind))
      .paginate({ cursor: input.cursor, numItems: 32, maximumRowsRead: 32, maximumBytesRead: 512 * 1024 });
    let moved = 0,
      readBytes = 0,
      writtenBytes = 0;
    for (const row of page.page) {
      readBytes += getDocumentSize(row);
      const pointer = JSON.parse(row.value) as LandingCapsulePointer;
      if (!pointer.summary || !row.projectId || !row.submissionId) continue;
      const identity = { projectId: row.projectId as Id<'hostedProjects'>, submissionId: row.submissionId };
      const slim = await splitCapsulePins(ctx.db, identity, JSON.parse(pointer.summary));
      if (slim === pointer.summary) continue;
      const value = canonicalPayload({ ...pointer, summary: slim });
      await ctx.db.patch(row._id, { value });
      moved++;
      writtenBytes += getDocumentSize({ ...row, value }) + pointer.summary.length - slim.length;
    }
    return {
      isDone: page.isDone,
      nextCursor: page.isDone ? null : page.continueCursor,
      rows: page.page.length,
      moved,
      readBytes,
      writtenBytes,
    };
  },
});

/** Foreground driver: at most `pages` pages per call, stopping early at `budgetBytes` read+written. */
export const run = internalAction({
  args: { cursor: v.union(v.string(), v.null()), pages: v.number(), budgetBytes: v.number() },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    let cursor = input.cursor;
    const totals = { pages: 0, rows: 0, moved: 0, readBytes: 0, writtenBytes: 0 };
    for (let i = 0; i < Math.min(input.pages, 200); i++) {
      const result = await ctx.runMutation(internal.projectLandingCapsulePinsMove.page, { cursor });
      totals.pages++;
      for (const key of ['rows', 'moved', 'readBytes', 'writtenBytes'] as const) totals[key] += result[key];
      cursor = result.nextCursor;
      if (result.isDone) return JSON.stringify({ ...totals, isDone: true, nextCursor: null });
      if (totals.readBytes + totals.writtenBytes >= input.budgetBytes) break;
    }
    return JSON.stringify({ ...totals, isDone: false, nextCursor: cursor });
  },
});
