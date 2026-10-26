// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { z } from 'zod';
import { loadSourceJob, saveSourceJob, sourceJobTerminal } from './projectSourceJobs';
import { hostedWriteProject } from './projectHostedRecords';
import { sourceDispatch } from '../src/hosted-source-job-controller';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/portable-hash';
import { invariant } from '../src/errors';
import type { SourceDispatch } from '../src/hosted-source-job';

type Request = { projectId: Id<'hostedProjects'>; jobId: string; input: SourceDispatch };
async function boundJob(ctx: MutationCtx | QueryCtx, input: Request) {
  const job = await loadSourceJob(ctx, input.projectId, input.jobId);
  await hostedWriteProject(ctx, input.projectId, job.control.actor, job.authorityEpoch);
  invariant(
    canonicalPayload(sourceDispatch(input.projectId, job)) === canonicalPayload(input.input),
    'SOURCE_PROVIDER_CHANGED',
    'Provider request differs from the exact durable dispatch.',
  );
  invariant(job.control.dispatch !== 'unstarted', 'SOURCE_JOB_FENCED', 'Dispatch intent is not reserved.');
  return job;
}
/** One database transaction owns permission to make the FIRST paid create. A
 * committed reservation is never reset, including unknown/crashed creates.
 * Retrying reserve returns create:false even with the original token. */
export async function reserveSourceProvider(
  ctx: MutationCtx,
  input: Request & { token: string },
  now = Date.now(),
) {
  z.uuid().parse(input.token);
  const job = await boundJob(ctx, input);
  const prior = job.control.providerReservation;
  if (prior || sourceJobTerminal(job) || job.executionId)
    return { create: false, executionId: job.executionId };
  invariant(job.control.workerUntil > now, 'SOURCE_JOB_FENCED', 'Worker dispatch lease expired.');
  await saveSourceJob(
    ctx,
    input.projectId,
    job,
    {
      ...job,
      control: {
        ...job.control,
        providerReservation: { input: digest(canonicalPayload(input.input)), token: input.token },
      },
    },
    now,
  );
  return { create: true, executionId: null };
}
/** Authoritative absence means no reservation AND no execution. A reserved but
 * unobserved create stays unknown; no filesystem or eventually consistent search
 * licenses another paid create. Current authority is checked for every lookup. */
export async function lookupSourceProvider(ctx: QueryCtx | MutationCtx, input: Request) {
  const job = await boundJob(ctx, input);
  if (job.executionId) return { status: 'found' as const, executionId: job.executionId };
  return job.control.providerReservation || sourceJobTerminal(job)
    ? { status: 'unknown' as const }
    : { status: 'empty' as const, authoritative: true as const };
}
/** The trusted bridge records the original SDK ID immediately after create.
 * Worker callbacks can beat this request; matching late observations reconcile
 * without changing terminal results or extending the worker lease. */
export async function recordSourceProvider(
  ctx: MutationCtx,
  input: Request & { token: string; executionId: string },
  now = Date.now(),
) {
  z.uuid().parse(input.token);
  z.string().min(1).parse(input.executionId);
  const job = await boundJob(ctx, input),
    prior = job.control.providerReservation;
  invariant(
    prior?.token === input.token && prior.input === digest(canonicalPayload(input.input)),
    'SOURCE_JOB_FENCED',
    'Provider reservation changed.',
  );
  invariant(
    !job.executionId || job.executionId === input.executionId,
    'SOURCE_EXECUTION_CHANGED',
    'Provider execution identity changed.',
  );
  if (job.executionId === input.executionId) return job.executionId;
  invariant(
    !sourceJobTerminal(job) && job.control.workerUntil > now,
    'SOURCE_JOB_FENCED',
    'Source worker is terminal or its lease expired.',
  );
  await saveSourceJob(
    ctx,
    input.projectId,
    job,
    {
      ...job,
      executionId: input.executionId,
      status: 'running',
      control: { ...job.control, dispatch: 'accepted' },
    },
    now,
  );
  return input.executionId;
}
