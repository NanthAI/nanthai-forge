// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { loadSourceJob, type SourceJob } from './projectSourceJobs';

/** Selected metadata only. Observation never renews a lease or schedules work.
 * The original submit is the explicit recovery trigger for the same execution. */
export async function sourceProgress(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  jobId: string,
  selected?: SourceJob,
) {
  const job = selected ?? (await loadSourceJob(ctx, projectId, jobId));
  const control = job.control!;
  const step =
    control.provider === 'convex'
      ? await ctx.db
          .query('projectSourceSteps')
          .withIndex('by_project_and_job', q => q.eq('projectId', projectId).eq('jobId', jobId))
          .unique()
      : null;
  const batch = step?.batchId ? await ctx.db.get(step.batchId) : null;
  const phase =
    job.status === 'completed'
      ? 'source-publication'
      : step
        ? `source-step:${job.status === 'failed' ? Math.max(0, step.step - 1) : step.step}`
        : `source-${job.jobKind}`;
  const deadline =
    job.status === 'completed' ? Date.parse(job.at) + control.workerLeaseMs : control.workerUntil;
  const source = { jobId, status: job.status, phase, workerUntil: deadline };
  if (job.status === 'failed' || job.status === 'cancelled')
    return {
      status: 'failed',
      jobId,
      source,
      failedPhase: phase,
      error: {
        code:
          control.failureCode ??
          (job.status === 'cancelled' ? 'SOURCE_JOB_CANCELLED' : 'SOURCE_WORKER_FAILED'),
        message: 'The original source job stopped; its inputs and operation are retained.',
      },
    };
  if (job.status === 'completed')
    return deadline > Date.now()
      ? { status: 'submitted', jobId, source }
      : {
          status: 'retryable',
          jobId,
          source,
          failedPhase: phase,
          error: {
            code: 'SOURCE_PUBLICATION_STALLED',
            message:
              'Source computation completed but publication made no progress. Replay the original operation to reconcile the retained output.',
          },
        };
  const scheduled = step?.scheduledId ? await ctx.db.system.get(step.scheduledId) : null;
  const stopped =
    !!batch?.failure ||
    (!!step?.scheduledId && (!scheduled || ['failed', 'canceled'].includes(scheduled.state.kind)));
  const expired = control.dispatch !== 'unstarted' && deadline <= Date.now();
  if (stopped || expired)
    return {
      status: 'retryable',
      jobId,
      source,
      failedPhase: phase,
      error: {
        code: batch?.failure ?? (stopped ? 'SOURCE_WORKER_STEP_FAILED' : 'SOURCE_JOB_STALLED'),
        message: stopped
          ? 'A source worker step failed. Replay the original operation to reconcile the same execution.'
          : 'The source job made no progress before its worker lease expired. Replay the original operation to reconcile the same execution.',
      },
    };
  return { status: 'submitted', jobId, source };
}
