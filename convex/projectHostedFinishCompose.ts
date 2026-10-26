// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { hostedStartMain } from './projectHostedChannels';
import { beginHostedOperation } from './projectHostedOperations';
import { composeRow, loadCompose, type ComposeState } from './projectHostedComposeStore';
import { saveObject } from './projectHostedSaveStore';
import {
  loadLanding,
  loadLandingAttempt,
  insertLandingAttempt,
  writeLanding,
  retainLandingProgress,
  type LandingIdentity,
} from './projectHostedLandingStore';
import { pinLandingAttempt } from './projectHostedLandingPins';
import { wakeLandingQueue } from './projectHostedLandingWake';
import { writeFinish, failFinish } from './projectHostedFinishStore';
import { scheduleFinish } from './projectHostedFinishWake';
import { hostedFinishBackoff, type HostedFinish } from '../src/hosted-finish';
import { hostedRecordSchema } from '../src/hosted-records';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { landingObservation } from '../src/hosted-landing';
import { invariant } from '../src/errors';
/** A main race is not a retry of the old request or a reusable check. Retain a
 * named child before IO, yield with bounded backoff, and resume that child only. */
export async function reserveFinishRetry(
  ctx: MutationCtx,
  row: Doc<'projectHostedFinishes'>,
  value: HostedFinish,
) {
  invariant(!value.pending, 'WORK_STALE', 'Resume the already pending finish attempt.');
  const input = { projectId: row.projectId, submissionId: row.submissionId };
  const { row: landing, state } = await loadLanding(ctx, input);
  const previous = await loadLandingAttempt(ctx, { projectId: row.projectId, attemptId: state.attemptId });
  const main = await hostedStartMain(ctx, row.projectId);
  const pending = {
    id: crypto.randomUUID(),
    parentAttemptId: previous.id,
    number: previous.number + 1,
    at: new Date().toISOString(),
    main: { head: main.head, receiptId: main.receipt.id },
    operations: { compose: crypto.randomUUID(), check: crypto.randomUUID(), accept: crypto.randomUUID() },
  };
  await retainLandingProgress(ctx, state, true);
  await writeFinish(ctx, row, { ...value, pending });
  await writeLanding(
    ctx,
    landing,
    { ...state, version: state.version + 1, observation: landingObservation('queued'), error: null },
    false,
  );
  const current = (await ctx.db.get(row._id))!;
  await scheduleFinish(ctx, current, hostedFinishBackoff(pending.number));
}
/** Reuse trusted immutable selection roots, never re-read current Lane heads.
 * H08 already staged these pages and validated every entry before its first job. */
export async function prepareFinishCompose(ctx: MutationCtx, input: LandingIdentity, value: HostedFinish) {
  const { state } = await loadLanding(ctx, input),
    pending = value.pending!;
  const auth = { projectId: input.projectId, actor: state.actor, operationId: pending.operations.compose };
  const old = await composeRow(ctx, auth);
  if (old) return loadCompose(ctx, auth);
  const request = { ...value.source, operationId: auth.operationId, expectedMain: pending.main };
  const expected = { authorityEpoch: request.authorityEpoch, ...request.expectedMain };
  const prepared = await beginHostedOperation(ctx, {
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
      ids: { candidate: crypto.randomUUID(), job: crypto.randomUUID(), jobOperation: crypto.randomUUID() },
    },
  });
  invariant(!prepared.replayed, 'SOURCE_UNAVAILABLE', 'The pending source operation lost its composition.');
  const stateValue: ComposeState = {
    request,
    main: await saveObject(ctx, input.projectId, { sha256: pending.main.head }),
    inputs: { next: null, pages: request.inputs.pages, count: request.inputs.count },
    dependencies: { next: null, pages: request.dependencies.pages, count: request.dependencies.count },
    candidateId: prepared.operation.firstAttempt.ids.candidate!,
    jobOperationId: prepared.operation.firstAttempt.ids.jobOperation!,
    status: 'ready',
  };
  await ctx.db.insert('projectHostedComposes', {
    ...auth,
    jobId: prepared.operation.firstAttempt.ids.job!,
    value: canonicalPayload(stateValue),
  });
  return loadCompose(ctx, auth);
}
export async function installFinishCompose(
  ctx: MutationCtx,
  row: Doc<'projectHostedFinishes'>,
  value: HostedFinish,
) {
  const input = { projectId: row.projectId, submissionId: row.submissionId };
  const { row: landing, state } = await loadLanding(ctx, input),
    pending = value.pending!;
  const source = await loadCompose(ctx, {
    projectId: row.projectId,
    actor: state.actor,
    operationId: pending.operations.compose,
  });
  const terminal = source.operation.terminal;
  invariant(terminal, 'WORK_STALE', 'Wait for the original source job to settle.');
  if (terminal.outcome.status === 'failed') {
    await failFinish(ctx, input, terminal.outcome.error.code, terminal.outcome.error.message);
    return;
  }
  const candidate = hostedRecordSchema.parse(terminal.outcome.result);
  invariant(
    candidate.kind === 'candidate' &&
      candidate.id === source.state.candidateId &&
      canonicalPayload(candidate.inputs) === canonicalPayload(value.source.inputs.root) &&
      canonicalPayload(candidate.dependencies) === canonicalPayload(value.source.dependencies.root),
    'WORK_OPERATION_CHANGED',
    'The named recompose changed the original exact selection.',
  );
  const original = await loadLandingAttempt(ctx, {
    projectId: row.projectId,
    attemptId: state.firstAttemptId,
  });
  const attempt = await pinLandingAttempt(ctx, {
    ...input,
    actor: original.actor,
    request: {
      ...state.request,
      expectedMain: pending.main,
      candidateId: candidate.id,
      expectedHead: candidate.result.status === 'clean' ? candidate.result.head : null,
      check: value.check,
    },
    attemptId: pending.id,
    parentAttemptId: pending.parentAttemptId,
    number: pending.number,
    at: pending.at,
    operations: { check: pending.operations.check, accept: pending.operations.accept },
    retainedSelection: original.candidate,
  });
  await insertLandingAttempt(ctx, attempt);
  await writeFinish(ctx, row, { ...value, pending: null });
  await writeLanding(
    ctx,
    landing,
    {
      ...state,
      version: state.version + 1,
      attemptId: attempt.id,
      phase: 'queued',
      timing: { submittedAt: state.at, composeStartedAt: pending.at, composedAt: new Date().toISOString() },
      observation: landingObservation('queued'),
      error: null,
    },
    true,
  );
  await wakeLandingQueue(ctx, { projectId: row.projectId, channel: 'main' });
}
