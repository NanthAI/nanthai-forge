// SPDX-License-Identifier: Apache-2.0
import { providerRetryDelay } from '../src/ci-provider-recovery';
import {
  clearCiDown,
  holdOnCiDown,
  infraEnd,
  noteEnvironmentEnd,
  noteInfraEnd,
} from './projectHostedLandingCiDown';
import { environmentEndOf } from './projectHostedLandingEnvironmentHold';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { LandingClaim, requireLandingLease } from './projectHostedLandingControl';
import { enqueueHostedCheck } from './projectHostedChecks';
import { checkSetting, loadHostedCheck, writeHostedCheck } from './projectHostedCheckStore';
import { hostedAcceptGate } from './projectHostedGate';
import { parkLanding, parkOnMainRed, parkedMessage, redOnlyFailure } from './projectHostedLandingPark';
import { hostedStartMain } from './projectHostedChannels';
import { readHostedRecord } from './projectHostedRecords';
import { describeCheckFailure } from './projectHostedCheckFailure';
import { loadFinish } from './projectHostedFinishStore';
import { claimFinishPrecompose } from './projectHostedFinishPrecompose';
import { retireSoloCheck } from './projectHostedLandingStaleChecks';
import { CHECK_FAILED_NEXT } from '../src/check-failure-detail';
import {
  forkLandingAttempt,
  insertLandingAttempt,
  landingQueue,
  loadLandingAttempt,
  loadLanding,
  settleLandingOperation,
  writeLanding,
  type LandingRow,
} from './projectHostedLandingStore';
import { hostedCheckRunnerSchema, type HostedCheckRun, checkCause } from '../src/hosted-check';
import { hostedRecordSchema } from '../src/hosted-records';
import {
  landingObservation,
  type HostedLandingAttempt,
  type HostedLandingRequest,
} from '../src/hosted-landing';
import {
  HOSTED_PLATFORM_RETRIES,
  checkFailureKind,
  hostedAdmission,
  preQueueCheck,
  recordOutcome,
} from '../src/hosted-landing-admission';
import { digest } from '../src/state/hash';
import { checkReplay } from './projectHostedLandingReplay';

type Selected = Awaited<ReturnType<typeof requireLandingLease>>;
/** Stable per submission (and platform restart), so a replay reconciles the same run. */
export function admissionOperationId(submissionId: string, retry = 0) {
  const h = digest(
    retry ? `landing-admission\0${submissionId}\0${retry}` : `landing-admission\0${submissionId}`,
  );
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Arrival: run this change's own check at once, in parallel with every other
 * arrival. `admissionCheck: true` runs the selector's affected set and is
 * GitHub Actions only (the direct session honours the scoped gate). `"full"` is
 * the pre-queue Lane check: the project's configured check and gate through the
 * ordinary run path, so every runner provider is eligible (docs/pre-queue-checks.md). */
export async function startLandingAdmission(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    attempt: HostedLandingAttempt;
    request: HostedLandingRequest;
    providerDelayReason?: string;
  },
  retry = 0,
) {
  const { attempt, request } = input;
  if (!attempt.deferredCheck || !hostedAdmission(attempt.policy) || !attempt.candidate.head) return null;
  const check = request.check;
  if (check?.kind !== 'request') return null;
  const full = preQueueCheck(attempt.policy);
  if (!full) {
    const setting = await checkSetting(ctx, input.projectId, 'runner', 'runner');
    const runner = setting ? hostedCheckRunnerSchema.safeParse(JSON.parse(setting.value)) : null;
    if (!runner?.success || runner.data.provider !== 'github-actions') return null;
  }
  const { kind: _kind, ...settings } = check;
  void _kind;
  const run = await enqueueHostedCheck(ctx, {
    cause: retry ? checkCause.retry : (attempt.checkCause ?? checkCause.preQueue),
    usageSubmissions: [attempt.submissionId],
    ...(input.providerDelayReason ? { providerDelayReason: input.providerDelayReason } : {}),
    projectId: input.projectId,
    actor: attempt.actor.id,
    request: {
      ...settings,
      operationId: admissionOperationId(attempt.submissionId, retry),
      authorityEpoch: attempt.authorityEpoch,
      candidateId: attempt.candidate.id,
      expectedHead: attempt.candidate.head,
    },
  });
  // A contract-eligible member keeps its own acceptance gate, so a lone member
  // can land on this run. Everyone else runs the selector's affected set.
  if (!full && run.gate?.mode !== 'contract') {
    run.gate = { mode: 'scoped', reason: 'Landing admission: own affected set' };
    const { row } = await loadHostedCheck(ctx, { projectId: input.projectId, runId: run.id });
    await ctx.db.patch(row._id, { gate: run.gate });
    await writeHostedCheck(ctx, row._id, run);
  }
  return run.id;
}
async function recordFirstCheck(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  passed: boolean,
  environment = false,
) {
  const queue = await landingQueue(ctx, { projectId, channel: 'main' });
  // A verdict shows CI runs checks: a CI-down hold ends (nothing to do when unset). An environment
  // end already counted toward the hold (Item 0d14c456) is no verdict.
  if (!environment) await clearCiDown(ctx, queue);
  if (queue)
    await ctx.db.patch(queue._id, {
      checkHistory: { ...queue.checkHistory, first: recordOutcome(queue.checkHistory?.first, passed) },
    });
}
/** Check-completion wake for an admission run. A failing test ejects only this
 * member; a run without a failing test (platform) lets it join unadmitted. False only when it
 * parked an entry that held no queue order (fix D): nothing became runnable, so the queue needs no
 * wake for it. */
