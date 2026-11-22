// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { mirrorReceipt } from './projectGithubMirrorStatus.idle';
import { accessibleProject, readProjectRole } from './projectAuthority';
import { cohortHoldEvidence } from './projectHostedLandingFields';
import { desiredLanding } from './projectHostedLandingDesiredWake';
import { hydrateLandingRequest, landingRequestOriginalDb } from './projectLandingRequestBody';
import { receiptMessageForReader } from './projectHostedAcceptanceMessage';
import { report } from './errors';
import { landingCapsulePointer } from './projectLandingCapsuleStore';
import { landingAttemptPrefix } from './projectHostedLandingAttemptRead';
import { replayHoldEdges, replayRead, type LandingReplay } from './projectHostedLandingReplay';
import { landingRow } from './projectHostedLandingStore';
import { finishRow } from './projectHostedFinishWake';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import type { HostedLandingAttempt, HostedLandingState } from '../src/hosted-landing';
import { invariant } from '../src/errors';
import { passToLandMinutes } from '../src/landing-speed-alerts';
import { landingOrderEvidence } from './projectHostedLandingOrder';
import { nextCreationCursor, readCreationCursor } from './creationTimeCursor';
import { landingAcceptedBySchema, receiptAcceptedBy } from '../src/landing-accepted-by';
import { authorshipLabel } from './projectAuthorshipLabel';
import { landingMessageForReader, landingMessageText } from './projectHostedLandingMessageBody';
import {
  LANDINGS_ATTEMPTS,
  LANDINGS_DEFAULT_LIMIT,
  LANDINGS_HELD_MS,
  LANDINGS_MAX_LIMIT,
  LANDINGS_OUTPUT_BYTES,
  LANDINGS_READ_BYTES,
  LANDINGS_REASON_CHARS,
  LANDINGS_RUN_IDS,
  landingClientHoldSeconds,
  landingCosts,
  landingRecomposeCount,
} from '../src/hosted-landings-view';

type AttemptProgress = {
  phase?: HostedLandingState['phase'];
  timing?: { composeStartedAt?: string; ciEndedAt?: string; settledAt?: string };
  error?: { code: string; message: string } | null;
};
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
/** Audit events read at a landing's following sequence: the red, stalls, and the event naming that receipt. */
const LANDINGS_AUDIT_EVENTS = 4;
const AUDIT_VERDICT: Record<string, string> = { green: 'passed', red: 'failed', stalled: 'stalled' };
/** One culprit event names one receipt (Item 687d1eda): the landings below it are in the red range,
 * never culprits themselves. A coverage event names the receipt that made the failing tests run. */
export const followingAuditVerdict = (
  audit: { kind: string; culprit?: string; covered?: string },
  receiptId: string,
) =>
  audit.kind === 'culprit'
    ? audit.culprit === receiptId
      ? 'culprit'
      : audit.covered === receiptId
        ? 'made-tests-run'
        : 'in-red-range'
    : (AUDIT_VERDICT[audit.kind] ?? audit.kind);
const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());
/** One landing's evidence from rows already stored. Five indexed reads beyond the receipt itself (the audit
 * events one page of at most LANDINGS_AUDIT_EVENTS rows). */
