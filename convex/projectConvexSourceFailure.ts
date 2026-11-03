// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { loadSourceJob, saveSourceJob, sourceJobTerminal } from './projectSourceJobs';
import { hostedWriteProject } from './projectHostedRecords';
import { invariant } from '../src/errors';
import { sourceStep } from './projectConvexSourceActive';
import { receiveConvexSourceJobCallback } from './projectSourceJobCallbacks';
import { sourceDispatch } from '../src/hosted-source-job-controller';
import {
  sourceFailureSchema,
  sourceRetryBackoff,
  unknownSourceFailure,
  type SourceFailure,
} from '../src/hosted-source-retry';
export function sourceFailureUpdate(
  row: { failedAttempts?: number; generation?: number },
  cause: SourceFailure,
  retryUntil?: number,
) {
  const failedAttempts = (row.failedAttempts ?? 0) + 1,
    now = Date.now();
  return {
    failedAttempts,
    failedGeneration: row.generation ?? 0,
    lastFailure: sourceFailureSchema.parse(cause),
    lastFailureAt: now,
    retryAt: Math.min(now + sourceRetryBackoff(failedAttempts), retryUntil ?? Infinity),
  };
}
/** Only the four reserved slots need inspection. Queued batch rows are fenced
 * atomically; no scan of the batch's (up to 800) input documents is needed. */
export async function fenceSourceSlots(
  ctx: MutationCtx,
  batchId: Id<'projectSourceBatches'>,
  finishedTask?: Id<'projectSourceTasks'>,
) {
  const batch = await ctx.db.get(batchId);
  if (batch) await ctx.db.patch(batchId, { status: 'fenced', failure: 'SOURCE_RETRY_EXHAUSTED' });
  const pool = await ctx.db
    .query('projectSourcePools')
    .withIndex('by_key', q => q.eq('key', 'source'))
    .unique();
  if (!pool) return;
  const active: Doc<'projectSourcePools'>['active'] = [];
  for (const entry of pool.active) {
    const task = await ctx.db.get(typeof entry === 'string' ? entry : entry.task);
    if ((typeof entry === 'string' ? task?.batchId : entry.batch) !== batchId) {
      active.push(entry);
      continue;
    }
    const scheduledId = task?.scheduledId ?? (typeof entry === 'string' ? undefined : entry.scheduled);
    const scheduled = scheduledId ? await ctx.db.system.get(scheduledId) : null;
    const id = typeof entry === 'string' ? entry : entry.task;
    if (scheduled?.state.kind === 'inProgress' && id !== finishedTask) active.push(entry);
    else if (scheduled?.state.kind === 'pending') await ctx.scheduler.cancel(scheduledId!);
  }
  await ctx.db.patch(pool._id, { active });
}
/** Current authority, exact dispatch and execution pins are rechecked even when
 * the computation lease expired. Exhaustion changes no pins or business attempt. */
export async function exhaustSourceExecution(
  ctx: MutationCtx,
  identity: { projectId: Id<'hostedProjects'>; jobId: string; step: number },
  cause: SourceFailure = unknownSourceFailure('scheduled-step'),
  finishedTask?: Id<'projectSourceTasks'>,
) {
  const active = await sourceStep(ctx, identity, false);
  if (!active) return;
  const { job, row } = active;
  const body: Partial<ReturnType<typeof sourceDispatch>> = sourceDispatch(identity.projectId, job);
  delete body.jobKind;
  delete body.input;
  delete body.dispatchKey;
  await receiveConvexSourceJobCallback(
    ctx,
    identity.projectId,
    {
      ...body,
      executionId: row.executionId,
      result: { status: 'failed', code: 'SOURCE_RETRY_EXHAUSTED', cause: sourceFailureSchema.parse(cause) },
    },
    Date.now(),
    true,
  );
  if (row.batchId) await fenceSourceSlots(ctx, row.batchId, finishedTask);
  if (job.jobKind !== 'register-state')
    await ctx.scheduler.runAfter(
      0,
      makeFunctionReference<'action'>(
        job.jobKind === 'save'
          ? 'projectHostedSaveJobs:complete'
          : job.jobKind === 'compose'
            ? 'projectHostedComposeJobs:complete'
            : 'projectHostedSyncJobs:complete',
      ),
      { projectId: identity.projectId, jobId: identity.jobId },
    );
}
export function sourceRetryExpired(active: { job: { control: { retryUntil?: number } } }) {
  return active.job.control.retryUntil !== undefined && Date.now() >= active.job.control.retryUntil;
}

/** A compose watch can expire before its provider created a step row. Settle
 * that same reserved job instead of leaving a late dispatch able to start it. */
export async function exhaustSourceWithoutStep(
  ctx: MutationCtx,
  identity: { projectId: Id<'hostedProjects'>; jobId: string; operationId: string },
  cause: SourceFailure,
) {
  const job = await loadSourceJob(ctx, identity.projectId, identity.jobId);
  await hostedWriteProject(ctx, identity.projectId, job.control.actor, job.authorityEpoch);
  invariant(
    job.operationId === identity.operationId && job.control.provider === 'convex',
    'SOURCE_JOB_FENCED',
    'Settle only the retained fixed source job.',
  );
  if (sourceJobTerminal(job)) return job;
  const failed = await saveSourceJob(
    ctx,
    identity.projectId,
    job,
    {
      ...job,
      status: 'failed',
      control: {
        ...job.control,
        failureCode: 'SOURCE_RETRY_EXHAUSTED',
        failureCause: sourceFailureSchema.parse(cause),
      },
    },
    Date.now(),
  );
  const pool = await ctx.db
    .query('projectSourcePools')
    .withIndex('by_key', q => q.eq('key', 'source'))
    .unique();
  for (const slot of pool?.active ?? []) {
    const task = await ctx.db.get(typeof slot === 'string' ? slot : slot.task);
    if (task?.jobId === job.id && task.projectId === identity.projectId)
      await fenceSourceSlots(ctx, task.batchId);
  }
  return failed;
}