export async function settleLandingAdmission(
  ctx: MutationCtx,
  original: LandingRow,
  run: HostedCheckRun,
): Promise<boolean> {
  const { row, state } = await loadLanding(ctx, {
    projectId: original.projectId,
    submissionId: original.submissionId,
  });
  if (row.admission?.status !== 'checking' || row.admission.runId !== run.id || state.phase !== 'checking')
    return true;
  const kind = checkFailureKind(run, { conflicts: [] });
  const replay = checkReplay(run);
  const retries = row.admission.retries ?? 0;
  // An admission check that CI could not run counts toward the CI-down hold; the admission itself
  // still lets the entry join unadmitted, where its queue check holds while CI is down.
  if (holdOnCiDown() && infraEnd(run)) {
    const queue = await landingQueue(ctx, { projectId: row.projectId, channel: 'main' });
    if (queue) await noteInfraEnd(ctx, queue, run);
  }
  // Item 0d14c456: an environment end counts toward the hold. Once it trips, the entry is not judged:
  // it joins the queue unadmitted, where the hold parks it before any further dispatch.
  const environment = kind === 'tests' ? await environmentEndOf(ctx, row.projectId, run) : null;
  let environmentHeld = false;
  if (environment) {
    const queue = await landingQueue(ctx, { projectId: row.projectId, channel: 'main' });
    if (queue) environmentHeld = await noteEnvironmentEnd(ctx, queue, environment);
  }
  // Keep the run (fa2c1383, review a09af93a nit 4): a kept run checked an older main, and the elapsed
  // share the keep was for is lost with the platform's result. A restart there would pay a whole fresh
  // run plus the scoped recheck, so it retires as the main move would have, onto current main.
  if (row.admission.kept && kind === 'platform') {
    let finish = await loadFinish(ctx, { projectId: row.projectId, submissionId: state.id });
    // A running probe is detached, as the sweep's own retire does (its exact-main result stays cached).
    if (finish.value.pending?.precompose) {
      await claimFinishPrecompose(ctx, finish.row);
      finish = await loadFinish(ctx, { projectId: row.projectId, submissionId: state.id });
    }
    if (!finish.value.pending) {
      await retireSoloCheck(ctx, {
        row,
        state,
        attempt: await loadLandingAttempt(ctx, { projectId: row.projectId, attemptId: state.attemptId }),
        finish,
        main: await hostedStartMain(ctx, row.projectId),
        platformEndedAt: Date.now(),
      });
      return true;
    }
  }
  if (row.admission.full && !row.admission.kept && kind === 'platform' && retries < HOSTED_PLATFORM_RETRIES) {
    // Unknown is not red: the same Candidate checks again, still before the queue.
    const attempt = await loadLandingAttempt(ctx, { projectId: row.projectId, attemptId: state.attemptId });
    const reason = providerRetryDelay(run.failureReason);
    const runId = await startLandingAdmission(
      ctx,
      {
        projectId: row.projectId,
        attempt,
        request: state.request,
        ...(reason ? { providerDelayReason: reason } : {}),
      },
      retries + 1,
    );
    if (runId) {
      const admission = { runId, status: 'checking' as const, full: true as const, retries: retries + 1 };
      await ctx.db.patch(row._id, { admission });
      await writeLanding(
        ctx,
        { ...row, admission },
        {
          ...state,
          version: state.version + 1,
          observation: reason
            ? { state: 'pending', pendingReason: 'pending-infra', cause: null }
            : landingObservation('checking'),
          // A re-dispatched admission is progress: no false still-stalled alert (a7de3a93).
          timing: { submittedAt: state.at, ...state.timing, ciProgressAt: new Date().toISOString() },
        },
        false,
        true,
        undefined,
        { replay },
      );
      return true;
    }
  }
  // Fix D (Item 687d1eda, FORGE_QUEUE_PARK_ON_MAIN_RED): failing only on main's own red tests is
  // not this change's failure. Unjudged, like a platform result, it waits under the main-red hold;
  // releaseMainHolds puts it back in the queue on green, where its ordinary check runs.
  const parked =
    kind === 'tests' && !environmentHeld && parkOnMainRed()
      ? await redOnlyFailure(
          ctx,
          row.projectId,
          await loadLandingAttempt(ctx, { projectId: row.projectId, attemptId: state.attemptId }),
          run,
        )
      : null;
  if (parked) {
    const admission = {
      ...(row.admission.full ? { full: true as const, ...(retries ? { retries } : {}) } : {}),
      runId: run.id,
      status: 'unavailable' as const,
      endedAt: Date.now(),
    };
    await ctx.db.patch(row._id, { admission });
    const next = {
      ...state,
      version: state.version + 1,
      phase: 'queued' as const,
      ...(run.testFiles ? { testFiles: run.testFiles } : {}),
      observation: landingObservation('queued'),
      error: { code: 'MAIN_RED', message: parkedMessage(parked.files) },
    };
    await parkLanding(ctx, { ...row, admission }, next, 'main-red', {
      replay: { ...replay, recheckCause: { kind: 'audit', link: parked.auditRunId } },
    });
    // A kept run (fa2c1383) held queue order, so a follower may be stacked behind it with no run of
    // its own: the park releases that place, and the queue tick lets the follower go on.
    return Boolean(row.admission.kept);
  }
  // A kept run settles here like any admission (review 563c595b F3c): its first check is recorded
  // below, and installFinishCompose names why it did not carry. Only a test verdict retains `kept`.
  const settled = environmentHeld ? 'platform' : kind;
  const admission = {
    ...(row.admission.full ? { full: true as const, ...(retries ? { retries } : {}) } : {}),
    ...(row.admission.kept && settled !== 'platform' ? { kept: true as const } : {}),
    runId: run.id,
    status:
      settled === 'passed'
        ? ('passed' as const)
        : settled === 'tests'
          ? ('failed' as const)
          : ('unavailable' as const),
    endedAt: Date.now(),
  };
  await ctx.db.patch(row._id, { admission });
  if (settled !== 'platform')
    await recordFirstCheck(ctx, row.projectId, settled === 'passed', Boolean(environment));
  const detail = settled === 'tests' ? await describeCheckFailure(ctx, row.projectId, run) : '';
  const next =
    settled === 'tests'
      ? {
          ...state,
          version: state.version + 1,
          phase: 'terminal-failed' as const,
          ...(run.testFiles ? { testFiles: run.testFiles } : {}),
          ...(run.endedAt && run.execution
            ? { counts: { ...state.counts, runnerSeconds: Math.round(run.execution.seconds) } }
            : {}),
          observation: landingObservation('failed', 'CHECK_FAILED'),
          error: {
            code: 'CHECK_FAILED',
            message: `The admission check of this change alone failed; it did not join a batch. ${detail} ${CHECK_FAILED_NEXT}`,
          },
        }
      : {
          ...state,
          version: state.version + 1,
          phase: 'queued' as const,
          observation: landingObservation('queued'),
          error: null,
        };
  await writeLanding(ctx, { ...row, admission }, next, settled !== 'tests', true, undefined, { replay });
  if (settled === 'tests') await settleLandingOperation(ctx, next);
  return true;
}
/** The exact admission run, when it is still acceptance evidence for this
 * attempt on current main. Never re-runs admission. `movedMain` keeps a run
 * checked on an older main: publication then refuses it with CHANNEL_CHANGED
 * and only the conservative-impact proof can carry it to the new main. */
