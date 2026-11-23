// SPDX-License-Identifier: Apache-2.0
// The Convex half of one archived comment's purge (Item b6588425 line 2c; the action is
// convex/projectCommentPurgeArchive.ts): where the purge stands, its last step (the segment rewrite published and its
// old objects deleted, the live copies settled, the purge entry and audit row marked done), and a failure's record.
// Its first step is projectCommentPurge:purge with the command the action read from the segment. Each is a fixed
// point, so the action can run again after any failure.
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { internalMutation, internalQuery } from './server';
import { invariant } from '../src/errors';
import { commentRoute, commentRow, settleComment } from './projectCommentPurge';
import { readArchiveCoverage } from './projectPlanningArchiveCoverage';
import { journalIndexAt } from './projectJournalStore';

const identity = { projectId: v.id('hostedProjects'), commentId: v.string(), operationId: v.string() };
type ItemPurge = NonNullable<Doc<'hostedProjects'>['itemPurges']>[number];

/** The segment sweep is over: it published the rewrite and deleted the old objects (none pending). */
const sweepLeft = (entry: ItemPurge) =>
  !!entry.segmentSweep && !(entry.segmentSweep.done && !entry.segmentSweep.pending);
/** The base scrub (convex/projectCommentPurgeBase.ts) is not over. */
const scrubLeft = (entry: ItemPurge) => !!entry.baseScrub && !entry.baseScrub.done;
const swept = (entry: ItemPurge | undefined) =>
  !!entry && (entry.purgedAt !== undefined || (!sweepLeft(entry) && !scrubLeft(entry)));

/** Where this purge stands: `new` (the archived row is whole; with the exact events segment that holds it), `begun`
 * (live copies purged, the segment rewrite or its old objects' deletion left), `swept` (both done), plus whether the
 * sweep pages the archive index. */
export const target = internalQuery({
  args: identity,
  returns: v.object({
    state: v.union(v.literal('new'), v.literal('begun'), v.literal('swept')),
    indexed: v.boolean(),
    segment: v.optional(v.any()),
    /** The segment sweep is still to run. */
    sweep: v.boolean(),
    /** The base scrub is still to run (convex/projectCommentPurgeBase.ts). */
    base: v.boolean(),
  }),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'Select an existing Forge project.');
    const row = await commentRow(ctx, input.projectId, input.commentId);
    invariant(
      row?.purged === undefined || row.purged === input.operationId,
      'BAD_ARGUMENT',
      'An earlier purge already removed this comment.',
    );
    const entry = project.itemPurges?.find(
      purge => purge.operationId === input.operationId && purge.commentId === input.commentId,
    );
    const indexed = (await readArchiveCoverage(ctx, project)).state.ready === true;
    if (entry)
      return {
        state:
          entry.purgedAt !== undefined ||
          ((row?.purged === input.operationId || entry.baseScrub) && swept(entry))
            ? ('swept' as const)
            : ('begun' as const),
        indexed,
        sweep: sweepLeft(entry),
        base: scrubLeft(entry),
      };
    const base = (await commentRoute(ctx, input.projectId, input.commentId)) === 'base';
    // A base comment with no archived row of its own: only the base scrub runs after the first step.
    if (base && !(row && 'journalSegment' in row && row.journalSegment))
      return { state: 'new' as const, indexed, sweep: false, base: true };
    invariant(row, 'NOT_FOUND', 'No comment with that id on that Item.');
    invariant(row.revision !== undefined, 'INVALID_WORK_JOURNAL', 'The comment’s Work row has no revision.');
    const segment = await journalIndexAt(ctx, input.projectId, 'events', row.revision);
    invariant(
      segment,
      'NOT_FOUND',
      'No journal segment holds the comment’s archived row. Nothing was purged.',
    );
    return { state: 'new' as const, indexed, segment, sweep: true, base };
  },
});

