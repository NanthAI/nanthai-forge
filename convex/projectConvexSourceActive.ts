// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { loadSourceJob, sourceJobTerminal } from './projectSourceJobs';
import { hostedWriteProject } from './projectHostedRecords';
import { authorizeSourceTransfer } from './projectHostedSaveTransfers';
import { canonicalPayload } from '../src/hosted-source-operation';
import { sourceDispatch } from '../src/hosted-source-job-controller';
import { invariant } from '../src/errors';
export const rowFor = (ctx: MutationCtx, projectId: Id<'hostedProjects'>, jobId: string) =>
  ctx.db
    .query('projectSourceSteps')
    .withIndex('by_project_and_job', q => q.eq('projectId', projectId).eq('jobId', jobId))
    .unique();
export async function activeStep(
  ctx: MutationCtx,
  args: { projectId: Id<'hostedProjects'>; jobId: string; step: number; generation?: number; index?: number },
) {
  const active = await sourceStep(ctx, args, true);
  if (
    active &&
    args.index === undefined &&
    args.generation !== undefined &&
    args.generation !== (active.row.generation ?? 0)
  )
    return null;
  return active;
}
export async function sourceStep(
  ctx: MutationCtx,
  args: { projectId: Id<'hostedProjects'>; jobId: string; step: number },
  lease: boolean,
) {
  const job = await loadSourceJob(ctx, args.projectId, args.jobId);
  await hostedWriteProject(ctx, args.projectId, job.control.actor, job.authorityEpoch);
  const row = await rowFor(ctx, args.projectId, args.jobId);
  if (!row || sourceJobTerminal(job) || row.step !== args.step) return null;
  invariant(
    row.dispatch === canonicalPayload(sourceDispatch(args.projectId, job)),
    'SOURCE_JOB_FENCED',
    'Source step pins changed.',
  );
  if (job.jobKind !== 'register-state')
    await authorizeSourceTransfer(
      ctx,
      { projectId: args.projectId, input: row.dispatch, executionId: row.executionId },
      { lease, loaded: job },
    );
  else
    invariant(
      job.status === 'running' &&
        job.executionId === row.executionId &&
        (!lease || job.control.workerUntil > Date.now()),
      'SOURCE_JOB_FENCED',
      'Source execution changed or expired.',
    );
  return { job, row };
}
