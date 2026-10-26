// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { z } from 'zod';
import { hostedRecordSchema, type HostedRecord } from '../src/hosted-records';
import { beginHostedOperation } from './projectHostedOperations';
import { recordHead, hostedRecordBody, hostedWriteProject, writeHostedRecord } from './projectHostedRecords';
import { activeProject } from './projectAuthority';
import { invariant } from '../src/errors';
import { jobHash, jobNumber, jobObject, sourceDispatchKey } from '../src/hosted-source-job';

export type SourceJob = Extract<HostedRecord, { kind: 'job' }>;
export const sourceJobPlanSchema = z
  .object({
    jobKind: z.enum(['save', 'compose', 'sync', 'register-state']),
    input: jobObject,
    inputDigest: jobHash,
    provider: z.string().min(1),
    worker: z.string().min(1),
    runtime: jobHash,
    keyId: z.string().regex(/^[A-Z0-9_]+$/),
    workerLeaseMs: jobNumber.refine(n => n > 0),
  })
  .strict();

export async function loadSourceJob(
  ctx: MutationCtx | QueryCtx,
  projectId: Id<'hostedProjects'>,
  jobId: string,
) {
  const head = await recordHead(ctx, projectId, 'job', jobId);
  const row = head ? await ctx.db.get(head.recordId) : null;
  invariant(row?.projectId === projectId, 'NOT_FOUND', 'The source job is unavailable.');
  const job = hostedRecordSchema.parse(JSON.parse(await hostedRecordBody(ctx, row)));
  invariant(
    job.kind === 'job' && job.control,
    'SOURCE_JOB_INVALID',
    'The job has no trusted dispatch contract.',
  );
  return job as SourceJob & { control: NonNullable<SourceJob['control']> };
}
export const sourceJobTerminal = (job: SourceJob) =>
  ['completed', 'failed', 'cancelled'].includes(job.status);
export async function saveSourceJob(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  old: SourceJob,
  next: SourceJob,
  now: number,
) {
  await writeHostedRecord(ctx, {
    projectId,
    actor: next.control!.actor,
    authorityEpoch: next.authorityEpoch,
    expectedVersion: old.version,
    record: { ...next, version: old.version + 1, at: new Date(now).toISOString() },
  });
  return { ...next, version: old.version + 1, at: new Date(now).toISOString() };
}

/** Internal only: a trusted caller selects the fixed worker/runtime and input page
 * root. H01 persists original IDs/time before any provider call. Source publication
 * and completion of the parent save/compose operation remain a separate reducer. */
export async function enqueueSourceJob(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    request: unknown;
    payload: unknown;
    firstAttempt: unknown;
  },
) {
  const plan = sourceJobPlanSchema.parse(input.payload);
  const { operation, replayed } = await beginHostedOperation(ctx, input);
  const jobId = operation.firstAttempt.ids.job;
  invariant(jobId, 'BAD_ARGUMENT', 'The original operation must reserve its source job ID.');
  if (replayed) return loadSourceJob(ctx, input.projectId, jobId);
  const job: SourceJob = {
    kind: 'job',
    id: jobId,
    version: 0,
    at: operation.firstAttempt.at,
    operationId: operation.operationId,
    jobKind: plan.jobKind,
    input: plan.input,
    inputDigest: plan.inputDigest,
    authorityEpoch: operation.expected.authorityEpoch,
    attempt: 1,
    fence: 1,
    status: 'pending',
    executionId: null,
    output: null,
    control: {
      actor: input.actor,
      provider: plan.provider,
      worker: plan.worker,
      runtime: plan.runtime,
      keyId: plan.keyId,
      dispatchKey: sourceDispatchKey(input.projectId, jobId, operation.operationId),
      dispatch: 'unstarted',
      dispatches: 0,
      recoveryUsed: false,
      emptyLookups: [],
      lease: null,
      workerLeaseMs: plan.workerLeaseMs,
      workerUntil: 0,
      heartbeat: 0,
      callbackDigest: null,
      failureCode: null,
    },
  };
  await writeHostedRecord(ctx, {
    ...input,
    authorityEpoch: job.authorityEpoch,
    expectedVersion: null,
    record: job,
  });
  return job;
}

/** Claims coordinate short control actions only. They do not replace an uncertain
 * execution or alter its worker fence. A crash after a claim but before dispatch
 * intent is safe to resume; a crash after intent must reconcile the stable key. */
