// SPDX-License-Identifier: Apache-2.0
import {
  reportsDetached,
  objectReportTransport,
  useObjectReports,
  detachCheckReports,
  hydrateCheckReports,
  storeCheckReports,
} from './projectHostedCheckReports';
import { hostedVerdictKey } from '../src/hosted-check-evidence';
import { onGateRunTerminal } from './projectHostedMainAuditState';
import { semanticPayload } from '../src/semantic-payload';
import { wakeExpiredLogs } from './projectCheckLogRetention';
import { checkReportHeader } from '../src/check-file-summary';
import { restoreShardReports } from './projectHostedActionsReports';
import { makeFunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { activeProject } from './projectAuthority';
import { notifyLandingCheck } from './projectHostedLandingCheckWake';
import { hostedWriteProject } from './projectHostedRecords';
import { beginHostedOperation, finishHostedOperation, hostedOperationRow } from './projectHostedOperations';
import {
  canonicalPayload,
  hostedPayloadHash,
  hostedOperationSchema,
  type HostedExpectedPins,
  type HostedOperation,
} from '../src/hosted-source-operation';
import { hostedCheckRunSchema, hostedCheckTerminal, type HostedCheckRun } from '../src/hosted-check';
import { invariant } from '../src/errors';
import { notifyPullCheck } from './projectGithubPullQueue';
import { scheduleCheckExpiry } from './projectOperationalExpirySchedule';

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
  return {
    actor: user.subject,
    project: await activeProject(ctx, projectId, user.subject),
  };
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
      outcome: {
        status: 'completed',
        result: JSON.parse(canonicalPayload(result)),
      },
    },
  });
export async function loadHostedCheck(
  ctx: QueryCtx | MutationCtx,
  input: CheckIdentity,
  withReports = true,
  loaded?: Doc<'projectHostedCheckRuns'>,
) {
  const row =
    loaded ??
    (await ctx.db
      .query('projectHostedCheckRuns')
      .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
      .unique());
  invariant(row, 'NOT_FOUND', 'Hosted check run not found.');
  invariant(
    row.projectId === input.projectId && row.runId === input.runId,
    'EVIDENCE_CHANGED',
    'Hosted run row identity differs from the requested check.',
  );
  const run = hostedCheckRunSchema.parse(JSON.parse(row.value));
  invariant(
    run.id === input.runId && run.projectId === input.projectId,
    'EVIDENCE_CHANGED',
    'Hosted run identity differs from its record.',
  );
  if (row.reportStorage === 'r2')
    useObjectReports(run, {
      ...(row.resultBatch ? { packed: row.resultBatch.packed } : {}),
      flakes: row.reportFlakes,
      timingStamp: row.reportTimingStamp,
      timingComplete: row.reportTimingComplete,
      timingParts: row.reportTimingParts,
      conclusion: row.reportConclusion,
    });
  if (row.reportParts !== undefined && row.reportStorage !== 'r2') {
    detachCheckReports(run, row.reportParts, row.reportDigest ?? '');
    if (withReports) await hydrateCheckReports(ctx, run);
  }
  return { row, run };
}
/** A run row already loaded (and write-authorized) in this transaction. */
export type LoadedHostedCheck = Awaited<ReturnType<typeof writableHostedCheck>>;
export async function writableHostedCheck(
  ctx: MutationCtx,
  input: CheckIdentity,
  withReports = false,
  loaded?: Doc<'projectHostedCheckRuns'>,
) {
  const selected = await loadHostedCheck(ctx, input, withReports, loaded);
  const project = await hostedWriteProject(
    ctx,
    input.projectId,
    selected.run.actor,
    selected.run.request.authorityEpoch,
  );
  // The project row is already read for authority; callers reuse its visibility.
  return { ...selected, project };
}
export async function writeHostedCheck(
  ctx: MutationCtx,
  id: Id<'projectHostedCheckRuns'>,
  run: HostedCheckRun,
  providerAttested = false,
) {
  if (run.actions?.watchdog && hostedCheckTerminal(run)) {
    await ctx.scheduler.cancel(run.actions.watchdog as Id<'_scheduled_functions'>);
    run.actions.watchdog = null;
  }
  checkReportHeader(run, objectReportTransport(run) ? 7 * 1024 : 8 * 1024);
  const reports = await storeCheckReports(ctx, run);
  const stored = { ...run };
  if ('reportParts' in reports || objectReportTransport(run)) delete stored.contractReports;
  await ctx.db.patch(id, {
    ...reports,
    status: run.status,
    ...(providerAttested && run.status === 'passed' ? { verdictKey: hostedVerdictKey(run) } : {}),
    value: semanticPayload(hostedCheckRunSchema.parse(stored), true),
  });
  await notifyLandingCheck(ctx, {
    projectId: run.projectId as Id<'hostedProjects'>,
    runId: run.id,
    terminal: hostedCheckTerminal(run),
  });
}
export async function completeHostedCheck(ctx: MutationCtx, run: HostedCheckRun) {
  if (run.configuration.provider !== 'ci-status')
    await scheduleCheckExpiry(ctx, run.projectId as Id<'hostedProjects'>, run.id, Date.parse(run.endedAt!));
  // Existing terminal events also clear an interrupted batch inbox; no sweep or idle timer.
  if (
    reportsDetached(run) &&
    (!objectReportTransport(run) || objectReportTransport(run)?.packed !== undefined) &&
    !objectReportTransport(run)?.collecting &&
    run.plan &&
    run.executionId &&
    !['passed', 'failed'].includes(run.status)
  )
    await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectHostedActionsBatch:collect'), {
      projectId: run.projectId,
      runId: run.id,
      fence: run.fence,
      executionId: run.executionId,
      conclusion: null,
    });
  await restoreShardReports(ctx, run);
  await onGateRunTerminal(ctx, run);
  // Two-way sync: a pull request check-only run settles forge/verify (one indexed read).
  await notifyPullCheck(ctx, run);
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

/** Structured across internal function/HTTP boundaries; never includes source or credentials. */
export function assertHostedCheckActive(run: HostedCheckRun) {
  if (run.status === 'cancelled' || run.cancelRequested)
    throw new ConvexError({
      code: 'CHECK_CANCELLED',
      reason: 'cancelled',
      message: 'The check was cancelled.',
    });
}
