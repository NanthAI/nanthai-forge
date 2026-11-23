// SPDX-License-Identifier: Apache-2.0
import { cancelPendingTask } from './schedulerCancel';
import { passedAlone } from '../src/hosted-landing-suspect';
import { describeCheckFailure } from './projectHostedCheckFailure';
import { CHECK_FAILED_NEXT } from '../src/check-failure-detail';
import { loadBatch } from './projectHostedLandingBatchStore';
import { releaseUnstartedBatchForPriority } from './projectHostedLandingBatchPriority';
import { prepareLandingCheck } from './projectHostedLandingBatchCheck';
import {
  semanticVerdict,
  semanticConflictMessage,
  semanticBudgetMessage,
} from '../src/intent-semantic-conflict';
import { retainCheckProgress } from './projectHostedLandingCheckProgress';
import { checkReplay, type LandingReplay } from './projectHostedLandingReplay';
import type { MutationCtx } from './_generated/server';
import {
  landingQueue,
  loadLanding,
  loadLandingAttempt,
  writeLanding,
  settleLandingOperation,
  landingRow,
  type LandingChannel,
  type LandingRow,
} from './projectHostedLandingStore';
import { nextTrainLandingRow, scheduleLandingWake, releaseLandingQueue } from './projectHostedLandingWake';
import { closeOrderWait, olderLandingAhead, recordOrderWait } from './projectHostedLandingOrder';
import { reservationAhead } from './projectHostedLandingReservation';
import { overtakeMark } from '../src/landing-overtake';
import { hostedWriteProject, readHostedRecord } from './projectHostedRecords';
import { retrySoloLandingCheck } from './projectHostedLandingCheckRetry';
import { clearCiDown, holdSoloForCiDown } from './projectHostedLandingCiDown';
import { environmentEndOf } from './projectHostedLandingEnvironmentHold';
import { checkFailureKind } from '../src/hosted-landing-admission';
import { parkExactOnMainRed, parkRedOnlyEntry } from './projectHostedLandingParkExact';
import { loadHostedCheck } from './projectHostedCheckStore';
import { requireHostedCheckEvidence } from './projectHostedCheckRead';
import { hostedCheckTerminal } from '../src/hosted-check';
import { rememberGuardCheck } from './projectGuardMainRed';
import {
  HOSTED_LANDING_LEASE_MS,
  storedLandingStateSchema,
  landingObservation,
  type HostedLandingState,
} from '../src/hosted-landing';
import { ForgeError, invariant } from '../src/errors';
import {
  driveParkedWaiter,
  finishRow,
  passParkedFollowers,
  wakeLandingOrderWaiters,
} from './projectHostedFinishWake';
import { hostedLandingProgressAt } from '../src/hosted-landing-stall';
import { claimFinishPrecompose } from './projectHostedFinishPrecompose';
import { retryUnheldStaleLaneProof } from './projectHostedLandingEarlyRefusal';
import { alertExhausted, exhaustLanding, exhaustedReason } from './projectHostedLandingExhaust';
export type LandingClaim = LandingChannel & {
  owner: string;
  token: number;
  submissionId: string;
  attemptId: string;
};
/** Claim an original attempt and schedule its watchdog atomically. Expiry only
 * allows reconciliation; it never creates a new Candidate, run or provider call. */
