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
import { nextCreationCursor, readCreationCursor } from './creationTimeCursor';
import { landingAcceptedBySchema, receiptAcceptedBy } from '../src/landing-accepted-by';
import {
  LANDINGS_ATTEMPTS,
  LANDINGS_DEFAULT_LIMIT,
  LANDINGS_HELD_MS,
  LANDINGS_MAX_LIMIT,
  LANDINGS_OUTPUT_BYTES,
  LANDINGS_READ_BYTES,
  LANDINGS_REASON_CHARS,
  LANDINGS_RUN_IDS,
} from '../src/hosted-landings-view';

type AttemptProgress = {
  timing?: { composeStartedAt?: string; ciEndedAt?: string; settledAt?: string };
  error?: { code: string; message: string } | null;
};
/** Recomposes in the read chain, plus at most one per attempt past it (the count stays exact when not partial). */
function recomposes(attempts: HostedLandingAttempt[], lastNumber: number | undefined) {
  if (!attempts.length || lastNumber === undefined) return null;
  const candidates = new Set(attempts.map(attempt => attempt.candidate?.id ?? `n${attempt.number}`)).size;
  return Math.max(0, candidates - 1) + Math.max(0, lastNumber - attempts.at(-1)!.number);
}
/** A passed check whose attempt waited before it settled: an older submission taking main first,
 * a lease or a main move. Stored reason, never inferred. Read from attempt rows already loaded. */
function heldAfterCheck(attempts: HostedLandingAttempt[], progress: Array<AttemptProgress | null>) {
  const held = [];
  for (const [index, attempt] of attempts.entries()) {
    const timing = progress[index]?.timing;
    const from = Date.parse(timing?.ciEndedAt ?? ''),
      to = Date.parse(timing?.settledAt ?? '');
    if (!(to - from >= LANDINGS_HELD_MS)) continue;
    const error = progress[index]?.error;
    held.push({
      attempt: attempt.number,
      from: timing!.ciEndedAt!,
      to: timing!.settledAt!,
      seconds: Math.round((to - from) / 1000),
      outcome: error?.code ?? 'landed',
      reason: error?.message.slice(0, LANDINGS_REASON_CHARS) ?? null,
    });
  }
  return held;
}
const AUDIT_VERDICT: Record<string, string> = { green: 'passed', red: 'failed', stalled: 'stalled' };
const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());
/** One landing's evidence from rows already stored. Five indexed reads beyond the receipt itself. */
async function evidence(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  receipt: HostedAcceptance,
  sequence: number,
) {
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
    bytes += row.value.length + (row.progress?.length ?? 0);
    return JSON.parse(row.value) as HostedLandingAttempt;
  });
  const progress = chain.map(row => (row.progress ? (JSON.parse(row.progress) as AttemptProgress) : null));
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
  // The first stored main-audit event at or after this landing's sequence: the audit run that covered it.
  const audit = (
    await ctx.db
      .query('projectHostedMainAuditEvents')
      .withIndex('by_project_and_sequence', q => q.eq('projectId', projectId).gte('sequence', sequence))
      .order('asc')
      .take(1)
  )[0];
  bytes += audit ? 160 : 0;
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
      // Test shards the change did not reach: skipped, never pending (Issue 9e71abcc).
      checkSkipped: receipt.check?.skipped ?? null,
      landedHead: receipt.candidate.head,
      checkRunIds: runIds.slice(0, LANDINGS_RUN_IDS),
      ...(runIds.length > LANDINGS_RUN_IDS ? { moreCheckRunIds: runIds.length - LANDINGS_RUN_IDS } : {}),
      ...(chain.length === LANDINGS_ATTEMPTS ? { checkRunIdsPartial: true } : {}),
      followingAudit: audit
        ? { runId: audit.runId, verdict: AUDIT_VERDICT[audit.kind] ?? audit.kind, sequence: audit.sequence }
        : null,
      // A check binding replaces an attempt without composing again: count distinct Candidates.
      recomposeCount: recomposes(attempts, last?.number),
      // Each attempt restamps timing.composeStartedAt; the first compose is the first attempt's (19328518).
      firstComposeStartedAt: progress[0]?.timing?.composeStartedAt ?? state?.timing?.composeStartedAt ?? null,
      heldAfterCheck: heldAfterCheck(attempts, progress),
      // Older submissions it waited for after its check passed, and whether footprints overlapped (c6b81429).
      orderWaits: receipt.orderWaits ?? null,
      // A person's acceptance or an automatic one (fe5bea80); older rows fall back to the receipt actor.
      acceptedBy: state?.acceptance?.acceptedBy
        ? landingAcceptedBySchema.parse(state.acceptance.acceptedBy)
        : receipt.actor
          ? receiptAcceptedBy(receipt)
          : null,
      // The agent run and its declared client (harness, model) that submitted it (81d12a32).
      agentRun: receipt.agentRun ?? null,
      agentClient: receipt.agentClient ?? null,
      // A shared cohort check that failed before this member landed: counted, never hidden by the fallback.
      sharedBatch: state?.batchDiagnostic?.sharedRunId
        ? {
            runId: state.batchDiagnostic.sharedRunId,
            individualPassed: state.batchDiagnostic.individualPassed,
            likelyCulprit: state.batchDiagnostic.likelyCulprit,
          }
        : null,
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
      const { resume, skip } = readCreationCursor(input.cursor, from, to);
      const limit = Math.max(
        1,
        Math.min(LANDINGS_MAX_LIMIT, Math.floor(input.limit ?? LANDINGS_DEFAULT_LIMIT)),
      );
      const fetched = await ctx.db
        .query('projectHostedAcceptances')
        .withIndex('by_project', q =>
          q.eq('projectId', input.projectId).gte('_creationTime', resume).lt('_creationTime', to),
        )
        .order('asc')
        .take(skip + limit + 1);
      const receipts = fetched.slice(skip);
      const rows: Awaited<ReturnType<typeof evidence>>['row'][] = [];
      let read = 0,
        output = 0,
        next: string | null = null;
      for (const [index, receipt] of receipts.entries()) {
        if (
          index >= limit ||
          (rows.length && (read >= LANDINGS_READ_BYTES || output >= LANDINGS_OUTPUT_BYTES))
        ) {
          next = nextCreationCursor(fetched, skip + index);
          break;
        }
        const found = await evidence(
          ctx,
          input.projectId,
          JSON.parse(receipt.value) as HostedAcceptance,
          receipt.sequence,
        );
        read += receipt.value.length + found.bytes;
        output += JSON.stringify(found.row).length;
        rows.push(found.row);
      }
      return JSON.stringify({
        schema: 1,
        window: { from: input.from, to: input.to },
        landings: rows,
        nextCursor: next,
        bytesRead: read,
      });
    } catch (error) {
      return report(error);
    }
  },
});
