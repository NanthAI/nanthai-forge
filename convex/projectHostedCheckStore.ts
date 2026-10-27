import { semanticPayload } from '../src/semantic-payload';
import { wakeExpiredLogs } from './projectCheckLogRetention';
// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { activeProject } from './projectAuthority';
import { notifyLandingCheck } from './projectHostedLandingWake';
import { hostedWriteProject } from './projectHostedRecords';
import { beginHostedOperation, finishHostedOperation, hostedOperationRow } from './projectHostedOperations';
import {
  canonicalPayload,
  hostedPayloadHash,
  hostedOperationSchema,
  type HostedExpectedPins,
  type HostedOperation,
} from '../src/hosted-source-operation';
import { hostedCheckRunSchema, type HostedCheckRun } from '../src/hosted-check';
import { invariant } from '../src/errors';

export type CheckIdentity = { projectId: Id<'hostedProjects'>; runId: string };
export const checkSetting = (
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  kind: 'definition' | 'runner',
  key: string,
) =>
  ctx.db
    .query('projectHostedCheckSettings')
    .withIndex('by_project_and_kind_and_key', q =>
      q.eq('projectId', projectId).eq('kind', kind).eq('key', key),
    )
    .unique();
export async function checkCaller(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to use hosted checks.');
  return { actor: user.subject, project: await activeProject(ctx, projectId, user.subject) };
}
export async function beginCheckOperation(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    operationId: string;
    expected: HostedExpectedPins;
    payload: unknown;
  },
) {
  return beginHostedOperation(ctx, {
    projectId: input.projectId,
    actor: input.actor,
    payload: input.payload,
    request: {
      schema: 1,
      projectId: input.projectId,
      actor: input.actor,
      operationId: input.operationId,
      expected: input.expected,
      payloadHash: hostedPayloadHash(input.payload, input.expected),
    },
    firstAttempt: {
      projectId: input.projectId,
      operationId: input.operationId,
      id: crypto.randomUUID(),
      parentAttemptId: null,
      at: new Date().toISOString(),
      expected: input.expected,
      ids: { run: crypto.randomUUID() },
    },
  });
}
export const completeCheckOperation = (ctx: MutationCtx, operation: HostedOperation, result: unknown) =>
  finishHostedOperation(ctx, {
    projectId: operation.projectId as Id<'hostedProjects'>,
    actor: operation.actor,
    operationId: operation.operationId,
    receipt: {
      attemptId: operation.firstAttempt.id,
      at: new Date().toISOString(),
      outcome: { status: 'completed', result: JSON.parse(canonicalPayload(result)) },
    },
  });
export async function loadHostedCheck(ctx: QueryCtx | MutationCtx, input: CheckIdentity) {
  const row = await ctx.db
    .query('projectHostedCheckRuns')
    .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
    .unique();
  invariant(row, 'NOT_FOUND', 'Hosted check run not found.');
  const run = hostedCheckRunSchema.parse(JSON.parse(row.value));
  invariant(
    run.id === input.runId && run.projectId === input.projectId,
    'EVIDENCE_CHANGED',
    'Hosted run identity differs from its record.',
  );
  return { row, run };
}
export async function writableHostedCheck(ctx: MutationCtx, input: CheckIdentity) {
  const selected = await loadHostedCheck(ctx, input);
  await hostedWriteProject(ctx, input.projectId, selected.run.actor, selected.run.request.authorityEpoch);
  return selected;
}
export async function writeHostedCheck(
  ctx: MutationCtx,
  id: Id<'projectHostedCheckRuns'>,
  run: HostedCheckRun,
) {
  await ctx.db.patch(id, {
    status: run.status,
    value: semanticPayload(hostedCheckRunSchema.parse(run), true),
  });
  await notifyLandingCheck(ctx, { projectId: run.projectId as Id<'hostedProjects'>, runId: run.id });
}
export async function completeHostedCheck(ctx: MutationCtx, run: HostedCheckRun) {
  await wakeExpiredLogs(ctx, run.projectId as Id<'hostedProjects'>);
  const row = await hostedOperationRow(
    ctx,
    run.projectId as Id<'hostedProjects'>,
    run.actor,
    run.request.operationId,
  );
  invariant(row, 'SOURCE_UNAVAILABLE', 'The original check operation is unavailable.');
  await completeCheckOperation(ctx, hostedOperationSchema.parse(JSON.parse(row.value)), {
    runId: run.id,
    status: run.status,
    head: run.request.expectedHead,
    terminalDigest: run.terminalDigest,
  });
}
