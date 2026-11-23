// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { checkRequest as githubCheckRequest } from './projectGithubCheckRequest';
import { candidateOwnerInputs } from './projectHostedProvenance';
import { semanticPayload } from '../src/semantic-payload';
import { finishChild } from '../src/finish-child';
import { mainSemanticMembers, mergeSemanticMembers, semanticBaseSequence } from './projectSemanticContracts';
import { readHostedRecord, hostedWriteProject } from './projectHostedRecords';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { ReplayCause } from './projectHostedLandingReplay';
import { hostedStartMain } from './projectHostedChannels';
import { keepTheRunOn } from './projectHostedKeepSwitch';
import { beginHostedOperation } from './projectHostedOperations';
import { composeRow, loadCompose, type ComposeState } from './projectHostedComposeStore';
import { saveObject } from './projectHostedSaveStore';
import {
  loadLanding,
  loadLandingAttempt,
  forkLandingAttempt,
  insertLandingAttempt,
  writeLanding,
  retainLandingProgress,
  type LandingIdentity,
  type LandingRow,
} from './projectHostedLandingStore';
import { pinLandingAttempt } from './projectHostedLandingPins';
import { wakeLandingQueue, releaseLandingQueue } from './projectHostedLandingWake';
import { landingQueue } from './projectHostedLandingStore';
import { writeFinish, failFinish } from './projectHostedFinishStore';
import { passRepinnedFollowers, scheduleFinish, wakeLandingOrderWaiters } from './projectHostedFinishWake';
import {
  HOSTED_FINISH_COMPOSE_WATCH_WINDOW_MS,
  hostedFinishBackoff,
  type HostedFinish,
} from '../src/hosted-finish';
import { hostedRecordSchema } from '../src/hosted-records';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { storedLandingStateSchema, landingObservation, type HostedLandingState } from '../src/hosted-landing';
import { invariant } from '../src/errors';
import { requireLandingPaths } from './accessPolicy';
import { validCrossHeadProof, type CrossHeadProof } from '../src/hosted-cross-head-proof';
import { carriedCostCounts } from '../src/landing-speed-alerts';
import { retiredCheckUsage } from './projectHostedLandingRunnerCosts';
import { compactDiscardedChecksOn } from './projectHostedLandingRunnerCostSwitch';
import { invalidatePipeline } from './projectHostedLandingPipeline';
import { scopedRecheckBasis, scopedRecheckFallback } from './projectHostedScopedRecheck';
import { forkRaceReason } from '../src/fallback-reasons';
import { requireHostedCheckEvidence } from './projectHostedCheckRead';
import { type HostedCheckRun, checkCause } from '../src/hosted-check';
import { providerRetryDelay } from '../src/ci-provider-recovery';
import { loadHostedCheck } from './projectHostedCheckStore';
async function wakeAfterPrecompose(
  ctx: MutationCtx,
  projectId: Doc<'projectHostedFinishes'>['projectId'],
  submissionId: string,
  runnable: boolean,
) {
  const input = { projectId, channel: 'main' as const };
  const queue = await landingQueue(ctx, input);
  if (queue?.lease?.submissionId === submissionId) await releaseLandingQueue(ctx, queue);
  else if (runnable) await wakeLandingQueue(ctx, input);
}
/** Consume only a committed main event retained while this job was running.
 * Repeated events occupy one slot; job completion, never an idle timer, resumes
 * the latest observed main unless an ordinary claim has already taken source
 * ownership. Reservation and settlement share this mutation. */
async function continuePrecompose(ctx: MutationCtx, row: Doc<'projectHostedFinishes'>, value: HostedFinish) {
  const probe = value.pending?.precompose;
  if (!probe?.next) return false;
  const { next, ...context } = probe;
  await reserveFinishRetry(
    ctx,
    (await ctx.db.get(row._id))!,
    { ...value, pending: null },
    'CHECK_EVIDENCE_REFRESH',
    { ...context, peerLanes: [...new Set([...context.peerLanes, ...next.peerLanes])] },
    { head: next.main.head, receipt: { id: next.main.receiptId } },
  );
  return true;
}
/** Why an install replaces the current attempt when its retry reservation recorded no cause (an
 * attempt rotated after the reservation): the mover when the pending base moved, else unknown. */
