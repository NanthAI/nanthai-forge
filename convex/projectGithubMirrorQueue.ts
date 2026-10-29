// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import { effectivePolicy } from '../src/autonomy-policy';
import { invariant } from '../src/errors';
export const mirrorRow = (ctx: MutationCtx | QueryCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectGithubMirrors')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
export async function scheduleMirror(
  ctx: MutationCtx,
  job: Pick<Doc<'projectGithubMirrorJobs'>, '_id' | 'step'>,
) {
  const scheduledId = await ctx.scheduler.runAfter(
    0,
    makeFunctionReference<'action'>('projectGithubMirror:step'),
    { jobId: job._id, step: job.step },
  );
  await ctx.db.patch(job._id, { scheduledId });
}
/** Publication and wake are one transaction. No watcher, timer or idle job. */
export async function enqueueGithubMirror(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  receipt: HostedAcceptance,
) {
  const policy = effectivePolicy(project).githubMirror;
  if (project.sourceAuthority?.mode !== 'server' || !policy?.autoPush) return;
  const old = await ctx.db
    .query('projectGithubMirrorJobs')
    .withIndex('by_project_and_receipt', q => q.eq('projectId', project._id).eq('receiptId', receipt.id))
    .unique();
  if (old) return;
  let queue = await mirrorRow(ctx, project._id);
  if (!queue) {
    const id = await ctx.db.insert('projectGithubMirrors', {
      projectId: project._id,
      repository: policy.repo,
      activeId: null,
      mapping: null,
    });
    queue = (await ctx.db.get(id))!;
  }
  const jobId = await ctx.db.insert('projectGithubMirrorJobs', {
    projectId: project._id,
    receiptId: receipt.id,
    sequence: receipt.snapshot.revision,
    repository: policy.repo,
    authorityEpoch: receipt.authorityEpoch,
    status: queue.repository === policy.repo ? 'queued' : 'failed',
    step: 0,
    cursor: null,
    state: receipt.candidate.head,
    ...(queue.repository === policy.repo ? {} : { error: 'GITHUB_SYNC_BINDING' }),
  });
  if (!queue.activeId && queue.repository === policy.repo) {
    await ctx.db.patch(queue._id, { activeId: jobId });
    await scheduleMirror(ctx, { _id: jobId, step: 0 });
  }
}
export async function mirrorJob(
  ctx: MutationCtx | QueryCtx,
  input: { jobId: Id<'projectGithubMirrorJobs'>; step: number },
) {
  const job = await ctx.db.get(input.jobId);
  if (!job || job.step !== input.step || ['done', 'failed'].includes(job.status)) return null;
  const queue = await mirrorRow(ctx, job.projectId);
  if (queue?.activeId !== job._id) return null;
  const project = await ctx.db.get(job.projectId);
  invariant(
    project &&
      !project.removal &&
      project.sourceAuthority?.mode === 'server' &&
      project.sourceAuthority.epoch === job.authorityEpoch,
    'SOURCE_AUTHORITY_CHANGED',
    'Hosted mirror authority changed. Retain this job for reconciliation.',
  );
  const policy = effectivePolicy(project).githubMirror;
  invariant(
    policy?.autoPush && policy.repo === job.repository,
    'GITHUB_SYNC_DISABLED',
    'Hosted mirror policy changed.',
  );
  return { job, queue, project };
}
