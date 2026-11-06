// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { recordCaller } from './projectHostedFrictionStore';
import { invariant } from '../src/errors';
import { report } from './errors';
import {
  OVERLAP_ANSWER_CLEANUP_BATCH,
  OVERLAP_ANSWER_RETENTION_MS,
  OVERLAP_ANSWER_TEXT_CHARS,
  OVERLAP_ANSWERS_DEFAULT_LIMIT,
  OVERLAP_ANSWERS_MAX_LIMIT,
  OVERLAP_ANSWERS_OUTPUT_BYTES,
  OVERLAP_ANSWERS_READ_BYTES,
} from '../src/hosted-overlap';

/** Delete answers (and their batch records) older than the retention value: at most one batch of each
 * per call, oldest first, through the creation-time index. Runs only inside an answer write that already
 * stored a new answer, so an idle project does nothing. Expired rows left over are taken by later writes;
 * the read below never returns them either way. */
export async function pruneExpiredOverlapAnswers(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  now: number,
) {
  const cutoff = now - OVERLAP_ANSWER_RETENTION_MS;
  const acks = await ctx.db
    .query('projectHostedOverlapAcks')
    .withIndex('by_project', q => q.eq('projectId', projectId).lt('_creationTime', cutoff))
    .order('asc')
    .take(OVERLAP_ANSWER_CLEANUP_BATCH);
  for (const row of acks) await ctx.db.delete(row._id);
  const batches = await ctx.db
    .query('projectHostedAckBatches')
    .withIndex('by_project', q => q.eq('projectId', projectId).lt('_creationTime', cutoff))
    .order('asc')
    .take(OVERLAP_ANSWER_CLEANUP_BATCH);
  for (const row of batches) await ctx.db.delete(row._id);
  return acks.length + batches.length;
}

/** Bounded read of stored overlap answers by Lane and/or by creation-time window [from,to), oldest first.
 * One query per page from the creation-time indexes, no writes. A page ends at `limit` rows, 56 KB of reply or
 * 800 KB read; `nextCursor` is the creation time of the next row. Rows older than the retention value are
 * never returned, so the 90 days hold even before cleanup has reached them. */
export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    laneId: v.optional(v.string()),
    from: v.optional(v.string()),
    to: v.optional(v.string()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await recordCaller(ctx, input.projectId);
      invariant(
        input.laneId !== undefined || (input.from !== undefined && input.to !== undefined),
        'BAD_ARGUMENT',
        'Send laneId or a window with from and to.',
      );
      const now = Date.now(),
        floor = now - OVERLAP_ANSWER_RETENTION_MS;
      const from = input.from === undefined ? 0 : Date.parse(input.from),
        to = input.to === undefined ? now + 1 : Date.parse(input.to);
      invariant(
        Number.isFinite(from) && Number.isFinite(to) && from < to,
        'BAD_ARGUMENT',
        'Use a finite window [from,to).',
      );
      const start = Math.max(from, floor);
      const resume = input.cursor ? Number(input.cursor) : start;
      invariant(
        Number.isFinite(resume) && resume >= start && resume < to,
        'BAD_ARGUMENT',
        'The cursor does not belong to this window.',
      );
      const limit = Math.max(
        1,
        Math.min(OVERLAP_ANSWERS_MAX_LIMIT, Math.floor(input.limit ?? OVERLAP_ANSWERS_DEFAULT_LIMIT)),
      );
      const { laneId } = input;
      const rows = await (
        laneId === undefined
          ? ctx.db
              .query('projectHostedOverlapAcks')
              .withIndex('by_project', q =>
                q.eq('projectId', input.projectId).gte('_creationTime', resume).lt('_creationTime', to),
              )
          : ctx.db
              .query('projectHostedOverlapAcks')
              .withIndex('by_project_and_lane', q =>
                q
                  .eq('projectId', input.projectId)
                  .eq('laneId', laneId)
                  .gte('_creationTime', resume)
                  .lt('_creationTime', to),
              )
      )
        .order('asc')
        .take(limit + 1);
      const answers: unknown[] = [];
      let read = 0,
        output = 0,
        next: number | null = null;
      for (const [index, row] of rows.entries()) {
        if (
          index >= limit ||
          (answers.length && (read >= OVERLAP_ANSWERS_READ_BYTES || output >= OVERLAP_ANSWERS_OUTPUT_BYTES))
        ) {
          next = row._creationTime;
          break;
        }
        read += row.value.length;
        const answer = JSON.parse(row.value) as { text?: string };
        const cut = typeof answer.text === 'string' && answer.text.length > OVERLAP_ANSWER_TEXT_CHARS;
        const shown = {
          ...answer,
          ...(cut ? { text: answer.text!.slice(0, OVERLAP_ANSWER_TEXT_CHARS), textTruncated: true } : {}),
          storedAt: new Date(row._creationTime).toISOString(),
        };
        output += JSON.stringify(shown).length;
        answers.push(shown);
      }
      return JSON.stringify({
        schema: 1,
        window: {
          from: new Date(start).toISOString(),
          to: input.to === undefined ? null : new Date(to).toISOString(),
          laneId: laneId ?? null,
        },
        retentionDays: OVERLAP_ANSWER_RETENTION_MS / 86_400_000,
        answers,
        nextCursor: next === null ? null : String(next),
        bytesRead: read,
      });
    } catch (error) {
      return report(error);
    }
  },
});