async function installCause(
  ctx: MutationCtx,
  state: HostedLandingState,
  main: { head: string; receiptId: string },
): Promise<ReplayCause> {
  const parent = await loadLandingAttempt(ctx, {
    projectId: state.projectId as Id<'hostedProjects'>,
    attemptId: state.attemptId,
  });
  return parent.main.head !== main.head || parent.main.receiptId !== main.receiptId
    ? { kind: 'main-race', link: main.receiptId }
    : { kind: 'unknown', link: 'finish-install:ATTEMPT_REPLACED' };
}
/** A main race is not a retry of the old request or a reusable check. Retain a
 * named child before IO, yield with bounded backoff, and resume that child only.
 * `bound`: the landing as this transaction already holds it, unwritten (a proof
 * the queue tick bound on a moved main, 5b4b5918); its one write carries both. */
export async function reserveFinishRetry(
  ctx: MutationCtx,
  row: Doc<'projectHostedFinishes'>,
  value: HostedFinish,
  cause: 'BATCH_FALLBACK' | 'CHECK_EVIDENCE_REFRESH' = 'CHECK_EVIDENCE_REFRESH',
  precompose?: NonNullable<HostedFinish['pending']>['precompose'],
  observedMain?: { head: string; receipt: { id: string } },
  replayCause?: ReplayCause,
  bound?: {
    landing: LandingRow;
    state: HostedLandingState;
    write: NonNullable<Parameters<typeof writeLanding>[6]>;
  },
) {
  invariant(!value.pending, 'WORK_STALE', 'Resume the already pending finish attempt.');
  invariant(!bound || !precompose, 'WORK_STALE', 'A bound landing retries without a probe.');
  const input = { projectId: row.projectId, submissionId: row.submissionId };
  const { row: landing, state } = bound
    ? { row: bound.landing, state: bound.state }
    : await loadLanding(ctx, input);
  const previous = await loadLandingAttempt(ctx, { projectId: row.projectId, attemptId: state.attemptId });
  const main = observedMain ?? (await hostedStartMain(ctx, row.projectId));
  const cached =
    !precompose &&
    value.precomposed &&
    canonicalPayload(value.precomposed.main) ===
      canonicalPayload({ head: main.head, receiptId: main.receipt.id })
      ? value.precomposed
      : undefined;
  // A useful claim may adopt the exact in-flight advisory source operation.
  // Batch fallback can rotate metadata attempts without changing this finish's
  // immutable original selection. Its same-main source cache remains valid;
  // installation independently checks exact input/dependency roots below.
  const mainChanged = main.head !== previous.main.head || main.receipt.id !== previous.main.receiptId;
  const pending = {
    ...(precompose ? { precompose } : {}),
    // The caller's named cause, else the mover when main moved; the retry code otherwise.
    ...(await forkLandingAttempt(
      ctx,
      state,
      replayCause ??
        (mainChanged
          ? { kind: 'main-race', link: main.receipt.id }
          : { kind: 'unknown', link: `finish-retry:${cause}` }),
    )),
    at: new Date(Date.now()).toISOString(),
    main: { head: main.head, receiptId: main.receipt.id },
    operations: {
      compose: cached?.operationId ?? crypto.randomUUID(),
      check: crypto.randomUUID(),
      accept: crypto.randomUUID(),
    },
  };
  if (!precompose)
    await retainLandingProgress(
      ctx,
      state,
      {
        code: mainChanged ? 'CHANNEL_CHANGED' : cause,
        message: mainChanged
          ? `${await mainMoveReason(ctx, row.projectId, previous, main.head, state.sequence)}; a named child recomposes the original selection.`
          : cause === 'BATCH_FALLBACK'
            ? 'The shared batch fell back to an individual Candidate; main did not change.'
            : 'The acceptance evidence needs an exact refresh; main did not change.',
      },
      pending.main,
      // A bound landing's check evidence rides its censor: the censor settles the attempt's record.
      { ...bound?.write.replay, replacedByAttemptId: pending.id },
    );
  const retiringSolo =
    !precompose && !state.batchId && (state.phase === 'checking' || state.phase === 'ready');
  if (retiringSolo && landing.pipelineRetiredAttemptId !== state.attemptId)
    await invalidatePipeline(
      ctx,
      { projectId: row.projectId, batchId: state.id },
      { members: [{ submissionId: state.id }] },
    );
  await writeFinish(ctx, row, { ...value, pending });
  if (!precompose)
    await writeLanding(
      ctx,
      retiringSolo ? { ...landing, pipelineRetiredAttemptId: state.attemptId } : landing,
      {
        ...state,
        version: state.version + 1,
        timing: { submittedAt: state.at, ...state.timing, composeStartedAt: pending.at },
        observation: landingObservation('queued'),
        error: null,
      },
      false,
      true,
      undefined,
      bound?.write,
    );
  if (retiringSolo && landing.orderWaited) {
    await wakeLandingOrderWaiters(ctx, landing, true);
    await passRepinnedFollowers(ctx, landing, Date.parse(pending.at));
  }
  const current = (await ctx.db.get(row._id))!;
  // Solo fallback owns a new generation after the cohort retires. Replace its
  // old compose watch, while ordinary advisory work keeps its coalesced wake.
  // Item 9a04d916 F2: the step that submits this recompose runs in the exactly-once
  // settle mutation, not the at-most-once drive.
  await scheduleFinish(
    ctx,
    current,
    precompose ? 0 : hostedFinishBackoff(pending.number),
    cause === 'BATCH_FALLBACK',
    !precompose,
  );
  return Date.parse(pending.at);
}
/** Why this re-check happens: the landings that moved main since the stale
 * attempt was composed, and whether each was submitted before this one. One
 * indexed window of recent landings, read only when a re-check starts. */
