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
import { readHostedRecord } from './projectHostedRecords';
import { hostedRecordSchema } from '../src/hosted-records';
import { wakeLandingQueue } from './projectHostedLandingWake';
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
  const attempt = await loadLandingAttempt(ctx, {
    projectId: input.projectId,
    attemptId: state.firstAttemptId,
  });
  let source = state.request.finish.reviewedSource;
  let restoreBases: HostedFinish['restoreBases'];
  let recoveryRunId: string | undefined;
  if (source) {
    // Browser approval selects the canonical Candidate, irrespective of who
    // composed it. Supplied manifests cannot substitute different source roots.
    invariant(attempt.actor.kind === 'person', 'BAD_ARGUMENT', 'Reviewed source is a person selection.');
    const row = await readHostedRecord(ctx, {
      projectId: input.projectId,
      actor: state.actor,
      kind: 'candidate',
      key: state.request.candidateId,
    });
    invariant(row, 'NOT_FOUND', 'Select a canonical reviewed Candidate.');
    const candidate = hostedRecordSchema.options[3].parse(JSON.parse(row.value));
    if (row.restoreBases)
      restoreBases = hostedFinishSchema.shape.restoreBases.parse(JSON.parse(row.restoreBases));
    invariant(
      source.intentId === candidate.intentId &&
        source.authorityEpoch === state.request.authorityEpoch &&
        canonicalPayload(source.expectedMain) === canonicalPayload(candidate.base),
      'WORK_OPERATION_CHANGED',
      'Reviewed source must retain its Candidate and main receipt.',
    );
  } else {
    const original = await loadCompose(ctx, {
      projectId: input.projectId,
      actor: state.actor,
      operationId: state.request.finish.composeOperationId!,
    });
    const result = original.operation.terminal?.outcome;
    invariant(
      original.state.status === 'completed' &&
        result?.status === 'completed' &&
        (result.result as { id?: string }).id === state.request.candidateId,
      'WORK_OPERATION_CHANGED',
      'Finish selects the original completed composition.',
    );
    source = original.state.request;
    restoreBases = original.state.restoreBases;
    recoveryRunId = original.row.culpritRunId;
  }
  invariant(
    canonicalPayload(source.inputs.root) === canonicalPayload(attempt.candidate.inputs) &&
      canonicalPayload(source.dependencies.root) === canonicalPayload(attempt.candidate.dependencies),
    'WORK_OPERATION_CHANGED',
    'Finish selection differs from its original Candidate.',
  );
  if (state.request.revertOf) {
    invariant(
      state.request.finish.composeOperationId && source.inputs.count === 1 && source.dependencies.count === 0,
      'WORK_OPERATION_CHANGED',
      'A browser revert selects its one canonical reverse Lane.',
    );
    const [selected] = await ctx.db
      .query('projectHostedComposeSelections')
      .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
        q
          .eq('projectId', input.projectId)
          .eq('actor', state.actor)
          .eq('operationId', state.request.finish!.composeOperationId!)
          .eq('kind', 'inputs'),
      )
      .take(1);
    const lane = selected
      ? await readHostedRecord(ctx, {
          projectId: input.projectId,
          actor: state.actor,
          kind: 'lane',
          key: selected.key,
        })
      : null;
    const record = lane ? hostedRecordSchema.options[1].parse(JSON.parse(lane.value)) : null;
    invariant(
      record?.revert?.receiptId === state.request.revertOf,
      'WORK_OPERATION_CHANGED',
      'Reverse Candidate must name the actual original receipt.',
    );
  }
  const after = state.request.finish.after;
  if (after) await loadLanding(ctx, { projectId: input.projectId, submissionId: after });
  const check = attempt.deferredCheck
    ? state.request.check
    : attempt.check
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
      hostedFinishSchema.parse({
        source,
        check,
        pending: null,
        ...(restoreBases ? { restoreBases } : {}),
        ...(recoveryRunId ? { recoveryRunId } : {}),
      }),
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
    observation:
      code === 'LANDING_SUPERSEDED'
        ? { state: 'superseded' as const, pendingReason: null, cause: null }
        : landingObservation(code === 'COMPOSITION_CONFLICT' ? 'conflict' : 'failed', code),
    error: { code, message },
  };
  await writeLanding(ctx, row, next, false);
  await settleLandingOperation(ctx, next);
  await wakeLandingQueue(ctx, { projectId: input.projectId, channel: state.request.channel });
}
