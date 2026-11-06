// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { report } from './errors';
import { landingRow } from './projectHostedLandingStore';
import { finishRow } from './projectHostedFinishWake';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import type { HostedLandingAttempt, HostedLandingState } from '../src/hosted-landing';
import { invariant } from '../src/errors';
import {
  LANDINGS_ATTEMPTS,
  LANDINGS_DEFAULT_LIMIT,
  LANDINGS_MAX_LIMIT,
  LANDINGS_OUTPUT_BYTES,
  LANDINGS_READ_BYTES,
  LANDINGS_RUN_IDS,
} from '../src/hosted-landings-view';

const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());
/** One landing's evidence from rows already stored. Four indexed reads beyond the receipt itself. */
async function evidence(ctx: QueryCtx, projectId: Id<'hostedProjects'>, receipt: HostedAcceptance) {
  let bytes = 0;
  const request = await landingRow(ctx, { projectId, submissionId: receipt.submissionId });
  const state = request ? (JSON.parse(request.value) as HostedLandingState) : null;
  bytes += request?.value.length ?? 0;
  const chain = await ctx.db
    .query('projectHostedLandingAttempts')
    .withIndex('by_project_and_submission_and_number', q =>
      q.eq('projectId', projectId).eq('submissionId', receipt.submissionId),
    )
    .order('asc')
    .take(LANDINGS_ATTEMPTS);
  const attempts = chain.map(row => {
    bytes += row.value.length;
    return JSON.parse(row.value) as HostedLandingAttempt;
  });
  // A longer chain than we read: take the true last number from one more indexed read.
  const last =
    chain.length === LANDINGS_ATTEMPTS
      ? await ctx.db
          .query('projectHostedLandingAttempts')
          .withIndex('by_project_and_submission_and_number', q =>
            q.eq('projectId', projectId).eq('submissionId', receipt.submissionId),
          )
          .order('desc')
          .first()
      : (chain.at(-1) ?? null);
  const finish = await finishRow(ctx, { projectId, submissionId: receipt.submissionId });
  bytes += finish?.value.length ?? 0;
  const intentId = finish
    ? ((JSON.parse(finish.value) as { source?: { intentId?: string } }).source?.intentId ?? null)
    : null;
  const lanes = intentId
    ? await ctx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project_and_kind_and_parent', q =>
          q.eq('projectId', projectId).eq('kind', 'lane').eq('parent', intentId),
        )
        .take(2)
    : [];
  // The admission Lane check first, then each attempt's check, then the accepting run; distinct, capped.
  const runIds = [
    ...new Set(
      [request?.admission?.runId, ...attempts.map(a => a.check?.runId), receipt.check?.runId].filter(
        (id): id is string => !!id,
      ),
    ),
  ];
  const admissionBase = attempts[0]?.main ?? null;
  const landedBase = receipt.previous;
  return {
    bytes,
    row: {
      receiptId: receipt.id,
      submissionId: receipt.submissionId,
      laneId: lanes[0]?.key ?? null,
      ...(lanes.length > 1 ? { moreLanes: true } : {}),
      intentId,
      kind: request?.revertOf ? 'compensating' : 'landing',
      batchId: receipt.batchId ?? null,
      submittedAt: state?.timing?.submittedAt ?? state?.at ?? null,
      // End of the pre-queue Lane check that admitted the change; null when it queued unadmitted.
      admittedAt: iso(request?.admission?.status === 'passed' ? request.admission.endedAt : undefined),
      committedAt: state?.timing?.committedAt ?? receipt.at,
      admissionBase,
      landedBase,
      mainMoved: admissionBase ? admissionBase.receiptId !== landedBase.receiptId : null,
      firstCheck: receipt.firstCheck ?? null,
      landedHead: receipt.candidate.head,
      checkRunIds: runIds.slice(0, LANDINGS_RUN_IDS),
      ...(runIds.length > LANDINGS_RUN_IDS ? { moreCheckRunIds: runIds.length - LANDINGS_RUN_IDS } : {}),
      ...(chain.length === LANDINGS_ATTEMPTS ? { checkRunIdsPartial: true } : {}),
      recomposeCount: last ? Math.max(0, last.number - 1) : null,
      // Text-conflict paths of an earlier generation live in retained compose results (R2), not in rows.
      conflictPaths: null,
    },
  };
}
/** Accepted landings in [from,to) by commit time, oldest first, one query execution per page.
 * Reads the receipt index plus about four indexed rows per landing; no scan, no writes, no idle work.
 * A page ends early at the read or output byte budget; `nextCursor` resumes exactly there. */
export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    from: v.string(),
    to: v.string(),
    limit: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read landings.');
      await accessibleProject(ctx, input.projectId, user.subject);
      const from = Date.parse(input.from),
        to = Date.parse(input.to);
      invariant(
        Number.isFinite(from) && Number.isFinite(to) && from < to,
        'BAD_ARGUMENT',
        'Use a finite window [from,to).',
      );
      const resume = input.cursor ? Number(input.cursor) : from;
      invariant(
        Number.isFinite(resume) && resume >= from && resume < to,
        'BAD_ARGUMENT',
        'The cursor does not belong to this window.',
      );
      const limit = Math.max(
        1,
        Math.min(LANDINGS_MAX_LIMIT, Math.floor(input.limit ?? LANDINGS_DEFAULT_LIMIT)),
      );
      const receipts = await ctx.db
        .query('projectHostedAcceptances')
        .withIndex('by_project', q =>
          q.eq('projectId', input.projectId).gte('_creationTime', resume).lt('_creationTime', to),
        )
        .order('asc')
        .take(limit + 1);
      const rows: Awaited<ReturnType<typeof evidence>>['row'][] = [];
      let read = 0,
        output = 0,
        next: number | null = null;
      for (const [index, receipt] of receipts.entries()) {
        if (
          index >= limit ||
          (rows.length && (read >= LANDINGS_READ_BYTES || output >= LANDINGS_OUTPUT_BYTES))
        ) {
          next = receipt._creationTime;
          break;
        }
        const found = await evidence(ctx, input.projectId, JSON.parse(receipt.value) as HostedAcceptance);
        read += receipt.value.length + found.bytes;
        output += JSON.stringify(found.row).length;
        rows.push(found.row);
      }
      return JSON.stringify({
        schema: 1,
        window: { from: input.from, to: input.to },
        landings: rows,
        nextCursor: next === null ? null : String(next),
        bytesRead: read,
      });
    } catch (error) {
      return report(error);
    }
  },
});