async function evidence(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  receipt: HostedAcceptance,
  sequence: number,
) {
  let bytes = 0;
  const request = await landingRow(ctx, { projectId, submissionId: receipt.submissionId }, false);
  const state = request ? (JSON.parse(request.value) as HostedLandingState) : null;
  bytes += request?.value.length ?? 0;
  if (request) {
    const {
      orderWaits,
      orderHandoffs,
      keptRun,
      passToSettlementSeconds,
      passToLandMinutes,
      proofMainReceiptId,
    } = request;
    bytes +=
      JSON.stringify({
        orderWaits,
        orderHandoffs,
        keptRun,
        passToSettlementSeconds,
        passToLandMinutes,
        proofMainReceiptId,
      }).length - 2;
  }
  // Use the existing attempt read first: ordinary landings add no pointer seek. A partial
  // removal has lost the immutable first attempt, so its complete archived chain wins.
  const liveChain = await landingAttemptPrefix(ctx, projectId, receipt.submissionId);
  const pointer =
    request?.capsule ??
    (request &&
    (!liveChain.length || (state?.firstAttemptId && liveChain[0]!.attemptId !== state.firstAttemptId))
      ? await landingCapsulePointer(ctx, { projectId, submissionId: receipt.submissionId })
      : null);
  const archived = pointer?.summary
    ? (JSON.parse(pointer.summary).evidence as
        | {
            chain: Array<{ number: number; value: string; progress?: string; replay?: LandingReplay }>;
            lastNumber: number | null;
            bytes: number;
          }
        | undefined)
    : undefined;
  const chain = archived?.chain ?? liveChain;
  const attempts = chain.map(row => {
    if (!archived)
      bytes +=
        row.value.length + (row.progress?.length ?? 0) + (row.replay ? JSON.stringify(row.replay).length : 0);
    return JSON.parse(row.value) as HostedLandingAttempt;
  });
  const progress = chain.map(row => (row.progress ? (JSON.parse(row.progress) as AttemptProgress) : null));
  if (archived) bytes += archived.bytes;
  // A longer chain than we read: take the true last number from one more indexed read.
  const last = archived
    ? archived.lastNumber === null
      ? null
      : { number: archived.lastNumber }
    : chain.length === LANDINGS_ATTEMPTS
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
  // The first stored main-audit event at or after this landing's sequence: the audit run that covered it. Several
  // can share that sequence (the red, then a culprit or coverage event naming the audited head): one bounded page
  // of the same range, preferring the event that names this receipt.
  const near = await ctx.db
    .query('projectHostedMainAuditEvents')
    .withIndex('by_project_and_sequence', q => q.eq('projectId', projectId).gte('sequence', sequence))
    .order('asc')
    .take(LANDINGS_AUDIT_EVENTS);
  const first = near.filter(row => row.sequence === near[0]?.sequence);
  const audit =
    first.find(row => row.kind === 'culprit' && (row.culprit === receipt.id || row.covered === receipt.id)) ??
    first[0];
  bytes += near.reduce((size, row) => size + 160 + (row.coverage?.length ?? 0), 0);
  const admissionBase = attempts[0]?.main ?? null;
  const landedBase = receipt.previous;
  // Before builder stamps, the attempt named the submitter while the receipt named the approver.
  const builder = attempts[0]?.actor ?? receipt.actor;
  const message = await landingMessageText(ctx, projectId, receipt);
  if (receipt.messageRef) bytes += new TextEncoder().encode(message).length;
  return {
    bytes,
    row: {
      title: (message ?? state?.message ?? state?.request?.message)?.split(/\r?\n/, 1)[0] ?? null,
      receiptId: receipt.id,
      submissionId: receipt.submissionId,
      laneId: lanes[0]?.key ?? null,
      ...(lanes.length > 1 ? { moreLanes: true } : {}),
      intentId,
      kind: request?.revertOf ? 'compensating' : 'landing',
      batchId: receipt.batchId ?? null,
      submittedAt: state?.timing?.submittedAt ?? state?.at ?? null,
      clientHoldSeconds: landingClientHoldSeconds(state),
      cohortHold: cohortHoldEvidence(request),
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
        ? {
            runId: audit.runId,
            verdict: followingAuditVerdict(audit, receipt.id),
            sequence: audit.sequence,
            ...(audit.coverage ? { coverage: JSON.parse(audit.coverage) } : {}),
          }
        : null,
      // A check binding replaces an attempt without composing again: count distinct Candidates.
      recomposeCount: landingRecomposeCount(attempts, last?.number),
      costs: landingCosts(state, last?.number, request?.runnerAccounting?.pending),
      // Each attempt restamps timing.composeStartedAt; the first compose is the first attempt's (19328518).
      firstComposeStartedAt: progress[0]?.timing?.composeStartedAt ?? state?.timing?.composeStartedAt ?? null,
      heldAfterCheck: heldAfterCheck(attempts, progress),
      // Older submissions it waited for after its check passed, and whether footprints overlapped (c6b81429).
      orderWaits: landingOrderEvidence(request, receipt.orderWaits),
      keptRun: request?.keptRun ?? null,
      passToSettlementSeconds: request?.passToSettlementSeconds ?? null,
      passToLandMinutes: request?.passToLandMinutes ?? passToLandMinutes(state?.timing, request?.passedAt),
      // Each main-red hold it waited under (held, released); this receipt is the re-landing (687d1eda).
      mainRedHolds: receipt.mainRedHolds ?? null,
      // A person's acceptance or an automatic one (fe5bea80); older rows fall back to the receipt actor.
      acceptedBy: state?.acceptance?.acceptedBy
        ? landingAcceptedBySchema.parse(state.acceptance.acceptedBy)
        : receipt.actor
          ? receiptAcceptedBy(receipt)
          : null,
      // The agent run and its declared client (harness, model) that submitted it (81d12a32).
      agentRun: receipt.agentRun ?? null,
      agentClient: receipt.agentClient ?? null,
      ...(builder || receipt.authorship || receipt.agentClient || receipt.agentRun
        ? { builderModel: authorshipLabel({ ...receipt, actor: builder }).model }
        : {}),
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
      holdEdges: replayHoldEdges(receipt.orderWaits),
      attemptReplay: attempts.map((attempt, index) =>
        replayRead(attempt, chain[index]?.replay, progress[index]?.phase),
      ),
      ...(last && (chain.at(-1)?.number ?? -1) < last.number ? { attemptReplayPartial: true } : {}),
    },
  };
}
/** Exact receipt id or unique prefix. The prefix range needs at most two rows. */
async function selectedReceipt(ctx: QueryCtx, projectId: Id<'hostedProjects'>, receiptId: string) {
  const wanted = receiptId.trim().toLowerCase();
  invariant(
    wanted.length >= 8 && wanted.length <= 64,
    'BAD_ARGUMENT',
    'Pass a receipt id or at least 8 characters of one.',
  );
  const exact = await ctx.db
    .query('projectHostedAcceptances')
    .withIndex('by_project_and_receipt', q => q.eq('projectId', projectId).eq('receiptId', wanted))
    .unique();
  const found = exact
    ? [exact]
    : await ctx.db
        .query('projectHostedAcceptances')
        .withIndex('by_project_and_receipt', q =>
          q.eq('projectId', projectId).gte('receiptId', wanted).lt('receiptId', `${wanted}\uffff`),
        )
        .take(2);
  invariant(found.length, 'NOT_FOUND', `No landing in this project has receipt id ${wanted}.`);
  invariant(
    found.length === 1,
    'AMBIGUOUS_ID',
    `Receipt prefix ${wanted} matches more than one landing (${found.map(row => row.receiptId).join(', ')}, ...); pass more characters.`,
  );
  return found[0]!;
}

