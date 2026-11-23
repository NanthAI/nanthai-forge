// SPDX-License-Identifier: Apache-2.0
'use node';
// One comment's purge when its Work row is in the journal archive (Item b6588425 line 2c). Comment rows no longer
// enter journal segments, but rows archived before that keep their command in an R2 segment. The abuse review
// schedules this action: it reads the comment's command from the one events segment that holds its revision, runs
// purgeComment with it (the live copies, as for a live row, checked against the row's request hash), rewrites that
// segment through the Item purge's segment sweep (convex/projectPlanningPurgeSegmentRun.ts, narrowed to this
// comment; it deletes the old objects before it is over), then settles the live copies again and marks the purge
// and its audit row done (convex/projectCommentPurgeArchiveStore.ts). Every step is a fixed point: a stopped run
// resumes by running again with the same input, and a run past its deadline schedules the next one. A refusal
// before anything was written reopens the report; any other failure retries with backoff, a few times, then is kept
// on the audit row, and a retry of the same review starts the action again. Cost: one segment read to find the
// command, the sweep (the Item's archived segments, by the archive index once its coverage is complete, else every
// segment page, resumable), one segment rewrite and R2 put, the old object's delete, and two small mutations;
// nothing while idle, no cron.
import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import type { JournalIndex } from '../src/journal-segment';
import { getJournalSegment } from './projectJournalObject';
import { networkTimeout } from './networkFetch';

/** One run's time, under the action limit; a longer purge schedules the next run. */
const RUN_MS = 8 * 60_000;
/** Failed runs retried (backoff from a minute, doubling) before the failure is kept on the audit row. */
const ATTEMPTS = 6;
/** Refusals of the first step: nothing was written, and running again gives the same answer. */
const REFUSALS = new Set(['BAD_ARGUMENT', 'NOT_FOUND', 'INVALID_WORK_JOURNAL', 'PROJECT_UNAVAILABLE']);
const args = {
  projectId: v.id('hostedProjects'),
  itemId: v.string(),
  commentId: v.string(),
  operationId: v.string(),
  /** The abuse review's audit row, marked done at the end. */
  auditId: v.optional(v.id('boardAudit')),
  /** Failed runs so far. */
  attempt: v.optional(v.number()),
};
type Input = {
  projectId: Id<'hostedProjects'>;
  itemId: string;
  commentId: string;
  operationId: string;
  auditId?: Id<'boardAudit'>;
  attempt?: number;
};
type Outcome = 'done' | 'continues' | 'failed';

export const run = internalAction({
  args,
  returns: v.union(v.literal('done'), v.literal('continues'), v.literal('failed')),
  handler: async (ctx, input): Promise<Outcome> => {
    const identity = {
      projectId: input.projectId,
      commentId: input.commentId,
      operationId: input.operationId,
    };
    let begun = false;
    try {
      const deadline = Date.now() + RUN_MS;
      const signal = networkTimeout(RUN_MS);
      const target = await ctx.runQuery(internal.projectCommentPurgeArchiveStore.target, identity);
      begun = target.state !== 'new';
      if (target.state === 'new') {
        const archived = await archivedCommand(input, target.segment as JournalIndex, signal);
        await ctx.runMutation(internal.projectCommentPurge.purge, {
          ...identity,
          itemId: input.itemId,
          archived,
        });
        begun = true;
      }
      if (target.state !== 'swept') {
        const swept: boolean = await ctx.runAction(internal.projectPlanningPurgeSegmentRun.run, {
          projectId: input.projectId,
          operationId: input.operationId,
          deadline,
        });
        if (!swept) return again(ctx, input, 0, input.attempt ?? 0);
      }
      await ctx.runMutation(internal.projectCommentPurgeArchiveStore.finish, {
        ...identity,
        ...(input.auditId ? { auditId: input.auditId } : {}),
      });
      return 'done';
    } catch (error) {
      // A Convex error across runMutation carries its code in `data`; a ForgeError thrown in this action, on itself.
      const { data, code: own } = error as { data?: { code?: unknown }; code?: unknown };
      const code = String((data && typeof data === 'object' ? data.code : undefined) ?? own ?? 'ERROR');
      const attempt = (input.attempt ?? 0) + 1;
      const refused = !begun && REFUSALS.has(code);
      if (!refused && attempt < ATTEMPTS) return again(ctx, input, 60_000 * 2 ** (attempt - 1), attempt);
      await ctx.runMutation(internal.projectCommentPurgeArchiveStore.fail, {
        ...identity,
        ...(input.auditId ? { auditId: input.auditId } : {}),
        code,
        reopen: refused,
      });
      return 'failed';
    }
  },
});

async function again(ctx: ActionCtx, input: Input, delay: number, attempt: number) {
  await ctx.scheduler.runAfter(delay, internal.projectCommentPurgeArchive.run, { ...input, attempt });
  return 'continues' as const;
}

/** The comment's whole command from the events segment that holds its revision. */
async function archivedCommand(input: Input, index: JournalIndex, signal: AbortSignal) {
  const segment = await getJournalSegment(input.projectId, index, signal);
  for (const text of segment.tables.projectHostedRecordBodies ?? []) {
    const row = JSON.parse(text) as { operationId?: string; command?: string };
    if (row.operationId === input.commentId && row.command) return row.command;
  }
  invariant(
    false,
    'NOT_FOUND',
    'The journal segment for this revision does not hold the comment. Nothing was purged.',
  );
}
