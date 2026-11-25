// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { infraWaitPrefix } from '../src/ci-provider-recovery';
import { recordCheckFeed } from './projectFeedTerminal';
import { deferCancelledRunWrite } from './projectCancelledRunWrites';
import { markCancelledRunPending } from './projectCancelledRunOwners';
import { cancelPendingTask } from './schedulerCancel';
import {
  reportsDetached,
  reportCollectionBusy,
  objectReportTransport,
  useObjectReports,
  detachCheckReports,
  hydrateCheckReports,
  storeCheckReports,
} from './projectHostedCheckReports';
import { hostedVerdictKey } from '../src/hosted-check-evidence';
import { hostedCheckClock } from './projectHostedCheckClock';
import { onGateRunTerminal } from './projectHostedMainAuditState';
import { auditCoverageSchema } from '../src/landing-audit-cadence';
import { noteMirrorCheck } from './projectGithubMirrorVerify';
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
    workKind?: 'checks';
  },
) {
  return beginHostedOperation(ctx, {
    projectId: input.projectId,
    actor: input.actor,
    payload: input.payload,
    ...(input.workKind ? { workKind: input.workKind } : {}),
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
  hostedCheckClock(run, row.replayClock);
  invariant(
    run.id === input.runId && run.projectId === input.projectId,
    'EVIDENCE_CHANGED',
    'Hosted run identity differs from its record.',
  );
  if (row.reportStorage === 'r2')
    useObjectReports(run, {
      ...(row.resultBatch ? { packed: row.resultBatch.packed } : {}),
      flakes: row.reportFlakes,
      recovery: row.reportRecovery,
      timingStamp: row.reportTimingStamp,
      timingComplete: row.reportTimingComplete,
      timingParts: row.reportTimingParts,
      conclusion: row.reportConclusion,
      collection: row.reportCollection,
    });
  // Inline-report reader (rows without `reportStorage`): remove on 2026-12-31 once no inline run remains (docs/operations/legacy-small-shapes.md#inline-check-reports-f9).
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
  mainMoveDecision?: Doc<'projectHostedCheckRuns'>['mainMoveDecision'],
  evidence?: Pick<Partial<Doc<'projectHostedCheckRuns'>>, 'timingHistoryGeneration' | 'machineSelection'>,
) {
  const providerDelayChanged = run.failureReason?.startsWith('provider-delayed:') === true;
  // A platform retry's check-infrastructure wait (0d8a85a3) ends once Forge takes the run's plan,
  // not on GitHub's requested/in_progress event (the 05:27Z outage: jobs ran, the job API did not);
  // an adapter without a plan step ends it once the run runs. A provider delay ends on startup.
  const infraWait = run.failureReason?.startsWith(infraWaitPrefix) === true;
  if (
    !hostedCheckTerminal(run) &&
    run.failureReason?.startsWith('provider-delayed:') &&
    (infraWait
      ? Boolean(run.plan) || (!run.actions && run.status === 'running')
      : !run.actions?.verdictPending && run.actions?.workflowSha)
  )
    delete run.failureReason;
  // A run that settles without retrying (cancelled before its plan) does not say it waits.
  else if (infraWait && hostedCheckTerminal(run)) delete run.failureReason;
  if (
    run.actions?.confirm &&
    (hostedCheckTerminal(run) ||
      (!run.actions.verdictPending && (run.actions.workflowSha || run.counts.completed > 0)))
  ) {
    await cancelPendingTask(ctx, run.actions.confirm as Id<'_scheduled_functions'>);
    run.actions.confirm = null;
  }
  if (run.actions?.watchdog && hostedCheckTerminal(run)) {
    await cancelPendingTask(ctx, run.actions.watchdog as Id<'_scheduled_functions'>);
    run.actions.watchdog = null;
  }
  const transport = objectReportTransport(run);
  const reportRecovered = transport?.recovery && (run.reportPointer || hostedCheckTerminal(run));
  if (reportRecovered) await cancelPendingTask(ctx, transport.recovery);
  checkReportHeader(run, transport ? 7 * 1024 : 8 * 1024);
  const reports = await storeCheckReports(ctx, run);
  const stored = { ...run };
  if ('reportParts' in reports || objectReportTransport(run)) delete stored.contractReports;
  await ctx.db.patch(id, {
    ...reports,
    status: run.status,
    ...(mainMoveDecision ? { mainMoveDecision } : {}),
    ...evidence,
    ...(hostedCheckClock(run) ? { replayClock: hostedCheckClock(run) } : {}),
    ...(reportRecovered ? { reportRecovery: undefined } : {}),
    ...(providerAttested && run.status === 'passed' ? { verdictKey: hostedVerdictKey(run) } : {}),
    value: semanticPayload(hostedCheckRunSchema.parse(stored), true),
  });
  await notifyLandingCheck(ctx, {
    projectId: run.projectId as Id<'hostedProjects'>,
    runId: run.id,
    terminal: hostedCheckTerminal(run),
    ...(providerDelayChanged ? { providerDelayed: true } : {}),
  });
}
export async function completeHostedCheck(
  ctx: MutationCtx,
  run: HostedCheckRun,
  source?: Pick<Doc<'projectHostedCheckRuns'>, 'cancelledUsage' | 'cause' | 'auditCoverage'>,
) {
  if (run.status === 'cancelled')
    deferCancelledRunWrite(ctx, run.id, source?.cancelledUsage?.submissions ?? [], () =>
      markCancelledRunPending(ctx, run.projectId as Id<'hostedProjects'>, run.id),
    );
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
  ) {
    const transport = objectReportTransport(run);
    if (!transport || !(await reportCollectionBusy(ctx, run))) {
      const collectionToken = transport ? crypto.randomUUID() : undefined;
      const scheduledFunctionId = await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'action'>('projectHostedActionsBatch:collect'),
        {
          projectId: run.projectId,
          runId: run.id,
          fence: run.fence,
          executionId: run.executionId,
          conclusion: null,
          ...(collectionToken ? { collectionToken } : {}),
        },
      );
      if (transport)
        transport.collection = {
          token: collectionToken!,
          fence: run.fence,
          until: Date.now() + 30 * 60_000,
          scheduledFunctionId,
        };
    }
  }
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
  const operation = hostedOperationSchema.parse(JSON.parse(row.value));
  const audit = source?.auditCoverage
    ? auditCoverageSchema.parse(JSON.parse(source.auditCoverage))
    : undefined;
  await completeCheckOperation(ctx, operation, {
    runId: run.id,
    status: run.status,
    head: run.request.expectedHead,
    terminalDigest: run.terminalDigest,
    ...(audit ? { audit } : {}),
  });
  if (!operation.terminal) await recordCheckFeed(ctx, run, source?.cause);
  await noteMirrorCheck(ctx, run);
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