async function mainMoveReason(
  ctx: MutationCtx,
  projectId: Doc<'projectHostedFinishes'>['projectId'],
  previous: { at: string; main: { head: string } },
  head: string,
  sequence: number,
) {
  const landed = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_phase_and_sequence', q =>
      q.eq('projectId', projectId).eq('channel', 'main').eq('phase', 'landed'),
    )
    .order('desc')
    .take(8);
  const movers = landed
    .map(row => storedLandingStateSchema.parse(JSON.parse(row.value)))
    .filter(s => Date.parse(s.timing?.committedAt ?? '') > Date.parse(previous.at))
    .sort((a, b) => a.sequence - b.sequence);
  const moved = `Main moved from ${previous.main.head.slice(0, 8)} to ${head.slice(0, 8)}`;
  if (!movers.length) return `${moved} outside the landing queue`;
  const named = (list: typeof movers) =>
    list.map(s => `#${s.sequence} (${s.operationId.slice(0, 8)})`).join(', ');
  const before = movers.filter(s => s.sequence < sequence),
    after = movers.filter(s => s.sequence > sequence);
  return [
    moved,
    ...(before.length ? [`${named(before)} landed, submitted before this one`] : []),
    ...(after.length ? [`${named(after)} landed, submitted after this one`] : []),
  ].join('; ');
}
/** Reuse trusted immutable selection roots, never re-read current Lane heads.
 * H08 already staged these pages and validated every entry before its first job. */
