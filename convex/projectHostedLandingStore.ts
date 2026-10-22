// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import {
  canonicalPayload,
  completeHostedOperation,
  hostedOperationSchema,
} from '../src/hosted-source-operation';
import {
  hostedLandingAttemptSchema,
  hostedLandingStateSchema,
  type HostedLandingState,
  type HostedLandingAttempt,
} from '../src/hosted-landing';
import { hostedOperationRow } from './projectHostedOperations';
import { invariant } from '../src/errors';
export type LandingChannel = { projectId: Id<'hostedProjects'>; channel: 'main' };
export type LandingIdentity = { projectId: Id<'hostedProjects'>; submissionId: string };
export type LandingRow = Doc<'projectHostedLandingRequests'>;
export const landingQueue = (ctx: QueryCtx | MutationCtx, input: LandingChannel) =>
  ctx.db
    .query('projectHostedLandingQueues')
    .withIndex('by_project_and_channel', q => q.eq('projectId', input.projectId).eq('channel', input.channel))
    .unique();
export async function ensureLandingQueue(ctx: MutationCtx, input: LandingChannel) {
  const row = await landingQueue(ctx, input);
  if (row) return row;
  const id = await ctx.db.insert('projectHostedLandingQueues', {
    ...input,
    sequence: 0,
    fence: 0,
    wake: null,
    lease: null,
  });
  return (await ctx.db.get(id))!;
}
export const landingRow = (ctx: QueryCtx | MutationCtx, input: LandingIdentity) =>
  ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_submission', q =>
      q.eq('projectId', input.projectId).eq('submissionId', input.submissionId),
    )
    .unique();
export async function loadLanding(ctx: QueryCtx | MutationCtx, input: LandingIdentity) {
  const row = await landingRow(ctx, input);
  invariant(row, 'NOT_FOUND', 'Hosted landing request not found.');
  const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
  invariant(
    state.id === row.submissionId &&
      state.projectId === row.projectId &&
      state.attemptId === row.attemptId &&
      state.phase === row.phase &&
      state.actor === row.actor &&
      state.operationId === row.operationId &&
      state.sequence === row.sequence &&
      state.request.channel === row.channel,
    'SOURCE_UNAVAILABLE',
    'Landing request identity differs from its record.',
  );
  return { row, state };
}
export const landingAttemptRow = (
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; attemptId: string },
) =>
  ctx.db
    .query('projectHostedLandingAttempts')
    .withIndex('by_project_and_attempt', q =>
      q.eq('projectId', input.projectId).eq('attemptId', input.attemptId),
    )
    .unique();
export async function loadLandingAttempt(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; attemptId: string },
) {
  const row = await landingAttemptRow(ctx, input);
  invariant(row, 'SOURCE_UNAVAILABLE', 'The original landing attempt is unavailable.');
  const attempt = hostedLandingAttemptSchema.parse(JSON.parse(row.value));
  invariant(
    attempt.projectId === row.projectId &&
      attempt.id === row.attemptId &&
      attempt.submissionId === row.submissionId &&
      attempt.number === row.number,
    'SOURCE_UNAVAILABLE',
    'Landing attempt identity differs from its record.',
  );
  return attempt;
}
export async function insertLandingAttempt(ctx: MutationCtx, input: HostedLandingAttempt) {
  const attempt = hostedLandingAttemptSchema.parse(input),
    value = canonicalPayload(attempt);
  const old = await landingAttemptRow(ctx, {
    projectId: attempt.projectId as Id<'hostedProjects'>,
    attemptId: attempt.id,
  });
  if (old) {
    invariant(old.value === value, 'WORK_OPERATION_CHANGED', 'The original landing attempt is immutable.');
    return;
  }
  if (attempt.parentAttemptId === null) {
    invariant(attempt.number === 0, 'WORK_OPERATION_CHANGED', 'A first landing attempt has ordinal zero.');
  } else {
    const parent = await loadLandingAttempt(ctx, {
      projectId: attempt.projectId as Id<'hostedProjects'>,
      attemptId: attempt.parentAttemptId,
    });
    invariant(
      parent.submissionId === attempt.submissionId &&
        parent.operationId === attempt.operationId &&
        parent.number + 1 === attempt.number &&
        canonicalPayload(parent.actor) === canonicalPayload(attempt.actor),
      'WORK_OPERATION_CHANGED',
      'A child attempt must retain its original submission and actor.',
    );
  }
  const sameNumber = await ctx.db
    .query('projectHostedLandingAttempts')
    .withIndex('by_project_and_submission_and_number', q =>
      q
        .eq('projectId', attempt.projectId as Id<'hostedProjects'>)
        .eq('submissionId', attempt.submissionId)
        .eq('number', attempt.number),
    )
    .unique();
  invariant(!sameNumber, 'WORK_STALE', 'The next landing attempt was already selected.');
  await ctx.db.insert('projectHostedLandingAttempts', {
    projectId: attempt.projectId as Id<'hostedProjects'>,
    submissionId: attempt.submissionId,
    attemptId: attempt.id,
    number: attempt.number,
    value,
  });
}
export async function writeLanding(
  ctx: MutationCtx,
  row: LandingRow,
  input: HostedLandingState,
  runnable: boolean,
) {
  const state = hostedLandingStateSchema.parse(input),
    previous = hostedLandingStateSchema.parse(JSON.parse(row.value));
  invariant(
    state.id === previous.id &&
      state.projectId === previous.projectId &&
      state.actor === previous.actor &&
      state.operationId === previous.operationId &&
      state.at === previous.at &&
      state.sequence === previous.sequence &&
      state.firstAttemptId === previous.firstAttemptId &&
      state.version === previous.version + 1 &&
      canonicalPayload(state.request) === canonicalPayload(previous.request),
    'WORK_OPERATION_CHANGED',
    'Landing progress must retain its original request and identity.',
  );
  const attempt = await loadLandingAttempt(ctx, {
    projectId: row.projectId,
    attemptId: state.attemptId,
  });
  invariant(
    attempt.submissionId === state.id &&
      attempt.operationId === state.operationId &&
      attempt.actor.id === state.actor,
    'WORK_OPERATION_CHANGED',
    'The selected attempt must belong to this original request.',
  );
  await ctx.db.patch(row._id, {
    attemptId: state.attemptId,
    runId: attempt.check?.runId ?? null,
    phase: state.phase,
    runnable,
    value: canonicalPayload(state),
  });
}
/** Internal queue bookkeeping can retain a rejected outcome after actor revocation.
 * This never reads/returns source or grants the revoked actor publication authority. */
export async function settleLandingOperation(ctx: MutationCtx, state: HostedLandingState) {
  const row = await hostedOperationRow(
    ctx,
    state.projectId as Id<'hostedProjects'>,
    state.actor,
    state.operationId,
  );
  invariant(row, 'SOURCE_UNAVAILABLE', 'The original landing operation is unavailable.');
  const receipt = {
    attemptId: state.attemptId,
    at: new Date().toISOString(),
    outcome:
      state.phase === 'terminal-failed'
        ? { status: 'failed' as const, error: state.error! }
        : {
            status: 'completed' as const,
            result: {
              submissionId: state.id,
              attemptId: state.attemptId,
              phase: state.phase,
              observation: state.observation,
            },
          },
  };
  const operation = completeHostedOperation(hostedOperationSchema.parse(JSON.parse(row.value)), receipt);
  if (canonicalPayload(operation) !== row.value)
    await ctx.db.patch(row._id, { value: canonicalPayload(operation) });
}