export async function admissionProof(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  row: LandingRow,
  attempt: HostedLandingAttempt,
  movedMain = false,
) {
  if (row.admission?.status !== 'passed' || !attempt.candidate.head) return null;
  const { run } = await loadHostedCheck(ctx, { projectId, runId: row.admission.runId });
  const main = await hostedStartMain(ctx, projectId);
  if (
    run.status !== 'passed' ||
    run.request.candidateId !== attempt.candidate.id ||
    run.request.expectedHead !== attempt.candidate.head ||
    run.request.authorityEpoch !== attempt.authorityEpoch ||
    (!movedMain && (main.head !== attempt.main.head || main.receipt.id !== attempt.main.receiptId))
  )
    return null;
  const project = await ctx.db.get(projectId);
  const record = await readHostedRecord(ctx, {
    projectId,
    actor: attempt.actor.id,
    kind: 'candidate',
    key: attempt.candidate.id,
  });
  if (!project || record?.digest !== attempt.candidate.digest) return null;
  const candidate = hostedRecordSchema.options[3].parse(JSON.parse(record.value));
  if ((await hostedAcceptGate(ctx, project, candidate, attempt.actor, run)) !== 'pass') return null;
  return {
    runId: run.id,
    checkId: run.check.id,
    definition: run.check.definition,
    configuration: run.request.expectedConfiguration,
    environment: run.request.expectedEnvironment,
  };
}
/** Selection of one admitted member without enough peers for a cohort.
 * `held`: an earlier peer is still admitting, so it waits (not runnable) for
 * that settle to form a cohort. `adopted`: alone, it lands on its own admission
 * run. Null: today's individual path (recompose on a moved main, or its own check). */
