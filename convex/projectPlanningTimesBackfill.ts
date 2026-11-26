// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getDocumentSize, v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalMutation } from './server';
import { invariant } from '../src/errors';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { pinnedPlanningTimes } from './projectPlanningTimes';
import {
  openPlanningHeadCursor,
  provePlanningTimes,
  sealPlanningHeadCursor,
} from './projectPlanningTimesProof';

const reserveBytes = 12 * 1024 * 1024;
const selection = {
  projectId: v.id('hostedProjects'),
  cursor: v.union(v.string(), v.null()),
  headCursor: v.optional(v.string()),
};
const resultFields = {
  nextCursor: selection.cursor,
  headCursor: selection.headCursor,
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
    invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'Select an existing Forge project.');
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
      headCursor: input.headCursor,
      scanned: 0,
      filled: 0,
      blocked: [] as string[],
      readBytes: 0,
      writtenBytes: 0,
    };
    let last = input.cursor;
    const checkpoint = input.headCursor
      ? await openPlanningHeadCursor(project._id, input.headCursor)
      : undefined;
    for await (const head of heads) {
      result.readBytes += getDocumentSize(head);
      const resume = checkpoint?.key === head.key ? checkpoint : undefined;
      if (resume) result.headCursor = undefined;
      if (!pinnedPlanningTimes(head)) {
        const proof = await provePlanningTimes(ctx, partition, head, resume);
        result.readBytes += proof.readBytes;
        if ('resume' in proof || 'blocked' in proof) {
          result.nextCursor = last;
          if ('resume' in proof) result.headCursor = await sealPlanningHeadCursor(project._id, proof.resume);
          else result.blocked.push(head.key);
          break;
        }
        const planningTimes = proof.times;
        await ctx.db.patch(head._id, { planningTimes });
        result.filled++;
        result.writtenBytes += getDocumentSize({ ...head, planningTimes });
      }
      last = head.key;
      result.scanned++;
      if (result.scanned === 5 || result.readBytes >= 512 * 1024) {
        result.nextCursor = last;
        break;
      }
    }
    // If the range ran out, an unmatched checkpoint no longer refers to a live head.
    if (result.nextCursor === null && result.headCursor === input.headCursor) result.headCursor = undefined;
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
      headCursor: input.headCursor,
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
        ...(result.headCursor === undefined ? {} : { headCursor: result.headCursor }),
      });
      result.pages++;
      result.nextCursor = pageResult.nextCursor;
      result.headCursor = pageResult.headCursor;
      for (const field of ['scanned', 'filled', 'readBytes', 'writtenBytes'] as const)
        result[field] += pageResult[field];
      result.blocked.push(...pageResult.blocked);
      if ((result.nextCursor === null && !result.headCursor) || result.blocked.length) break;
    }
    return result;
  },
});