/** The public query layer can interpret embedded JSON as structured identity fields.
 * Encode the UTF-8 payload to preserve literal message text through that layer. */
function messageReply(identity: object, fields: Record<string, string | string[] | null>) {
  const bytes = new TextEncoder().encode(JSON.stringify(fields));
  invariant(
    bytes.length < 48 * 1024,
    'SOURCE_UNAVAILABLE',
    'The retained landing message exceeds the selected read budget.',
  );
  const messageBase64 = btoa(String.fromCharCode(...bytes));
  const reply = JSON.stringify({ schema: 1, ...identity, messageBase64 });
  invariant(
    new TextEncoder().encode(reply).length < 64 * 1024,
    'SOURCE_UNAVAILABLE',
    'The retained landing message exceeds the selected read budget.',
  );
  return reply;
}

async function selectedRequest(ctx: QueryCtx, projectId: Id<'hostedProjects'>, submissionId: string) {
  const key = { projectId, submissionId };
  const db = landingRequestOriginalDb(ctx.db);
  const live = await landingRow({ ...ctx, db }, key, false);
  // The cold selection body can be much larger and carries no request message.
  const retained = live
    ? await hydrateLandingRequest(db, { ...live, selectionBodyId: undefined })
    : await desiredLanding(ctx, key);
  invariant(retained, 'NOT_FOUND', 'Hosted landing request not found.');
  const state = JSON.parse(retained.value as string) as HostedLandingState;
  invariant(
    state.id === submissionId && state.projectId === projectId && state.request,
    'SOURCE_UNAVAILABLE',
    'Landing request identity differs from its record.',
  );
  const { request, message } = await landingMessageForReader(ctx, projectId, state);
  return messageReply(
    { submissionId, cohortHold: cohortHoldEvidence(live) },
    { requestMessage: request?.message ?? null, message: message ?? null },
  );
}

