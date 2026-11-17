// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { cancelPendingTask } from './schedulerCancel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { effectivePolicy } from '../src/autonomy-policy';
import { invariant } from '../src/errors';
/** Mirror queue row access shared by publish and two-way sync; a leaf so neither imports the other. */
export const mirrorRow = (ctx: MutationCtx | QueryCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectGithubMirrors')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
/** The queue row both webhooks and publishes need; absent until a project connects two-way sync or
 * lands. Idempotent: one indexed read, one insert only when missing (friction 77518c88). */
export async function ensureMirrorRow(ctx: MutationCtx, projectId: Id<'hostedProjects'>, repo: string) {
  const old = await mirrorRow(ctx, projectId);
  if (old) return old;
  const id = await ctx.db.insert('projectGithubMirrors', {
    projectId,
    repository: repo,
    repositoryKey: repo.toLowerCase(),
    activeId: null,
    mapping: null,
  });
  return (await ctx.db.get(id))!;
}
export async function scheduleMirror(
  ctx: MutationCtx,
  job: Pick<Doc<'projectGithubMirrorJobs'>, '_id' | 'step'>,
  delay = 0,
) {
  const scheduledId = await ctx.scheduler.runAfter(
    delay,
    makeFunctionReference<'action'>('projectGithubMirror:step'),
    { jobId: job._id, step: job.step },
  );
  await ctx.db.patch(job._id, { scheduledId });
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
    policy?.autoPush && policy.repo.toLowerCase() === job.repository.toLowerCase(),
    'GITHUB_SYNC_DISABLED',
    'Hosted mirror policy changed.',
  );
  return { job, queue, project };
}

/** Explicit recovery of the same cursor, fencing failed or expired workers. Shared by the
 * operator mutation in projectGithubMirrorStore and the owner command (projectGithubMirrorResume). A person un-pausing
 * replaces even a live task: an old worker may still be reporting that it observed the pause. */
export async function resumeMirrorJob(
  ctx: MutationCtx,
  jobId: Id<'projectGithubMirrorJobs'>,
  replaceTask = false,
) {
  const job = await ctx.db.get(jobId);
  if (!job) return { status: 'missing' as const, step: null };
  if (job.status === 'done') return { status: 'done' as const, step: job.step };
  const queue = await mirrorRow(ctx, job.projectId);
  invariant(queue?.activeId === job._id, 'GITHUB_SYNC_PENDING', 'Resume the active retained mirror job.');
  const task = job.scheduledId ? await ctx.db.system.get(job.scheduledId) : null;
  const live = task && ['pending', 'inProgress'].includes(task.state.kind);
  // Actions have a ten-minute runtime limit. A future backoff is still live;
  // an overdue task beyond that window is recoverable by explicit resume.
  if (!replaceTask && live && job.status !== 'failed' && task.scheduledTime + 11 * 60_000 > Date.now())
    return { status: 'already-running' as const, step: job.step };
  if (live) await cancelPendingTask(ctx, task._id, task);
  const step = job.step + 1;
  await ctx.db.patch(job._id, {
    status: 'running',
    step,
    failures: 0,
    nextAttemptAt: undefined,
    error: undefined,
    detail: undefined,
    httpStatus: undefined,
    apiOperation: undefined,
    requestBytes: undefined,
  });
  await mirrorJob(ctx, { jobId: job._id, step });
  await scheduleMirror(ctx, { _id: job._id, step });
  return { status: 'scheduled' as const, step };
}
