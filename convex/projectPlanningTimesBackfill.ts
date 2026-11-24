// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getDocumentSize, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { internalAction, internalMutation } from './server';
import { invariant } from '../src/errors';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { backfillPlanningTimes, planningHistoryBudget, recordSnapshot } from './projectPlanningHistory';
import { pinnedPlanningTimes } from './projectPlanningTimes';

const perHeadBytes = 384 * 1024;
const reserveBytes = 12 * 1024 * 1024;
const selection = { projectId: v.id('hostedProjects'), cursor: v.union(v.string(), v.null()) };
const resultFields = {
  nextCursor: selection.cursor,
  scanned: v.number(),
  filled: v.number(),
  blocked: v.array(v.string()),
  readBytes: v.number(),
  writtenBytes: v.number(),
};

/** One operator page, no idle work. Replaying a cursor skips all heads already pinned. */
export const page = internalMutation({
  args: selection,
  returns: v.object(resultFields),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    invariant(project?.workStore === 'records', 'PROJECT_UNAVAILABLE', 'Select a record-store Work project.');
    const generation = await selectedGeneration(ctx, project);
    invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'Prepare the hosted Work index first.');
    const partition = recordPartition(generation);
    // Item keys are unique within this project and kind. A keyset range cannot return an
    // incomplete SplitRequired page or advance past a head the iterator did not visit.
    const heads = ctx.db.query('projectHostedRecordHeads').withIndex('by_project_and_kind_and_key', q => {
      const scoped = q.eq('projectId', input.projectId).eq('kind', 'issue');
      return input.cursor === null ? scoped : scoped.gt('key', input.cursor);
    });
    const result = {
      nextCursor: null as string | null,
      scanned: 0,
      filled: 0,
      blocked: [] as string[],
      readBytes: 0,
      writtenBytes: 0,
    };
    const fillHead = async (head: Doc<'projectHostedRecordHeads'>) => {
      const charge = planningHistoryBudget(perHeadBytes, Infinity);
      let value = head.value;
      if (value === undefined) {
        const row = await ctx.db.get(head.recordId);
        if (row && !row.purged && charge.record(row)) {
          const item = await recordSnapshot(ctx, partition, row, charge);
          if (item) value = JSON.stringify(item);
        }
      }
      const planningTimes = value && (await backfillPlanningTimes(ctx, project, partition, value, charge));
      result.readBytes += charge.readBytes;
      if (!planningTimes || planningTimes.version !== head.version) {
        result.blocked.push(head.key);
        return;
      }
      await ctx.db.patch(head._id, { planningTimes });
      result.filled++;
      result.writtenBytes += getDocumentSize({ ...head, planningTimes });
    };
    let headBytes = 0;
    for await (const head of heads) {
      const size = getDocumentSize(head);
      headBytes += size;
      result.readBytes += size;
      result.scanned++;
      if (!pinnedPlanningTimes(head)) await fillHead(head);
      if (result.scanned === 5 || headBytes >= 512 * 1024) {
        result.nextCursor = head.key;
        break;
      }
    }
    const meter = await ctx.meta?.getTransactionMetrics?.();
    result.readBytes = Math.max(result.readBytes, meter?.bytesRead.used ?? 0);
    result.writtenBytes = Math.max(result.writtenBytes, meter?.bytesWritten.used ?? 0);
    return result;
  },
});

/** Foreground batches reserve a whole page before starting it. Operator stops against billed
 * completion logs, including index I/O, not only the returned transaction meter. */
export const run = internalAction({
  args: { ...selection, budgetBytes: v.number(), pages: v.number() },
  returns: v.object({ ...resultFields, pages: v.number() }),
  handler: async (ctx, input) => {
    invariant(
      Number.isSafeInteger(input.pages) &&
        input.pages >= 1 &&
        input.pages <= 24 &&
        Number.isSafeInteger(input.budgetBytes) &&
        input.budgetBytes >= reserveBytes &&
        input.budgetBytes <= 40_000_000,
      'BAD_ARGUMENT',
      'Request 1–24 pages and reserve 12 MiB to 40 MB of remaining I/O for this batch.',
    );
    const result = {
      nextCursor: input.cursor,
      scanned: 0,
      filled: 0,
      blocked: [] as string[],
      readBytes: 0,
      writtenBytes: 0,
      pages: 0,
    };
    while (
      result.pages < input.pages &&
      result.readBytes + result.writtenBytes + reserveBytes <= input.budgetBytes
    ) {
      const pageResult = await ctx.runMutation(internal.projectPlanningTimesBackfill.page, {
        projectId: input.projectId,
        cursor: result.nextCursor,
      });
      result.pages++;
      result.nextCursor = pageResult.nextCursor;
      for (const field of ['scanned', 'filled', 'readBytes', 'writtenBytes'] as const)
        result[field] += pageResult[field];
      result.blocked.push(...pageResult.blocked);
      if (result.nextCursor === null || result.blocked.length) break;
    }
    return result;
  },
});