export async function claimLandingQueue(
  ctx: MutationCtx,
  input: LandingChannel & { wakeId: string },
  now = Date.now(),
): Promise<LandingClaim | null> {
  const queue = await landingQueue(ctx, input);
  if (!queue) return null;
  if (queue.lease && queue.lease.until > now) {
    return queue.lease.owner === input.wakeId
      ? {
          projectId: input.projectId,
          channel: input.channel,
          owner: queue.lease.owner,
          token: queue.lease.token,
          submissionId: queue.lease.submissionId,
          attemptId: queue.lease.attemptId,
        }
      : null;
  }
  if (queue.wake?.id !== input.wakeId || queue.wake.at > now) return null;
  let row = queue.lease
    ? await landingRow(ctx, { projectId: input.projectId, submissionId: queue.lease.submissionId })
    : null;
  if (
    row &&
    (row.attemptId !== queue.lease!.attemptId || row.phase === 'terminal-failed' || row.phase === 'landed')
  )
    row = null;
  // 19328518: an advance that throws every time (a permanent non-Forge fault)
  // rolls back, so the expired lease re-selects the same attempt forever while
  // the queue still looks owned. Back the watchdog off and end that entry with
  // a reason after a few re-claims whose advance never committed.
  // The lease records the row version its claim wrote; a row still at that
  // version means no advance committed since (no extra write to settle it).
  const current = row ? storedLandingStateSchema.parse(JSON.parse(row.value)) : null;
  // A stall diagnosis changes the row version without advancing the controller.
  // Keep its existing retry count until actual progress clears that current stall.
  const diagnosedWithoutProgress =
    current?.observation.stall?.lastProgressAt === (current && hostedLandingProgressAt(current));
  const retries =
    row &&
    queue.lease!.claimed !== undefined &&
    (current!.version === queue.lease!.claimed || diagnosedWithoutProgress)
      ? (queue.lease!.retries ?? 0) + 1
      : 0;
  if (row && retries > LANDING_LEASE_RETRIES) {
    const stuck = storedLandingStateSchema.parse(JSON.parse(row.value));
    const reason = exhaustedReason(
      `The landing controller step failed ${retries - 1} times in a row on this entry without recording a result.`,
    );
    await alertExhausted(ctx, stuck, reason);
    await exhaustLanding(ctx, stuck, reason);
    return null;
  }
  const held = { until: null as number | null };
  if (!row) {
    row = await nextTrainLandingRow(ctx, queue, now, held);
    if (row?.priority === 'urgent' && queue.train?.length && !queue.train.includes(row.submissionId)) {
      const leader = await loadLanding(ctx, { projectId: input.projectId, submissionId: queue.train[0]! });
      if (leader.state.batchId) {
        const key = { projectId: input.projectId, batchId: leader.state.batchId };
        const { batch } = await loadBatch(ctx, key);
        await releaseUnstartedBatchForPriority(ctx, key, batch);
      }
    }
  }
  if (!row) {
    await ctx.db.patch(queue._id, { lease: null, wake: null });
    // A held train still owns one wake: when its hold ends the queue moves on.
    if (held.until !== null)
      await scheduleLandingWake(ctx, { ...queue, lease: null, wake: null }, held.until, now);
    return null;
  }
  const selectedState = (
    await loadLanding(ctx, { projectId: input.projectId, submissionId: row.submissionId })
  ).state;
  const lease = {
    owner: input.wakeId,
    token: queue.fence + 1,
    until: now + HOSTED_LANDING_LEASE_MS * 2 ** retries,
    submissionId: row.submissionId,
    attemptId: row.attemptId,
    claimed: selectedState.version + 1,
    ...(retries ? { retries } : {}),
  };
  await writeLanding(
    ctx,
    row,
    {
      ...selectedState,
      version: selectedState.version + 1,
      timing: {
        submittedAt: selectedState.at,
        ...selectedState.timing,
        selectedAt: selectedState.timing?.selectedAt ?? new Date(now).toISOString(),
      },
    },
    false,
  );
  await ctx.db.patch(queue._id, { fence: lease.token, lease, wake: null });
  await scheduleLandingWake(ctx, { ...queue, fence: lease.token, lease, wake: null }, lease.until, now);
  return {
    projectId: input.projectId,
    channel: input.channel,
    owner: lease.owner,
    token: lease.token,
    submissionId: lease.submissionId,
    attemptId: lease.attemptId,
  };
}
/** Re-claims of one attempt allowed before the supervisor ends it: the watchdog
 * waits 1, 2, 4 and 8 lease periods (about 7.5 min) between them. */
export const LANDING_LEASE_RETRIES = 4;
/** H14 must call this in the publication transaction before its independent
 * authority/main/receipt/policy/exact-run CAS. A lease is not acceptance evidence. */
export async function requireLandingLease(ctx: MutationCtx, claim: LandingClaim, now = Date.now()) {
  const queue = await landingQueue(ctx, claim),
    lease = queue?.lease;
  invariant(
    queue &&
      lease &&
      lease.owner === claim.owner &&
      lease.token === claim.token &&
      lease.until > now &&
      lease.submissionId === claim.submissionId &&
      lease.attemptId === claim.attemptId,
    'WORK_STALE',
    'The hosted landing driver lease changed.',
  );
  const loaded = await loadLanding(ctx, claim);
  invariant(
    loaded.state.attemptId === claim.attemptId,
    'WORK_STALE',
    'A different landing attempt is current.',
  );
  const attempt = await loadLandingAttempt(ctx, claim);
  invariant(
    attempt.submissionId === loaded.state.id,
    'SOURCE_UNAVAILABLE',
    'Landing attempt belongs to another request.',
  );
  return { ...loaded, attempt, queue };
}
/** Metadata-only finite tick. Checks run through their existing durable identity
 * outside this transaction. Ready remains pending for H14; this never moves main. */