export async function claimSourceJob(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    jobId: string;
    owner: string;
    leaseMs: number;
  },
  now = Date.now(),
) {
  z.uuid().parse(input.owner);
  jobNumber.refine(n => n > 0).parse(input.leaseMs);
  const job = await loadSourceJob(ctx, input.projectId, input.jobId);
  await hostedWriteProject(ctx, input.projectId, job.control.actor, job.authorityEpoch);
  if (sourceJobTerminal(job)) return null;
  const lease = job.control.lease;
  if (lease && lease.until > now) return lease.owner === input.owner ? job : null;
  return saveSourceJob(
    ctx,
    input.projectId,
    job,
    {
      ...job,
      control: {
        ...job.control,
        emptyLookups: [],
        lease: { owner: input.owner, token: (lease?.token ?? 0) + 1, until: now + input.leaseMs },
      },
    },
    now,
  );
}

export const sourceJobCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reserve'), recovery: z.boolean() }).strict(),
  z.object({ kind: z.literal('empty'), lookupId: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal('observe'),
      status: z.enum(['accepted', 'rejected', 'unknown', 'found']),
      executionId: z.string().min(1).optional(),
    })
    .strict(),
]);
/** All effects are fenced by the controller lease. Late provider replies cannot
 * rewrite a callback or a replacement controller's observation. Unknown remains
 * dispatching and recoverable; definitive rejection records a distinct failure. */
export async function advanceSourceJob(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    jobId: string;
    owner: string;
    token: number;
    command: unknown;
  },
  now = Date.now(),
) {
  const command = sourceJobCommandSchema.parse(input.command);
  const job = await loadSourceJob(ctx, input.projectId, input.jobId),
    control = job.control;
  await hostedWriteProject(ctx, input.projectId, control.actor, job.authorityEpoch);
  if (sourceJobTerminal(job)) return null;
  invariant(
    control.lease?.owner === input.owner && control.lease.token === input.token && control.lease.until > now,
    'SOURCE_JOB_FENCED',
    'The source-job controller lease changed or expired.',
  );
  if (command.kind === 'empty') {
    if (control.emptyLookups.includes(command.lookupId) || control.emptyLookups.length === 2) return job;
    return saveSourceJob(
      ctx,
      input.projectId,
      job,
      { ...job, control: { ...control, emptyLookups: [...control.emptyLookups, command.lookupId] } },
      now,
    );
  }
  if (command.kind === 'reserve') {
    if ((!command.recovery && control.dispatches >= 1) || (command.recovery && control.recoveryUsed))
      return job;
    invariant(
      !job.executionId &&
        (command.recovery
          ? control.dispatch === 'ambiguous' &&
            !control.recoveryUsed &&
            control.dispatches === 1 &&
            control.emptyLookups.length === 2
          : control.dispatch === 'unstarted' && control.dispatches === 0),
      'SOURCE_DISPATCH_UNKNOWN',
      'Reconcile the original dispatch before a replacement.',
    );
    return saveSourceJob(
      ctx,
      input.projectId,
      job,
      {
        ...job,
        status: 'dispatching',
        control: {
          ...control,
          dispatch: 'ambiguous',
          dispatches: control.dispatches + 1,
          recoveryUsed: control.recoveryUsed || command.recovery,
          workerUntil: now + control.workerLeaseMs,
        },
      },
      now,
    );
  }
  invariant(
    control.dispatch !== 'unstarted',
    'SOURCE_JOB_INVALID',
    'Retain dispatch intent before provider observations.',
  );
  if (command.status === 'unknown') return job;
  if (command.status === 'accepted' || command.status === 'found') {
    invariant(
      command.executionId && (!job.executionId || job.executionId === command.executionId),
      'SOURCE_EXECUTION_CHANGED',
      'Provider execution differs from the retained source job.',
    );
    if (job.executionId === command.executionId && job.status === 'running') return job;
    return saveSourceJob(
      ctx,
      input.projectId,
      job,
      {
        ...job,
        status: 'running',
        executionId: command.executionId,
        control: { ...control, dispatch: 'accepted' },
      },
      now,
    );
  }
  invariant(
    !job.executionId,
    'SOURCE_EXECUTION_CHANGED',
    'A known execution cannot become a dispatch rejection.',
  );
  // A rejection of the recovery request says nothing about the original
  // ambiguous request. Keep that execution unknown and eligible for lookup.
  if (control.recoveryUsed) return job;
  return saveSourceJob(
    ctx,
    input.projectId,
    job,
    {
      ...job,
      status: 'failed',
      control: { ...control, dispatch: 'rejected', failureCode: 'SOURCE_DISPATCH_REJECTED' },
    },
    now,
  );
}

export async function cancelSourceJob(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; actor: string; jobId: string },
  now = Date.now(),
) {
  await activeProject(ctx, input.projectId, input.actor);
  const job = await loadSourceJob(ctx, input.projectId, input.jobId);
  await hostedWriteProject(ctx, input.projectId, job.control.actor, job.authorityEpoch);
  if (sourceJobTerminal(job)) return job;
  return saveSourceJob(ctx, input.projectId, job, { ...job, fence: job.fence + 1, status: 'cancelled' }, now);
}