export async function loneAdmission(ctx: MutationCtx, claim: LandingClaim, selected: Selected) {
  const { row, attempt } = selected;
  // Pre-queue members already tried their own run (admittedReuseFirst); a 22-minute
  // peer admission is too long to hold for, so they keep the ordinary path.
  if (!hostedAdmission(attempt.policy) || !row.batchable || !row.admission || row.admission.full) return null;
  const [peer] = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_admitting_and_sequence', q =>
      q.eq('projectId', claim.projectId).eq('channel', 'main').eq('admitting', true),
    )
    .order('asc')
    .take(1);
  // Wait only for peers that were already admitting when this admission ended,
  // so a steady stream of new arrivals can never hold a member indefinitely.
  if (
    attempt.policy.acceptance.batchMaxSize !== 1 &&
    peer &&
    Date.parse(JSON.parse(peer.value).at) <= (row.admission.endedAt ?? Date.now())
  ) {
    await ctx.db.patch(row._id, { runnable: false });
    return 'held' as const;
  }
  const proof = await admissionProof(ctx, claim.projectId, row, attempt);
  if (proof) {
    await bindAdmissionProof(ctx, selected, attempt, proof);
    return 'adopted' as const;
  }
  return null;
}
/** Pre-queue reuse first, once per admission: an admitted change lands on its own
 * Lane run before any cohort forms. On unchanged main that run is exact evidence.
 * On a moved main the bound run is refused at publication (CHANNEL_CHANGED), and
 * the existing finish retry either carries it by the conservative-impact proof
 * or recomposes on current main with a deferred check, which joins a cohort for
 * one combined check. No new run or provider call here. */
export async function admittedReuseFirst(ctx: MutationCtx, selected: Selected) {
  const { row, attempt } = selected;
  if (
    !preQueueCheck(attempt.policy) ||
    !row.admission?.full ||
    row.admission.status !== 'passed' ||
    row.admission.reuse
  )
    return false;
  const admission = { ...row.admission, reuse: 'tried' as const };
  await ctx.db.patch(row._id, { admission });
  const tried = { ...selected, row: { ...row, admission } };
  const proof = await admissionProof(ctx, row.projectId, tried.row, attempt, true);
  if (!proof) return false;
  await bindAdmissionProof(ctx, tried, attempt, proof);
  return true;
}
/** Bind a held admission proof as the exact check of a new attempt pinned to
 * the member's own Candidate; the next queue tick evaluates it like any passed
 * run. No new run, compose or provider call. */
export async function bindAdmissionProof(
  ctx: MutationCtx,
  selected: Pick<Selected, 'row' | 'state' | 'attempt'>,
  original: HostedLandingAttempt,
  check: NonNullable<HostedLandingAttempt['check']>,
) {
  const { row, state, attempt } = selected;
  const {
    deferredCheck: _deferred,
    memberCandidate: _member,
    recheckReason: _reason,
    forkReason: _fork,
    scopedFallback: _scoped,
    ...pins
  } = original;
  void _deferred;
  void [_member, _reason, _fork, _scoped];
  const next = {
    ...pins,
    operations: {
      ...pins.operations,
      ...(attempt.id !== original.id ? { accept: crypto.randomUUID() } : {}),
    },
    // The queue binds the held proof without a recheck.
    ...(await forkLandingAttempt(ctx, state, { kind: 'check-binding', link: check.runId })),
    check,
  };
  await insertLandingAttempt(ctx, next);
  return writeLanding(
    ctx,
    row,
    {
      ...state,
      version: state.version + 1,
      attemptId: next.id,
      phase: 'queued',
      observation: landingObservation('queued'),
      error: null,
    },
    true,
  );
}