export async function advanceLandingQueue(ctx: MutationCtx, claim: LandingClaim, now = Date.now()) {
  const selected = await loadLanding(ctx, claim);
  const queue = await landingQueue(ctx, claim);
  if (
    selected.state.attemptId === claim.attemptId &&
    selected.state.phase !== 'queued' &&
    queue?.lease?.submissionId !== claim.submissionId
  )
    return selected.state;
  const leased = await requireLandingLease(ctx, claim, now);
  const held = leased.queue;
  let { row, state, attempt } = leased;
  if (state.request.finish) {
    const finish = await finishRow(ctx, claim);
    if (finish) await claimFinishPrecompose(ctx, finish);
  }
  const reviewing = row.earlyReview && state.observation.pendingReason === 'waiting-for-review';
  let phase: HostedLandingState['phase'] = 'ready',
    observation = reviewing ? state.observation : landingObservation('queued');
  let error: HostedLandingState['error'] = reviewing ? state.error : null;
  let passedAt: string | null = null;
  let replay: LandingReplay | undefined;
  let bound = false;
  let staleOn: { head: string; receipt: { id: string } } | undefined;
  try {
    const prepared = await prepareLandingCheck(ctx, claim, { row, state, attempt, queue: held }, now);
    if (prepared === true) return (await loadLanding(ctx, claim)).state;
    // A bound admission proof is judged now: one write carries the binding and its verdict (5b4b5918).
    if (prepared) {
      ({ row, state, attempt } = prepared);
      bound = true;
      staleOn = (prepared as { staleOn?: typeof staleOn }).staleOn;
    }
    await hostedWriteProject(ctx, claim.projectId, attempt.actor.id, attempt.authorityEpoch);
    const candidate = await readHostedRecord(ctx, {
      projectId: claim.projectId,
      actor: attempt.actor.id,
      kind: 'candidate',
      key: attempt.candidate.id,
    });
    invariant(
      candidate?.digest === attempt.candidate.digest,
      'EVIDENCE_CHANGED',
      'The original Candidate metadata differs.',
    );
    if (attempt.candidate.head === null) {
      phase = 'terminal-failed';
      observation = landingObservation('conflict');
      error = {
        code: 'COMPOSITION_CONFLICT',
        message: `Candidate ${attempt.candidate.id} has retained source conflicts. Continue with the receipt recovery command.`,
      };
    } else if (attempt.check) {
      const check = attempt.check;
      const { run } = await loadHostedCheck(ctx, { projectId: claim.projectId, runId: check.runId });
      retainCheckProgress(state, run, now);
      replay = checkReplay(run);
      // An environment end (Item 0d14c456) counts toward the hold; failure path only, switch on.
      const environment = reviewing ? null : await environmentEndOf(ctx, claim.projectId, run);
      // A verdict (a pass or a failing test) shows CI runs checks: a CI-down hold ends (0 I/O unset).
      if (
        held?.ciDown &&
        !environment &&
        hostedCheckTerminal(run) &&
        checkFailureKind(run, { conflicts: [] }) !== 'platform'
      )
        await clearCiDown(ctx, held);
      const semantic = semanticVerdict(
        attempt.semanticPlan ?? run.semanticPlan,
        run.reportSummary?.semantic ?? run.contractReports ?? {},
        {
          candidateId: attempt.candidate.id,
          head: attempt.candidate.head,
          runId: run.id,
        },
      );
      if (
        hostedCheckTerminal(run) &&
        state.batchNeedsSoloCompose &&
        !state.batchOriginId &&
        row.pipelineRetiredAttemptId === state.attemptId
      ) {
        // This speculative tree lost its owner-held predecessor. A failure on
        // that tree cannot settle the member's fresh composition on main.
        phase = 'ready';
        observation = landingObservation('queued');
      } else if (hostedCheckTerminal(run) && semantic.overBudget) {
        phase = 'terminal-failed';
        observation = landingObservation('failed', 'CONTRACT_OVER_BUDGET');
        error = {
          code: 'CONTRACT_OVER_BUDGET',
          message: semanticBudgetMessage(semantic.overBudgetPairs),
        };
      } else if (['passed', 'failed'].includes(run.status) && semantic.conflicts.length) {
        phase = 'terminal-failed';
        observation = landingObservation('conflict');
        state.semanticConflicts = semantic.conflicts;
        error = { code: 'INTENT_SEMANTIC_CONFLICT', message: semanticConflictMessage(semantic.conflicts) };
      } else if (
        !reviewing &&
        hostedCheckTerminal(run) &&
        (await holdSoloForCiDown(ctx, claim, { row, state, attempt }, run, held, environment))
      ) {
        await releaseLandingQueue(ctx, held, now);
        return (await loadLanding(ctx, claim)).state;
      } else if (
        hostedCheckTerminal(run) &&
        (await retrySoloLandingCheck(ctx, claim, attempt, run, row.earlyReview))
      ) {
        await releaseLandingQueue(ctx, held, now);
        return (await loadLanding(ctx, claim)).state;
      } else if (
        !reviewing &&
        run.status === 'failed' &&
        parkExactOnMainRed() &&
        (await parkRedOnlyEntry(ctx, claim, { row, state, attempt }, run))
      ) {
        await releaseLandingQueue(ctx, held, now);
        return (await loadLanding(ctx, claim)).state;
      } else if (!hostedCheckTerminal(run)) {
        phase = 'checking';
        if (!reviewing)
          observation = run.failureReason?.startsWith('provider-delayed:')
            ? { state: 'pending', pendingReason: 'pending-infra', cause: null }
            : landingObservation('checking');
      } else if (run.status !== 'passed') {
        if (run.status === 'failed') rememberGuardCheck(ctx, state.id, run);
        phase = 'terminal-failed';
        observation = landingObservation(run.status);
        error = {
          code: run.status === 'failed' ? 'CHECK_FAILED' : 'CHECK_NOT_PASSED',
          // A platform settlement carries its own followable reason (a7de3a93:
          // e.g. the GitHub App permission step), not "fix it in this Lane".
          message:
            run.status !== 'failed' && run.failureReason
              ? `The original exact check settled as ${run.status}. ${run.failureReason}`
              : `The original exact check settled as ${run.status}. ${await describeCheckFailure(ctx, claim.projectId, run)} ${CHECK_FAILED_NEXT}`,
        };
      } else {
        await requireHostedCheckEvidence(
          ctx,
          {
            projectId: claim.projectId,
            runId: check.runId,
            actor: attempt.actor.id,
            candidateId: attempt.crossHeadProof?.checked.id ?? attempt.candidate.id,
            head: attempt.crossHeadProof?.checked.head ?? attempt.candidate.head,
            checkId: check.checkId,
            definition: check.definition,
            configuration: check.configuration,
            environment: check.environment,
            authorityEpoch: attempt.authorityEpoch,
          },
          run,
        );
        passedAt = run.endedAt;
      }
    }
  } catch (cause) {
    // Unexpected/storage/scheduler failures abort and retain the watchdog. Only
    // structured domain outcomes settle this request, so later work can proceed.
    if (!(cause instanceof ForgeError)) throw cause;
    if (
      row.githubInboundProof &&
      attempt.crossHeadProof &&
      ['EVIDENCE_CHANGED', 'NOT_FOUND'].includes(cause.code)
    ) {
      // H14 independently rechecks the proof. Let its existing retry driver replace this
      // proof with a fresh configured check if settings or evidence changed in the queue.
      phase = 'ready';
    } else {
      phase = 'terminal-failed';
      observation = landingObservation('failed', cause.code);
      error = { code: cause.code, message: cause.message };
    }
  }
  // Its own exact check passed: suspicion from a combined failure ends here (a
  // later main-race recheck holds order and can be stacked on again), and a
  // shared failure that did not reproduce alone is reported as such.
  if (phase === 'ready' && state.batchDiagnostic) state.batchDiagnostic = passedAlone(state.batchDiagnostic);
  if (phase === 'ready')
    state.timing = {
      submittedAt: state.at,
      ...state.timing,
      settlementStartedAt: state.timing?.settlementStartedAt ?? new Date(now).toISOString(),
    };
  if (phase === 'terminal-failed')
    state.timing = { submittedAt: state.at, ...state.timing, settledAt: new Date(now).toISOString() };
  const write = {
    replay,
    ...(passedAt ? { settlement: { passedAt, startedAt: now } } : {}),
    ...(bound ? { freshProgress: true as const } : {}),
  };
  // Bound on a moved main, nothing ahead: publication could only refuse it, so its retry starts in
  // this write instead of after a ready write and that refusal (5b4b5918).
  if (
    phase === 'ready' &&
    staleOn &&
    (await retryUnheldStaleLaneProof(
      ctx,
      claim,
      held,
      { row, state: { ...state, phase, observation, error }, attempt },
      staleOn,
      now,
      write,
    ))
  ) {
    await releaseLandingQueue(ctx, held, now);
    return (await loadLanding(ctx, claim)).state;
  }
  const next = { ...state, version: state.version + 1, phase, observation, error };
  await writeLanding(ctx, row, next, false, true, undefined, write);
  if (phase === 'terminal-failed') await settleLandingOperation(ctx, next);
  await releaseLandingQueue(ctx, held, now);
  return next;
}
/** Event/startup repair for one named Channel; no project scan or empty poller. */
export async function recoverLandingQueue(ctx: MutationCtx, input: LandingChannel, now = Date.now()) {
  const queue = await landingQueue(ctx, input);
  if (!queue) return false;
  const pending = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_runnable_and_sequence', q =>
      q.eq('projectId', input.projectId).eq('channel', input.channel).eq('runnable', true),
    )
    .take(1);
  if (!pending.length && !queue.lease) return false;
  await scheduleLandingWake(
    ctx,
    queue,
    queue.lease && queue.lease.until > now ? queue.lease.until : now,
    now,
  );
  return true;
}

