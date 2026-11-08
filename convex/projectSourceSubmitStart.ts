// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { loadSourceJob } from './projectSourceJobs';
import { dispatchConvexSource } from './projectConvexSourceStore';

/** The tail of a save, sync or compose submit. A finished job goes to its finalizer; otherwise the job
 * is dispatched, by a scheduled dispatch or, `inline`, in this transaction. `run` is then true when the
 * first step was started here and the caller (the submitting action) runs it itself. */
export async function startSubmittedSource(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  jobId: string,
  api: 'projectHostedSaveJobs' | 'projectHostedSyncJobs' | 'projectHostedComposeJobs',
  inline = false,
) {
  const job = await loadSourceJob(ctx, projectId, jobId),
    terminal = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
  if (inline && !terminal) {
    const dispatched = await dispatchConvexSource(ctx, { projectId, jobId }, true);
    return { job: await loadSourceJob(ctx, projectId, jobId), run: dispatched.inline };
  }
  await ctx.scheduler.runAfter(
    0,
    makeFunctionReference<'action' | 'mutation'>(
      terminal ? `${api}:complete` : 'projectConvexSource:dispatch',
    ),
    { projectId, jobId },
  );
  return { job, run: false };
}
