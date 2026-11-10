// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, type MutationCtx } from './server';
import type { Id } from './_generated/dataModel';

/** Drain only checks registered on this exact publication. Eight compact run rows per page also
 * keep old, undetached report rows below the Convex read ceiling. Healthy mirrors never call it. */
export async function wakeCiMirrorWaiters(ctx: MutationCtx, jobId: Id<'projectGithubMirrorJobs'>) {
  const rows = await ctx.db
    .query('projectHostedCheckRuns')
    .withIndex('by_ci_mirror_job', q => q.eq('ciMirrorJob', jobId))
    .take(8);
  for (const row of rows) {
    await ctx.db.patch(row._id, { ciMirrorJob: undefined });
    if (row.status === 'queued')
      await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectCiStatusPublish:publish'), {
        projectId: row.projectId,
        runId: row.runId,
      });
  }
  if (rows.length === 8)
    await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectCiStatusMirror:wake'), {
      jobId,
    });
}

export const wake = internalMutation({
  args: { jobId: v.id('projectGithubMirrorJobs') },
  returns: v.null(),
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (job?.ciWaiters && ['done', 'failed'].includes(job.status)) await wakeCiMirrorWaiters(ctx, jobId);
    return null;
  },
});