/** The exact check owns a place in publication order, not its worker's queue lease. */
export async function reviewCheckAhead(
  ctx: MutationCtx,
  queue: NonNullable<Awaited<ReturnType<typeof landingQueue>>>,
  row: LandingRow,
) {
  if (!queue.exactReview || queue.exactReview === row.submissionId) return null;
  const holder = await landingRow(ctx, { projectId: row.projectId, submissionId: queue.exactReview });
  invariant(holder?.exactReview, 'WORK_STALE', 'The approved check must still own its publication turn.');
  return { row: holder, until: null, held: 'approved-check' as const, footprints: 'unknown' as const };
}

/** H14's constant-size final transaction can claim a prepared request directly.
 * This does no publication and cannot replace a live competing lease. */
export async function claimReadyLanding(
  ctx: MutationCtx,
  input: LandingChannel & {
    submissionId: string;
    attemptId: string;
    owner: string;
  },
  now = Date.now(),
  watchdog = true,
): Promise<LandingClaim | { waitingFor: string; until: number | null; ahead: LandingRow } | null> {
  const queue = await landingQueue(ctx, input);
  invariant(queue, 'NOT_FOUND', 'Hosted landing queue not found.');
  const { state, row } = await loadLanding(ctx, input);
  invariant(
    state.phase === 'ready' && state.attemptId === input.attemptId,
    'WORK_STALE',
    'Select the current prepared landing attempt.',
  );
  const leased = queue.lease && queue.lease.until > now;
  if (
    leased &&
    queue.lease!.owner === input.owner &&
    queue.lease!.submissionId === input.submissionId &&
    queue.lease!.attemptId === input.attemptId
  )
    return { ...input, token: queue.lease!.token };
  // Submission order: an older live entry takes main first. The waiter keeps its
  // passed proof and no timer while parked: the older entry owns progress, and
  // its exit from the order wakes this one and arms its stall alarm in the same
  // transaction (incident c329d191: that single wake drive can be lost). An independent
  // older entry whose pass can carry never holds it (c6b81429); an unrelated one that has
  // not given up its place yet is overtaken once (7d98c7da). Each new wait is recorded
  // for the receipt (`orderWaits`).
  const spent: LandingRow[] = [];
  // A live landing reservation on files this one changes holds it first (Issue 10d253c6).
  const exactReview = await reviewCheckAhead(ctx, queue, row);
  const ahead =
    exactReview ??
    (queue.exactReview === state.id
      ? null
      : ((await reservationAhead(ctx, row, state, now)) ??
        (await olderLandingAhead(ctx, row, state, now, spent))));
  if (ahead) {
    if (row.alarm) await cancelPendingTask(ctx, row.alarm.taskId);
    // A handed entry (`orderWaitHanded`) has no wait of its own yet: this claim decides it.
    const parked = row.orderWait !== ahead.row.submissionId || row.orderWaitHanded !== undefined;
    if (parked || row.alarm)
      await ctx.db.patch(row._id, {
        orderWait: ahead.row.submissionId,
        alarm: null,
        ...(parked
          ? {
              ...closeOrderWait(row, now, false, 'claim'),
              orderWaits: recordOrderWait(row, ahead, now, queue.mainReceiptId),
              orderWaitHanded: undefined,
            }
          : {}),
        ...(parked && 'ownRisk' in ahead && ahead.ownRisk && !row.ownGlobalRisk
          ? { ownGlobalRisk: true as const }
          : {}),
      });
    if (!ahead.row.orderWaited) await ctx.db.patch(ahead.row._id, { orderWaited: true });
    // The holder waits for an entry that cannot land before it, and may not overtake it (they
    // overlap): its reservation can only deadlock (43b51a5e), so it ends now and its waiters get
    // their turn. Once per reservation: an ended reservation never closes a cycle again.
    if ('cycle' in ahead && ahead.cycle) {
      await ctx.db.patch(row._id, { reservedUntil: now });
      await wakeLandingOrderWaiters(ctx, row);
    }
    // The predecessor this entry publishes after is parked on a chain that leads back here (Item
    // 273650ab): drive its claim once, which goes ahead of the entry it waited for.
    if ('redrive' in ahead && ahead.redrive) await driveParkedWaiter(ctx, ahead.row);
    // A park that lasts a check (the holder is not about to land) never holds the Ready followers
    // handed to this entry: they get their own claim (baton, incident 43b51a5e case 2).
    if (
      parked &&
      row.orderWaited &&
      ahead.held !== 'composing' &&
      (ahead.row.phase !== 'ready' || Boolean(ahead.row.orderWait))
    )
      await passParkedFollowers(ctx, row);
    return { waitingFor: ahead.row.submissionId, until: ahead.until, ahead: ahead.row };
  }
  if (row.orderWait || row.orderWaitHanded)
    await ctx.db.patch(row._id, {
      orderWait: undefined,
      orderWaitHanded: undefined,
      ...closeOrderWait(row, now, false, 'claim'),
    });
  if (leased) return null;
  if (row.priority !== 'urgent' && queue.exactReview !== state.id) {
    const [urgent] = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_channel_and_phase_and_priority_and_sequence', q =>
        q
          .eq('projectId', input.projectId)
          .eq('channel', input.channel)
          .eq('phase', 'ready')
          .eq('priority', 'urgent'),
      )
      .order('asc')
      .take(1);
    if (urgent && !urgent.hold) {
      const selected = JSON.parse(urgent.value) as HostedLandingState;
      if (
        !selected.error &&
        selected.observation.pendingReason !== 'waiting-for-review' &&
        selected.observation.pendingReason !== 'waiting-for-dependency' &&
        !(state.batchId && state.batchId === selected.batchId)
      ) {
        // Drive an urgent entry parked on this normal claimant (review 01a38b28 F1), or one handed
        // off by a wake whose own claim has yet to decide the wait (review 57ca898f F1). Otherwise
        // an unrelated normal claimant could take the lease before the handoff recipient runs.
        // An automatic wake must be scheduled for a handed waiter to take the turn. A manual
        // request with no finish must not make an unrelated claimant keep retrying.
        // A wait already decided on another entry stays parked until its holder advances.
        if (!urgent.orderWait) return null;
        const handed = urgent.orderWaitHanded === urgent.orderWait;
        if (handed || urgent.orderWait === row.submissionId) {
          if ((await driveParkedWaiter(ctx, urgent)) || !handed) return null;
        }
      }
    }
  }
  if (queue.wake) await cancelPendingTask(ctx, queue.wake.taskId);
  const lease = {
    owner: input.owner,
    token: queue.fence + 1,
    until: now + HOSTED_LANDING_LEASE_MS,
    submissionId: input.submissionId,
    attemptId: input.attemptId,
  };
  await ctx.db.patch(queue._id, { fence: lease.token, lease, wake: null });
  // Taking main stales these entries' current check: their next one holds order.
  for (const other of spent) await ctx.db.patch(other._id, { overtaken: overtakeMark(other) });
  // Atomic explicit acceptance publishes or rolls back this lease in the same
  // mutation. Its callers need no watchdog for a gap that cannot exist.
  if (watchdog)
    await scheduleLandingWake(ctx, { ...queue, fence: lease.token, lease, wake: null }, lease.until, now);
  return { ...input, token: lease.token };
}
