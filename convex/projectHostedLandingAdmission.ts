// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { LandingClaim, requireLandingLease } from './projectHostedLandingControl';
import { enqueueHostedCheck } from './projectHostedChecks';
import { checkSetting, loadHostedCheck, writeHostedCheck } from './projectHostedCheckStore';
import { hostedAcceptGate } from './projectHostedGate';
import { hostedStartMain } from './projectHostedChannels';
import { readHostedRecord } from './projectHostedRecords';
import {
  insertLandingAttempt,
  landingQueue,
  loadLanding,
  settleLandingOperation,
  writeLanding,
  type LandingRow,
} from './projectHostedLandingStore';
import { hostedCheckRunnerSchema, type HostedCheckRun } from '../src/hosted-check';
import { hostedRecordSchema } from '../src/hosted-records';
import {
  landingObservation,
  type HostedLandingAttempt,
  type HostedLandingRequest,
} from '../src/hosted-landing';
import { checkFailureKind, hostedAdmission, recordOutcome } from '../src/hosted-landing-admission';
import { digest } from '../src/portable-hash';

type Selected = Awaited<ReturnType<typeof requireLandingLease>>;
/** Stable per submission, so a replayed enqueue reconciles the same run. */
export function admissionOperationId(submissionId: string) {
  const h = digest(`landing-admission\0${submissionId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Arrival: run this change's own affected set at once, in parallel with every
 * other arrival. GitHub Actions only: the direct session honours the scoped
 * gate; the credential adapter keeps its configured command. Other runners
 * would run a full suite per member, so they keep today's path. */
export async function startLandingAdmission(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    attempt: HostedLandingAttempt;
    request: HostedLandingRequest;
  },
) {
  const { attempt, request } = input;
  if (!attempt.deferredCheck || !hostedAdmission(attempt.policy) || !attempt.candidate.head) return null;
  const check = request.check;
  if (check?.kind !== 'request') return null;
  const setting = await checkSetting(ctx, input.projectId, 'runner', 'runner');
  const runner = setting ? hostedCheckRunnerSchema.safeParse(JSON.parse(setting.value)) : null;
  if (!runner?.success || runner.data.provider !== 'github-actions') return null;
  const { kind: _kind, ...settings } = check;
  void _kind;
  const run = await enqueueHostedCheck(ctx, {
    projectId: input.projectId,
    actor: attempt.actor.id,
    request: {
      ...settings,
      operationId: admissionOperationId(attempt.submissionId),
      authorityEpoch: attempt.authorityEpoch,
      candidateId: attempt.candidate.id,
      expectedHead: attempt.candidate.head,
    },
  });
  // A contract-eligible member keeps its own acceptance gate, so a lone member
  // can land on this run. Everyone else runs the selector's affected set.
  if (run.gate?.mode !== 'contract') {
    run.gate = { mode: 'scoped', reason: 'Landing admission: own affected set' };
    const { row } = await loadHostedCheck(ctx, { projectId: input.projectId, runId: run.id });
    await ctx.db.patch(row._id, { gate: run.gate });
    await writeHostedCheck(ctx, row._id, run);
  }
  return run.id;
}
async function recordFirstCheck(ctx: MutationCtx, projectId: Id<'hostedProjects'>, passed: boolean) {
  const queue = await landingQueue(ctx, { projectId, channel: 'main' });
  if (queue)
    await ctx.db.patch(queue._id, {
      checkHistory: { ...queue.checkHistory, first: recordOutcome(queue.checkHistory?.first, passed) },
    });
}
/** Check-completion wake for an admission run. A failing test ejects only this
 * member; a run without a failing test (platform) lets it join unadmitted. */
export async function settleLandingAdmission(ctx: MutationCtx, original: LandingRow, run: HostedCheckRun) {
  const { row, state } = await loadLanding(ctx, {
    projectId: original.projectId,
    submissionId: original.submissionId,
  });
  if (row.admission?.status !== 'checking' || row.admission.runId !== run.id || state.phase !== 'checking')
    return;
  const kind = checkFailureKind(run, { conflicts: [] });
  const admission = {
    runId: run.id,
    status:
      kind === 'passed'
        ? ('passed' as const)
        : kind === 'tests'
          ? ('failed' as const)
          : ('unavailable' as const),
    endedAt: Date.now(),
  };
  await ctx.db.patch(row._id, { admission });
  if (kind !== 'platform') await recordFirstCheck(ctx, row.projectId, kind === 'passed');
  const failed = run.testFiles?.failed.map(file => file.file) ?? [];
  const next =
    kind === 'tests'
      ? {
          ...state,
          version: state.version + 1,
          phase: 'terminal-failed' as const,
          ...(run.testFiles ? { testFiles: run.testFiles } : {}),
          observation: landingObservation('failed', 'CHECK_FAILED'),
          error: {
            code: 'CHECK_FAILED',
            message: `The admission check of this change alone failed; it did not join a batch.${failed.length ? ' Failing tests: ' + failed.join(', ') : ''}`,
          },
        }
      : {
          ...state,
          version: state.version + 1,
          phase: 'queued' as const,
          observation: landingObservation('queued'),
          error: null,
        };
  await writeLanding(ctx, { ...row, admission }, next, kind !== 'tests');
  if (kind === 'tests') await settleLandingOperation(ctx, next);
}
/** The exact admission run, when it is still acceptance evidence for this
 * attempt on current main. Never re-runs admission. */
export async function admissionProof(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  row: LandingRow,
  attempt: HostedLandingAttempt,
) {
  if (row.admission?.status !== 'passed' || !attempt.candidate.head) return null;
  const { run } = await loadHostedCheck(ctx, { projectId, runId: row.admission.runId });
  const main = await hostedStartMain(ctx, projectId);
  if (
    run.status !== 'passed' ||
    run.request.candidateId !== attempt.candidate.id ||
    run.request.expectedHead !== attempt.candidate.head ||
    run.request.authorityEpoch !== attempt.authorityEpoch ||
    main.head !== attempt.main.head ||
    main.receipt.id !== attempt.main.receiptId
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
  if (!hostedAdmission(attempt.policy) || !row.batchable || !row.admission) return null;
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
  const { deferredCheck: _deferred, memberCandidate: _member, ...pins } = original;
  void _deferred;
  void _member;
  const next = {
    ...pins,
    operations: {
      ...pins.operations,
      ...(attempt.id !== original.id ? { accept: crypto.randomUUID() } : {}),
    },
    id: crypto.randomUUID(),
    parentAttemptId: attempt.id,
    number: attempt.number + 1,
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