export async function prepareFinishCompose(ctx: MutationCtx, input: LandingIdentity, value: HostedFinish) {
  const { state } = await loadLanding(ctx, input),
    pending = value.pending!;
  const auth = { projectId: input.projectId, actor: state.actor, operationId: pending.operations.compose };
  const old = await composeRow(ctx, auth);
  if (old) return loadCompose(ctx, auth, true, old);
  const request = { ...value.source, operationId: auth.operationId, expectedMain: pending.main };
  const expected = { authorityEpoch: request.authorityEpoch, ...request.expectedMain };
  const prepared = await beginHostedOperation(ctx, {
    workKind: 'composes',
    ...auth,
    payload: request,
    request: { schema: 1, ...auth, expected, payloadHash: hostedPayloadHash(request, expected) },
    firstAttempt: {
      projectId: input.projectId,
      operationId: auth.operationId,
      id: pending.id,
      parentAttemptId: null,
      at: pending.at,
      expected,
      // A cached precompose can be adopted by a different landing attempt. Keep
      // its existing owner id in the extensible reservation map, independent of
      // either attempt id, so resolution notes retain their exact authority.
      ids: {
        submission: input.submissionId,
        candidate: crypto.randomUUID(),
        job: crypto.randomUUID(),
      },
    },
  });
  invariant(!prepared.replayed, 'SOURCE_UNAVAILABLE', 'The pending source operation lost its composition.');
  const originalRow = await readHostedRecord(ctx, {
    ...auth,
    kind: 'candidate',
    key: state.request.candidateId,
  });
  const originalCandidate = originalRow
    ? hostedRecordSchema.options[3].parse(JSON.parse(originalRow.value))
    : null;
  const peers = await mainSemanticMembers(ctx, auth, pending.main.receiptId);
  const semanticPlan = mergeSemanticMembers(
    request.intentId,
    originalCandidate?.semanticPlan?.members,
    peers,
  );
  if (semanticPlan.members.length) {
    const ownRow = await readHostedRecord(ctx, { ...auth, kind: 'intent', key: request.intentId });
    const own = ownRow ? hostedRecordSchema.options[0].parse(JSON.parse(ownRow.value)) : null;
    semanticPlan.afterSequence =
      originalCandidate?.semanticPlan?.afterSequence ??
      (own?.base?.receiptId ? await semanticBaseSequence(ctx, input.projectId, own.base.receiptId) : 0);
  }
  const project = await hostedWriteProject(ctx, input.projectId, state.actor, request.authorityEpoch);
  const stateValue: ComposeState = {
    retryUntil: Date.parse(pending.at) + HOSTED_FINISH_COMPOSE_WATCH_WINDOW_MS,
    ownerProvenance: 1,
    ...(value.restoreBases ? { restoreBases: value.restoreBases } : {}),
    ...(originalCandidate?.earlyResolutions?.length
      ? { earlyResolutions: originalCandidate.earlyResolutions }
      : {}),
    ownerInputs: Boolean(
      originalRow &&
      originalCandidate &&
      candidateOwnerInputs(project, originalRow, originalCandidate, request.authorityEpoch),
    ),
    ...(semanticPlan.members.length ? { semanticPlan } : {}),
    request,
    main: await saveObject(ctx, input.projectId, { sha256: pending.main.head }),
    inputs: { next: null, pages: request.inputs.pages, count: request.inputs.count },
    dependencies: { next: null, pages: request.dependencies.pages, count: request.dependencies.count },
    candidateId: prepared.operation.firstAttempt.ids.candidate!,
    // Keep source jobs in a separate operation namespace from caller-supplied
    // Candidate UUIDs, without retaining another random reservation.
    jobOperationId:
      prepared.operation.firstAttempt.ids.jobOperation ??
      finishChild(prepared.operation.firstAttempt.ids.candidate!, 'source-job'),
    status: 'ready',
  };
  const fields = {
    ...auth,
    jobId: prepared.operation.firstAttempt.ids.job!,
    selectionCandidateId: state.request.candidateId,
    value: semanticPayload(stateValue),
  };
  const id = await ctx.db.insert('projectHostedComposes', fields);
  // These records and the authority check were produced in this transaction.
  // Do not reload the same compose, operation and project just to return them.
  return { row: (await ctx.db.get(id))!, state: stateValue, project, operation: prepared.operation };
}
export async function installFinishCompose(
  ctx: MutationCtx,
  row: Doc<'projectHostedFinishes'>,
  value: HostedFinish,
  proof?: CrossHeadProof,
  preparedSource?: Awaited<ReturnType<typeof loadCompose>>,
  recheckReason?: string,
  checkedRun?: HostedCheckRun,
  auditDonor?: boolean,
  reviewedDigest?: string,
) {
  const input = { projectId: row.projectId, submissionId: row.submissionId };
  const { row: landing, state } = await loadLanding(ctx, input),
    pending = value.pending!;
  const source =
    preparedSource ??
    (await loadCompose(ctx, {
      projectId: row.projectId,
      actor: state.actor,
      operationId: pending.operations.compose,
    }));
  if (
    pending.precompose &&
    (state.phase === 'landed' ||
      state.phase === 'terminal-failed' ||
      pending.parentAttemptId !== state.attemptId ||
      (state.batchId && landing.runId))
  ) {
    // The shared exact generation now owns this member. A late individual
    // probe cannot replace its check, head or terminal result.
    await writeFinish(ctx, row, { ...value, pending: null });
    await scheduleFinish(ctx, (await ctx.db.get(row._id))!);
    return;
  }
  const terminal = source.operation.terminal;
  invariant(terminal, 'WORK_STALE', 'Wait for the original source job to settle.');
  // A running check retired by an acceptance owns a fresh exact composition.
  // Back-to-back main moves must not spend its replacement CI on an obsolete
  // source generation, or expose an obsolete conflict as the final outcome.
  if (!pending.precompose && state.batchNeedsSoloCompose) {
    const main = await hostedStartMain(ctx, row.projectId);
    if (main.head !== pending.main.head || main.receipt.id !== pending.main.receiptId) {
      await reserveFinishRetry(
        ctx,
        row,
        { ...value, pending: null },
        'CHECK_EVIDENCE_REFRESH',
        undefined,
        main,
      );
      return;
    }
  }
  if (terminal.outcome.status === 'failed') {
    if (pending.precompose) {
      if (await continuePrecompose(ctx, row, value)) return;
      // Speculative infrastructure failure is not a source conflict. Let the
      // ordinary queue retry on demand, without an idle probe retry loop.
      await writeFinish(ctx, row, { ...value, pending: null });
      if (pending.precompose.runnable && !landing.runnable)
        await ctx.db.patch(landing._id, { runnable: true });
      await scheduleFinish(ctx, (await ctx.db.get(row._id))!);
      await wakeAfterPrecompose(
        ctx,
        row.projectId,
        state.id,
        pending.precompose.runnable || landing.runnable,
      );
    } else if (value.precomposed?.operationId === pending.operations.compose) {
      // Reusing a probe transfers source ownership, never its speculative
      // infrastructure failure. The ordinary claim gets its own fresh compose.
      const { precomposed: _probe, ...ordinary } = value;
      void _probe;
      await reserveFinishRetry(ctx, row, { ...ordinary, pending: null });
    } else await failFinish(ctx, input, terminal.outcome.error.code, terminal.outcome.error.message);
    return;
  }
  const candidate = hostedRecordSchema.parse(terminal.outcome.result);
  invariant(
    candidate.kind === 'candidate' &&
      candidate.id === source.state.candidateId &&
      canonicalPayload(candidate.base) === canonicalPayload(pending.main) &&
      canonicalPayload(candidate.inputs) === canonicalPayload(value.source.inputs.root) &&
      canonicalPayload(candidate.dependencies) === canonicalPayload(value.source.dependencies.root),
    'WORK_OPERATION_CHANGED',
    'The named recompose changed the original exact selection.',
  );
  // A folder-grant landing's recomposed files are checked before this step writes anything (df06081d).
  if (landing.grant && candidate.governance)
    requireLandingPaths(landing.grant.paths, candidate.governance.paths);
  if (pending.precompose) {
    const startMain =
      candidate.result.status === 'conflict' ? await hostedStartMain(ctx, row.projectId) : null;
    const obsoleteConflict = startMain !== null && startMain.head !== pending.main.head;
    // A real earlier conflict may already have disappeared on accepted main.
    // Retain its artifact, but let the latest notified source job (or ordinary
    // current-head controller) decide before publishing a terminal outcome.
    if (obsoleteConflict && (await continuePrecompose(ctx, row, value))) return;
    // Keep the run (fa2c1383, review a09af93a finding 2): a kept run's probe has no current-head
    // controller until its check passes, and the sweep skips it for a mover it does not touch. An
    // obsolete conflict re-probes on current main, so a real conflict still ends the run early.
    if (obsoleteConflict && state.phase === 'checking' && keepTheRunOn()) {
      const { next: _next, ...context } = pending.precompose;
      void _next;
      await reserveFinishRetry(
        ctx,
        (await ctx.db.get(row._id))!,
        { ...value, pending: null },
        'CHECK_EVIDENCE_REFRESH',
        context,
        startMain,
      );
      return;
    }
    // A probe never reserves a check or replaces shared batch membership. Keep
    // a clean result for an ordinary retry; a real conflict settles immediately.
    await writeFinish(ctx, row, {
      ...value,
      pending: null,
      ...(candidate.result.status === 'clean'
        ? {
            precomposed: {
              operationId: pending.operations.compose,
              parentAttemptId: pending.parentAttemptId,
              main: pending.main,
            },
          }
        : {}),
    });
    if (candidate.result.status === 'conflict' && !obsoleteConflict) {
      // Terminal readers must select this exact conflict, never the earlier
      // clean Candidate whose immutable inputs the probe recomposed. Pin its
      // child attempt without allocating a check or replacing batch membership.
      const original = await loadLandingAttempt(ctx, {
        projectId: row.projectId,
        attemptId: state.firstAttemptId,
      });
      const { id: attemptId, ...fork } = await forkLandingAttempt(
        ctx,
        state,
        { kind: 'conflict', link: candidate.id },
        pending,
      );
      const attempt = await pinLandingAttempt(ctx, {
        ...input,
        actor: original.actor,
        deferCheck: false,
        grant: landing.grant,
        request: {
          ...state.request,
          expectedMain: pending.main,
          candidateId: candidate.id,
          expectedHead: null,
          check: null,
        },
        attemptId,
        ...fork,
        at: pending.at,
        operations: { check: pending.operations.check, accept: pending.operations.accept },
        retainedSelection: original.candidate,
      });
      // A conflict against the moved main discards the parent's run (c3c69c57); the parent pin is cached.
      Object.assign(
        attempt,
        forkRaceReason(
          await loadLandingAttempt(ctx, { projectId: row.projectId, attemptId: state.attemptId }),
          attempt,
          'text-conflict',
        ),
      );
      await insertLandingAttempt(ctx, attempt);
      await writeLanding(
        ctx,
        landing,
        { ...state, version: state.version + 1, attemptId: attempt.id },
        false,
      );
      const paths = source.state.conflictSummary?.paths ?? pending.precompose.paths;
      const more = source.state.conflictSummary?.more ?? 0;
      await failFinish(
        ctx,
        input,
        'COMPOSITION_CONFLICT',
        `Candidate ${candidate.id} conflicts in ${paths.join(', ')}${more ? ` (and ${more} more files in its retained conflict pages)` : ''} against main ${pending.main.head}${pending.precompose.peerLanes.length ? ` (accepted Lane(s) ${pending.precompose.peerLanes.join(', ')})` : ''}. Continue with the receipt recovery command.`,
      );
      await wakeAfterPrecompose(ctx, row.projectId, state.id, true);
    } else {
      if (await continuePrecompose(ctx, row, value)) return;
      if (pending.precompose.runnable && !landing.runnable)
        await ctx.db.patch(landing._id, { runnable: true });
      if (!state.batchDiagnostic?.waitingFor) await scheduleFinish(ctx, (await ctx.db.get(row._id))!);
      await wakeAfterPrecompose(
        ctx,
        row.projectId,
        state.id,
        pending.precompose.runnable || landing.runnable,
      );
    }
    return;
  }
  const original = await loadLandingAttempt(ctx, {
    projectId: row.projectId,
    attemptId: state.firstAttemptId,
  });
  const previous = pending.parentAttemptId
    ? await loadLandingAttempt(ctx, { projectId: row.projectId, attemptId: pending.parentAttemptId })
    : null;
  if (proof && previous?.check && previous.candidate.head) {
    const checked = previous.crossHeadProof?.checked ?? previous.candidate;
    const checkedBase = previous.crossHeadProof?.checkedBase ?? previous.main;
    invariant(
      validCrossHeadProof(proof) &&
        proof.checked.id === checked.id &&
        proof.checked.head === checked.head &&
        proof.checked.digest === checked.digest &&
        canonicalPayload(proof.checkedBase) === canonicalPayload(checkedBase) &&
        canonicalPayload(proof.main) === canonicalPayload(pending.main) &&
        candidate.result.status === 'clean' &&
        proof.head === candidate.result.head &&
        proof.runId === previous.check.runId,
      'EVIDENCE_CHANGED',
      'Reuse only the exact verified recomposition proof.',
    );
    const run = await requireHostedCheckEvidence(
      ctx,
      {
        projectId: row.projectId,
        actor: previous.actor.id,
        candidateId: checked.id,
        head: checked.head!,
        authorityEpoch: previous.authorityEpoch,
        ...previous.check,
      },
      checkedRun,
    );
    invariant(
      run.terminalDigest === proof.terminalDigest &&
        run.planDigest === proof.planDigest &&
        run.plan?.selection.sha256 === proof.checkedSelection,
      'EVIDENCE_CHANGED',
      'The original check proof changed.',
    );
  } else proof = undefined;
  // A main race without a transferable proof may recheck only the shared impact.
  const recheck =
    !proof &&
    !landing.earlyReview &&
    !landing.ownerGrant &&
    previous &&
    candidate.result.status === 'clean' &&
    !(landing.githubInboundProof && previous.crossHeadProof)
      ? await scopedRecheckBasis(ctx, previous, checkedRun)
      : undefined;
  const scopedFallback =
    !proof && previous && candidate.result.status === 'clean'
      ? scopedRecheckFallback(previous, recheck)
      : undefined;
  const { id: attemptId, ...fork } = await forkLandingAttempt(
    ctx,
    state,
    // An exposed conflict outranks the base comparison, as it did when the cause was derived.
    candidate.result.status === 'conflict'
      ? { kind: 'conflict', link: candidate.id }
      : await installCause(ctx, state, pending.main),
    pending,
  );
  // This replacement may start now or later in the queue. Attach the donor evaluation to
  // its attempt on the same write that already records the first-check refusal.
  const checkedAdmission = landing.admission;
  const firstCheckRefusal =
    !proof &&
    checkedAdmission?.status === 'passed' &&
    !checkedAdmission.recheck &&
    previous?.check?.runId === checkedAdmission.runId;
  const firstCheckDonor = firstCheckRefusal ? auditDonor : undefined;
  if (firstCheckRefusal)
    await ctx.db.patch(landing._id, {
      admission: {
        ...checkedAdmission,
        recheck: recheckReason ?? 'not-eligible',
        ...(firstCheckDonor === undefined ? {} : { auditDonor: { attemptId, usable: firstCheckDonor } }),
      },
    });
  const checked = previous?.check || landing.admission;
  const moved =
    previous &&
    (previous.main.head !== pending.main.head || previous.main.receiptId !== pending.main.receiptId);
  const cause = checked
    ? moved
      ? checkCause.mainMoved
      : state.batchSolo
        ? checkCause.cohortSplit
        : checkCause.evidenceRefresh
    : state.batchSolo
      ? checkCause.cohortSplit
      : previous?.checkCause;
  const admission = landing.admission;
  // A kept admission is bound to the first attempt until its verdict. Only its platform retire
  // records an end time with main-moved. Read the old run once for the replacement's display hint.
  let providerDelayReason: string | undefined;
  if (
    !proof &&
    candidate.result.status === 'clean' &&
    value.check?.kind === 'request' &&
    state.batchNeedsSoloCompose &&
    pending.parentAttemptId === state.firstAttemptId &&
    admission?.status === 'unavailable' &&
    admission.recheck === 'main-moved' &&
    admission.endedAt !== undefined
  ) {
    const key = { projectId: row.projectId, runId: admission.runId };
    const retiredRun = await ctx.db
      .query('projectHostedCheckRuns')
      .withIndex('by_project_and_run', q => q.eq('projectId', key.projectId).eq('runId', key.runId))
      .unique();
    const reason = retiredRun && (await loadHostedCheck(ctx, key, false, retiredRun)).run.failureReason;
    providerDelayReason = providerRetryDelay(reason ?? undefined, admission.endedAt);
  }
  let earlyReview: string | null = null;
  let verifiedReview = false;
  const attempt = await pinLandingAttempt(ctx, {
    review: (reason, verified) => {
      earlyReview = reason;
      verifiedReview = verified;
    },
    ...(landing.ownerGrant && reviewedDigest ? { reviewedPolicy: landing.ownerGrant.policyDigest } : {}),
    ...(cause === undefined ? {} : { checkCause: cause }),
    ...(firstCheckDonor === undefined ? {} : { auditDonor: firstCheckDonor }),
    ...(recheck ? { recheck } : {}),
    ...(providerDelayReason ? { providerDelayReason } : {}),
    ...input,
    actor: original.actor,
    deferCheck: proof ? false : !state.batchSolo,
    grant: landing.grant,
    request: {
      ...state.request,
      expectedMain: pending.main,
      candidateId: candidate.id,
      expectedHead: candidate.result.status === 'clean' ? candidate.result.head : null,
      check: proof
        ? null
        : landing.githubInboundProof && previous?.crossHeadProof
          ? await githubCheckRequest(ctx, row.projectId)
          : value.check,
    },
    attemptId,
    ...fork,
    at: pending.at,
    operations: { check: pending.operations.check, accept: pending.operations.accept },
    retainedSelection: original.candidate,
  });
  if (proof && previous?.check) {
    attempt.check = previous.check;
    attempt.crossHeadProof = proof;
  }
  // The main-race row names why it rechecked, on the attempt this install already writes (7c2e69e1).
  // A recompose on the same main is not a race and records nothing, so one refusal counts once.
  if (!proof && previous && previous.main.head !== pending.main.head) {
    attempt.recheckReason = recheckReason ?? 'not-eligible';
    if (scopedFallback) attempt.scopedFallback = scopedFallback;
  }
  const reviewed = reviewedDigest === attempt.candidate.digest ? reviewedDigest : undefined;
  invariant(
    !verifiedReview || reviewed,
    'EVIDENCE_CHANGED',
    'The verified review selected another Candidate.',
  );
  const grant = landing.ownerGrant;
  let ownerGrant = grant;
  if (grant) {
    const { verifiedDigest, ...originalGrant } = grant;
    const currentDigest = grant.policyDigest === attempt.policyDigest ? reviewed : undefined;
    if (currentDigest !== verifiedDigest)
      ownerGrant = { ...originalGrant, ...(currentDigest ? { verifiedDigest: currentDigest } : {}) };
  }
  if (earlyReview || landing.earlyReview || ownerGrant !== landing.ownerGrant)
    await ctx.db.patch(landing._id, {
      earlyReview: earlyReview ? true : undefined,
      ...(ownerGrant !== landing.ownerGrant ? { ownerGrant } : {}),
    });
  await insertLandingAttempt(ctx, attempt);
  await writeFinish(ctx, row, { ...value, pending: null });
  const { batchNeedsSoloCompose: _needsSolo, ...installedState } = state;
  void _needsSolo;
  // A ready attempt's check is lost only when the replacement cannot reuse it.
  // Live cancellations retain their own pending accounting for a late report.
  const retired = !proof && state.phase === 'ready' && previous?.check ? retiredCheckUsage(state.counts) : {};
  const checkCounts = retired.counts ?? state.counts;
  const counts = carriedCostCounts(
    checkCounts,
    source.state.r2,
    !!proof,
    Boolean(
      state.supersedes ||
      retired.counts ||
      (compactDiscardedChecksOn() && checkCounts?.discardedRunnerSeconds === 0),
    ),
  );
  const reviewHold = earlyReview && !verifiedReview ? earlyReview : null;
  await writeLanding(
    ctx,
    { ...landing, earlyReview: earlyReview ? true : undefined, ...(ownerGrant ? { ownerGrant } : {}) },
    {
      ...installedState,
      version: state.version + 1,
      attemptId: attempt.id,
      phase: reviewHold ? 'checking' : 'queued',
      timing: {
        submittedAt: state.at,
        ...(state.timing?.ms ? { ms: state.timing.ms } : {}),
        composeStartedAt: pending.at,
        composedAt: new Date().toISOString(),
      },
      counts,
      observation: landingObservation(reviewHold ? 'waiting-for-review' : 'queued'),
      error: reviewHold ? { code: 'REVIEW_REQUIRED', message: reviewHold } : null,
    },
    true,
    checkedRun?.status !== 'passed' || landing.runId !== checkedRun.id,
  );
  if (reviewHold) await scheduleFinish(ctx, (await ctx.db.get(row._id))!);
  await wakeLandingQueue(ctx, { projectId: row.projectId, channel: 'main' });
}
