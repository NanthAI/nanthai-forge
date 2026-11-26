// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
  nodeCompose = false,
) {
  const job = await loadSourceJob(ctx, projectId, jobId),
    terminal = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
  if (inline && !terminal) {
    // Dispatch in this transaction as usual. A known Node compose starts on its
    // own scheduled action instead of running through the submitting V8 action.
    const dispatched = await dispatchConvexSource(ctx, { projectId, jobId, nodeCompose }, !nodeCompose);
    return { job: await loadSourceJob(ctx, projectId, jobId), run: dispatched.inline };
  }
  await ctx.scheduler.runAfter(
    0,
    makeFunctionReference<'action' | 'mutation'>(
      terminal ? `${api}:complete` : 'projectConvexSource:dispatch',
    ),
    { projectId, jobId, ...(!terminal && nodeCompose ? { nodeCompose: true } : {}) },
  );
  return { job, run: false };
}
