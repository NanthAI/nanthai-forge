// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { BatchFailure } from '../src/hosted-batch-diagnosis';
import type { HostedCheckRun } from '../src/hosted-check';
import { landingObservation, type HostedLandingAttempt } from '../src/hosted-landing';
import { HOSTED_PLATFORM_RETRIES, recordOutcome, splitGroups } from '../src/hosted-landing-admission';
import { batchMemberDiagnostic } from '../src/hosted-batch-diagnosis';
import {
  enqueueBatchCheck,
  installBatchAttempt,
  retryLandingBatch,
  wakeBatch,
  writeBatch,
  batchSchema,
  type BatchIdentity,
  type LandingBatch,
} from './projectHostedLandingBatchStore';
import {
  landingQueue,
  loadLanding,
  loadLandingAttempt,
  settleLandingOperation,
  writeLanding,
} from './projectHostedLandingStore';
import { admissionProof, bindAdmissionProof } from './projectHostedLandingAdmission';
import { loadFinish } from './projectHostedFinishStore';
import { reserveFinishRetry } from './projectHostedFinishCompose';
import { hostedStartMain } from './projectHostedChannels';
import { invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';

/** One small queue write per settled shared check sizes later cohorts. */
export async function recordCohortOutcome(
  ctx: MutationCtx,
  input: BatchIdentity,
  batch: LandingBatch,
  passed: boolean,
) {
  const queue = await landingQueue(ctx, { projectId: input.projectId, channel: 'main' });
  if (!queue) return;
  const kind = batch.admitted ? 'admitted' : 'first';
  await ctx.db.patch(queue._id, {
    checkHistory: { ...queue.checkHistory, [kind]: recordOutcome(queue.checkHistory?.[kind], passed) },
  });
}
async function pendingMembers(ctx: MutationCtx, input: BatchIdentity, batch: LandingBatch) {
  const included = batch.members.filter(m => !batch.included || batch.included.includes(m.submissionId));
  const loaded = await Promise.all(
    included.map(async original => ({
      original,
      ...(await loadLanding(ctx, { projectId: input.projectId, submissionId: original.submissionId })),
    })),
  );
  return loaded.filter(member => member.state.phase !== 'landed' && member.state.phase !== 'terminal-failed');
}
/** A failed cohort (its tests failed, or it could not compose) retires into
 * groups that check at the same time: members the retained diagnosis names as
 * likely check alone, the rest compose together; with no attribution, two
 * halves. A group of one lands on its held admission proof when that is still
 * exact evidence on current main. Other groups of one share one serial
 * individual line (likely members last), so one landing never forces every
 * other single to recheck. Admission is never re-run. A cohort that lands
 * second meets the moved main and rechecks on main including the first. */
export async function splitLandingBatch(
  ctx: MutationCtx,
  input: BatchIdentity,
  batch: LandingBatch,
  failure?: BatchFailure,
) {
  const pending = await pendingMembers(ctx, input, batch);
  await writeBatch(ctx, input, { ...batch, phase: 'split', ...(failure ? { failure } : {}) });
  const at = new Date(Date.now()).toISOString();
  const likely = new Set(failure?.suspects ?? []);
  const singles: typeof pending = [];
  const child = (members: typeof pending, phase: 'composing' | 'checking'): LandingBatch => ({
    id: crypto.randomUUID(),
    parentId: batch.id,
    leaderId: members[0]!.state.id,
    at,
    composeOperationId: crypto.randomUUID(),
    checkOperationId: crypto.randomUUID(),
    phase,
    members: members.map(member => member.original),
    ...(batch.admitted !== undefined ? { admitted: batch.admitted } : {}),
    uploadIndex: 0,
  });
  const insert = async (
    next: LandingBatch,
    members: typeof pending,
    state: (member: (typeof pending)[number]) => object,
  ) => {
    await ctx.db.insert('projectHostedLandingBatches', {
      projectId: input.projectId,
      batchId: next.id,
      composeOperationId: next.composeOperationId,
      value: canonicalPayload(batchSchema.parse(next)),
    });
    for (const member of members)
      await writeLanding(
        ctx,
        member.row,
        { ...member.state, ...state(member), batchId: next.id, version: member.state.version + 1 },
        false,
      );
  };
  for (const group of splitGroups(pending, member => likely.has(member.state.id))) {
    if (group.length === 1) {
      if (!(await adoptAdmission(ctx, input, batch, group[0]!))) singles.push(group[0]!);
      continue;
    }
    const cohort = child(group, 'composing');
    await insert(cohort, group, member => ({
      batchDiagnostic: batchMemberDiagnostic(batch.memberDetails ?? [], failure, member.state, null, 'split'),
      phase: 'queued',
      observation: landingObservation('queued'),
      error: null,
      timing: { submittedAt: member.state.at, ...member.state.timing, selectedAt: at },
    }));
    await wakeBatch(ctx, { projectId: input.projectId, batchId: cohort.id });
  }
  if (!singles.length) return;
  if (singles.length === 1)
    return checkAlone(ctx, input, { ...batch, ...(failure ? { failure } : {}) }, singles[0]!);
  // The existing individual fallback: serial, likely members last, retained
  // per-member diagnosis and the same release and stall repair paths.
  const line = {
    ...child(singles, 'checking'),
    ...(batch.memberDetails
      ? {
          memberDetails: batch.memberDetails.filter(detail =>
            singles.some(member => member.state.id === detail.submissionId),
          ),
        }
      : {}),
    ...(failure ? { failure } : {}),
  };
  await insert(line, singles, () => ({}));
  await writeBatch(ctx, { projectId: input.projectId, batchId: line.id }, { ...line, phase: 'fallback' });
}
/** The only single of a split recomposes and checks alone on current main. */
async function checkAlone(
  ctx: MutationCtx,
  input: BatchIdentity,
  batch: LandingBatch,
  member: Awaited<ReturnType<typeof pendingMembers>>[number],
) {
  const { batchId: _batch, batchNeedsSoloCompose: _needs, ...state } = member.state;
  void _batch;
  void _needs;
  await writeLanding(
    ctx,
    member.row,
    {
      ...state,
      batchOriginId: batch.id,
      batchSolo: true,
      batchDiagnostic: batchMemberDiagnostic(batch.memberDetails ?? [], batch.failure, state, null, 'split'),
      version: state.version + 1,
      phase: 'queued',
      observation: landingObservation('queued'),
      error: null,
    },
    false,
  );
  const finish = await loadFinish(ctx, { projectId: input.projectId, submissionId: state.id });
  if (!finish.value.pending) await reserveFinishRetry(ctx, finish.row, finish.value, 'BATCH_FALLBACK');
}
/** A group of one with exact admission evidence on current main lands on it. */
async function adoptAdmission(
  ctx: MutationCtx,
  input: BatchIdentity,
  batch: LandingBatch,
  member: Awaited<ReturnType<typeof pendingMembers>>[number],
) {
  const proof = await admissionProof(ctx, input.projectId, member.row, member.original);
  if (!proof) return false;
  const { batchId: _batch, batchNeedsSoloCompose: _needs, ...rest } = member.state;
  void _batch;
  void _needs;
  const attempt = await loadLandingAttempt(ctx, {
    projectId: input.projectId,
    attemptId: member.state.attemptId,
  });
  await bindAdmissionProof(
    ctx,
    { row: member.row, state: { ...rest, batchOriginId: batch.id, batchSolo: true }, attempt },
    member.original,
    proof,
  );
  return true;
}
/** A shared check that failed without a failing test keeps its cohort: the same
 * members check again (recomposing only if main moved). No member goes solo. */
export async function retryLandingBatchCheck(
  ctx: MutationCtx,
  input: BatchIdentity,
  batch: LandingBatch,
  shared: HostedLandingAttempt,
  run: HostedCheckRun,
) {
  const retries = (batch.platformRetries ?? 0) + 1;
  if (retries > HOSTED_PLATFORM_RETRIES) return failLandingBatchPlatform(ctx, input, batch, run);
  const pending = await pendingMembers(ctx, input, batch);
  if (!pending.length) return writeBatch(ctx, input, { ...batch, phase: 'landed' });
  const main = await hostedStartMain(ctx, input.projectId);
  if (main.head !== shared.main.head || main.receipt.id !== shared.main.receiptId) {
    if (pending.length === batch.members.length)
      return retryLandingBatch(ctx, input, { ...batch, platformRetries: retries });
    return splitLandingBatch(ctx, input, batch);
  }
  const settings = (
    await loadFinish(ctx, { projectId: input.projectId, submissionId: batch.leaderId ?? batch.id })
  ).value.check;
  invariant(
    settings?.kind === 'request' && shared.candidate.head,
    'SOURCE_UNAVAILABLE',
    'A batch needs the original exact check settings.',
  );
  const { kind: _kind, ...check } = settings;
  void _kind;
  const checkOperationId = crypto.randomUUID();
  const next = await enqueueBatchCheck(ctx, {
    projectId: input.projectId,
    actor: shared.actor.id,
    request: {
      ...check,
      operationId: checkOperationId,
      authorityEpoch: batch.members[0]!.authorityEpoch,
      candidateId: shared.candidate.id,
      expectedHead: shared.candidate.head,
    },
  });
  for (const member of pending)
    await installBatchAttempt(ctx, {
      projectId: input.projectId,
      original: member.original,
      main: shared.main,
      checkOperationId,
      candidate: shared.candidate,
      check: {
        runId: next.id,
        checkId: next.check.id,
        definition: next.check.definition,
        configuration: next.request.expectedConfiguration,
        environment: next.request.expectedEnvironment,
      },
    });
  await writeBatch(ctx, input, {
    ...batch,
    checkOperationId,
    runId: next.id,
    platformRetries: retries,
    phase: 'checking',
  });
}
/** Retries exhausted: settle members with the platform error. A resubmit is a
 * new submission that re-derives batch eligibility; nothing inherits batchSolo. */
async function failLandingBatchPlatform(
  ctx: MutationCtx,
  input: BatchIdentity,
  batch: LandingBatch,
  run: HostedCheckRun,
) {
  const pending = await pendingMembers(ctx, input, batch);
  await writeBatch(ctx, input, { ...batch, phase: 'failed' });
  for (const member of pending) {
    const { batchId: _batch, ...state } = member.state;
    void _batch;
    const next = {
      ...state,
      batchOriginId: batch.id,
      version: state.version + 1,
      phase: 'terminal-failed' as const,
      observation: landingObservation('failed', 'CHECK_NOT_PASSED'),
      error: {
        code: 'CHECK_NOT_PASSED',
        message: `The shared check settled as ${run.status} without a failing test ${HOSTED_PLATFORM_RETRIES + 1} times (runner or platform). Resubmit to retry.`,
      },
    };
    await writeLanding(ctx, member.row, next, false);
    await settleLandingOperation(ctx, next);
  }
}