async function oneLanding(ctx: QueryCtx, project: Doc<'hostedProjects'>, receiptId: string) {
  const receipt = await selectedReceipt(ctx, project._id, receiptId);
  const [{ row }, mirror] = await Promise.all([
    evidence(ctx, project._id, JSON.parse(receipt.value) as HostedAcceptance, receipt.sequence),
    mirrorReceipt(ctx, project, receipt.receiptId),
  ]);
  return { schema: 1, landings: [{ ...row, ...(mirror ? { mirror } : {}) }], nextCursor: null };
}
/** Accepted landings in [from,to) by commit time, oldest first, one query execution per page.
 * Reads the receipt index plus about four indexed rows per landing; no scan, no writes, no idle work.
 * A page ends early at the read or output byte budget; `nextCursor` resumes exactly there. */
export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    from: v.optional(v.string()),
    to: v.optional(v.string()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
    /** One landing by its receipt id or a unique 8+ character prefix, instead of a window. */
    receiptId: v.optional(v.string()),
    message: v.optional(v.literal(true)),
    submissionId: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read landings.');
      const project = await accessibleProject(ctx, input.projectId, user.subject);
      if (input.submissionId !== undefined || input.message !== undefined || input.receiptId !== undefined) {
        invariant(
          input.from === undefined &&
            input.to === undefined &&
            input.cursor === undefined &&
            !(
              input.submissionId !== undefined &&
              (input.receiptId !== undefined || input.message !== undefined)
            ),
          'BAD_ARGUMENT',
          'Select a window, one receipt, or one submission.',
        );
        if (input.submissionId !== undefined) {
          // A pre-acceptance request can contain a message never published to the project.
          invariant(
            await readProjectRole(ctx, project, user.subject),
            'NOT_FOUND',
            'Hosted landing request not found.',
          );
          return await selectedRequest(ctx, input.projectId, input.submissionId);
        }
        invariant(input.receiptId !== undefined, 'BAD_ARGUMENT', 'Select receiptId to read its message.');
        if (input.message) {
          const row = await selectedReceipt(ctx, input.projectId, input.receiptId);
          const receipt = await receiptMessageForReader(
            ctx,
            input.projectId,
            JSON.parse(row.value) as HostedAcceptance,
            row.sequence,
          );
          return messageReply(
            { receiptId: receipt.id, submissionId: receipt.submissionId },
            { message: receipt.message ?? null, cohortMessages: receipt.cohortMessages ?? null },
          );
        }
        return JSON.stringify(await oneLanding(ctx, project, input.receiptId));
      }
      const from = Date.parse(input.from ?? ''),
        to = Date.parse(input.to ?? '');
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
