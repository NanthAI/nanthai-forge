// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { loadCompose } from './projectHostedComposeStore';
import {
  loadLanding,
  loadLandingAttempt,
  writeLanding,
  settleLandingOperation,
  type LandingIdentity,
} from './projectHostedLandingStore';
import { finishRow, scheduleFinish } from './projectHostedFinishWake';
import { hostedFinishSchema, type HostedFinish } from '../src/hosted-finish';
import { landingObservation, type HostedLandingState } from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
export async function loadFinish(ctx: MutationCtx | QueryCtx, input: LandingIdentity) {
  const row = await finishRow(ctx, input);
  invariant(row, 'NOT_FOUND', 'Hosted finish request not found.');
  const value = hostedFinishSchema.parse(JSON.parse(row.value));
  invariant(
    row.composeOperationId === (value.pending?.operations.compose ?? null),
    'SOURCE_UNAVAILABLE',
    'Finish source phase identity differs.',
  );
  return { row, value };
}
export async function writeFinish(ctx: MutationCtx, row: Doc<'projectHostedFinishes'>, value: HostedFinish) {
  await ctx.db.patch(row._id, {
    value: canonicalPayload(hostedFinishSchema.parse(value)),
    composeOperationId: value.pending?.operations.compose ?? null,
  });
}
export async function initializeFinish(ctx: MutationCtx, state: HostedLandingState) {
  if (!state.request.finish) return;
  const input = { projectId: state.projectId as LandingIdentity['projectId'], submissionId: state.id };
  const old = await finishRow(ctx, input);
  if (old) {
    if (!['terminal-failed', 'landed'].includes(state.phase)) await scheduleFinish(ctx, old);
    return;
  }
  const original = await loadCompose(ctx, {
    projectId: input.projectId,
    actor: state.actor,
    operationId: state.request.finish.composeOperationId,
  });
  const result = original.operation.terminal?.outcome;
  invariant(
    original.state.status === 'completed' &&
      result?.status === 'completed' &&
      (result.result as { id?: string }).id === state.request.candidateId,
    'WORK_OPERATION_CHANGED',
    'Finish selects the original completed composition, including its exact ordered pages.',
  );
  const attempt = await loadLandingAttempt(ctx, {
    projectId: input.projectId,
    attemptId: state.firstAttemptId,
  });
  invariant(
    canonicalPayload(original.state.request.inputs.root) === canonicalPayload(attempt.candidate.inputs) &&
      canonicalPayload(original.state.request.dependencies.root) ===
        canonicalPayload(attempt.candidate.dependencies),
    'WORK_OPERATION_CHANGED',
    'Finish selection differs from its original Candidate.',
  );
  const after = state.request.finish.after;
  if (after) await loadLanding(ctx, { projectId: input.projectId, submissionId: after });
  const check = attempt.check
    ? {
        kind: 'request' as const,
        checkId: attempt.check.checkId,
        expectedDefinition: attempt.check.definition,
        expectedConfiguration: attempt.check.configuration,
        expectedEnvironment: attempt.check.environment,
      }
    : null;
  const id = await ctx.db.insert('projectHostedFinishes', {
    ...input,
    composeOperationId: null,
    parentSubmissionId: after,
    waiting: after !== null,
    wake: null,
    value: canonicalPayload(
      hostedFinishSchema.parse({ source: original.state.request, check, pending: null }),
    ),
  });
  await scheduleFinish(ctx, (await ctx.db.get(id))!);
}
export async function failFinish(ctx: MutationCtx, input: LandingIdentity, code: string, message: string) {
  const { row, state } = await loadLanding(ctx, input);
  if (state.phase === 'landed' || state.phase === 'terminal-failed') return;
  const next = {
    ...state,
    version: state.version + 1,
    phase: 'terminal-failed' as const,
    observation: landingObservation(code === 'COMPOSITION_CONFLICT' ? 'conflict' : 'failed', code),
    error: { code, message },
  };
  await writeLanding(ctx, row, next, false);
  await settleLandingOperation(ctx, next);
}