/** The review's audit row for this comment's purge, or null. */
async function auditRow(
  ctx: MutationCtx,
  auditId: Id<'boardAudit'> | undefined,
  projectId: string,
  commentId: string,
) {
  const audit = auditId && (await ctx.db.get(auditId));
  if (!audit) return null;
  invariant(
    audit.action === 'purge' && audit.target === `comment:${projectId}:${commentId}`,
    'BAD_ARGUMENT',
    'That audit row is not this comment’s purge.',
  );
  return { audit, detail: JSON.parse(audit.detail ?? '{}') as Record<string, unknown> };
}

/** The last step, once the sweep is over: the live copies settled (projectCommentPurge settleComment), the entry
 * finished (no sweep state kept) and the review's audit row done. Refuses while the sweep is not over. */
export const finish = internalMutation({
  args: { ...identity, auditId: v.optional(v.id('boardAudit')), none: v.optional(v.literal(true)) },
  returns: v.null(),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    invariant(project, 'PROJECT_UNAVAILABLE', 'Select an existing Forge project.');
    const row = await commentRow(ctx, input.projectId, input.commentId);
    const entries = project.itemPurges ?? [];
    const entry = entries.find(
      item => item.operationId === input.operationId && item.commentId === input.commentId,
    );
    // An earlier purge had already removed the comment (the first step returned 0): only the audit row is left.
    if (input.none && !entry) {
      const audit = await auditRow(ctx, input.auditId, input.projectId, input.commentId);
      if (audit && audit.detail.done !== true)
        await ctx.db.patch(audit.audit._id, {
          detail: JSON.stringify({ ...audit.detail, deleted: 0, done: true }),
        });
      return null;
    }
    invariant(
      entry &&
        (entry.purgedAt !== undefined ||
          ((row?.purged === input.operationId || entry.baseScrub) && swept(entry))),
      'WORK_STALE',
      'The comment’s journal segment is not rewritten, or its old objects are not deleted yet. Run the purge again.',
    );
    if (entry.purgedAt === undefined) {
      const { projectId, commentId, operationId } = input;
      await settleComment(ctx, { projectId, itemId: entry.itemId, commentId, operationId });
      const current = (await ctx.db.get(projectId))!;
      await ctx.db.patch(projectId, {
        itemPurges: (current.itemPurges ?? []).map(item => {
          if (item.operationId !== operationId || item.commentId !== commentId) return item;
          const finished = { ...item, purgedAt: Date.now() };
          delete finished.segmentSweep;
          delete finished.baseScrub;
          return finished;
        }),
      });
    }
    const audit = await auditRow(ctx, input.auditId, input.projectId, input.commentId);
    if (audit && audit.detail.done !== true) {
      const { failed, ...detail } = audit.detail;
      void failed;
      await ctx.db.patch(audit.audit._id, { detail: JSON.stringify({ ...detail, deleted: 1, done: true }) });
    }
    return null;
  },
});

/** A failed run's record on the audit row (`failed`: the error code). `reopen` (the purge wrote nothing: its first
 * step refused) also returns the report to the open queue and drops that review's receipt, so the operator sees it
 * again and a retry of the same review runs it anew. */
export const fail = internalMutation({
  args: { ...identity, auditId: v.optional(v.id('boardAudit')), code: v.string(), reopen: v.boolean() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const audit = await auditRow(ctx, input.auditId, input.projectId, input.commentId);
    if (!audit || audit.detail.done === true) return null;
    await ctx.db.patch(audit.audit._id, { detail: JSON.stringify({ ...audit.detail, failed: input.code }) });
    const reportId = audit.detail.reportId as Id<'abuseReports'> | undefined;
    const report = input.reopen && reportId ? await ctx.db.get(reportId) : null;
    if (report && report.status === 'purged') {
      const review = audit.detail.operationId;
      await ctx.db.patch(report._id, {
        status: 'open',
        reviews: (report.reviews ?? []).filter(item => item.operationId !== review),
        ...(report.reviewOperationId === review ? { reviewOperationId: undefined, removed: undefined } : {}),
      });
    }
    return null;
  },
});
