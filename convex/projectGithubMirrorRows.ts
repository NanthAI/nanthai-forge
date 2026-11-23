// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
const stopRow = (ctx: MutationCtx | QueryCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectGithubMirrorStops')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
/** A terminal failure now holds the mirror: record which job (failure path only). */
export async function markMirrorStop(
  ctx: MutationCtx,
  job: Pick<Doc<'projectGithubMirrorJobs'>, '_id' | 'projectId'>,
) {
  const old = await stopRow(ctx, job.projectId);
  if (old) await ctx.db.patch(old._id, { jobId: job._id });
  else await ctx.db.insert('projectGithubMirrorStops', { projectId: job.projectId, jobId: job._id });
}
/** A resume, retarget or bring-in moves the mirror past its stop; one indexed read, called only
 * on those rare transitions. */
export async function clearMirrorStop(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const stop = await stopRow(ctx, projectId);
  if (stop) await ctx.db.delete(stop._id);
}
/** Friction 28e84c06: a landed reply names a stopped mirror, so an agent never polls GitHub for a
 * commit that will not arrive. One indexed read while healthy; the job and project are read only
 * when a stop is recorded. A paused, disconnected or re-pointed mirror, a mirror whose active job
 * moved on, and a project Forge does not hold authority for are not reported. */
export async function stoppedMirror(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  const stop = await stopRow(ctx, projectId);
  if (!stop) return null;
  const [job, project, queue] = await Promise.all([
    ctx.db.get(stop.jobId),
    ctx.db.get(projectId),
    mirrorRow(ctx, projectId),
  ]);
  const mirror = project?.sourceAuthority?.mode === 'server' ? effectivePolicy(project).githubMirror : null;
  if (
    job?.status !== 'failed' ||
    queue?.activeId !== job._id ||
    !mirror?.autoPush ||
    job.repository.toLowerCase() !== mirror.repo.toLowerCase()
  )
    return null;
  return {
    repository: job.repository,
    error: job.error ?? 'GITHUB_SYNC_FAILED',
    state: job.state,
    receiptId: job.inbound ? null : job.receiptId,
  };
}
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
  job: Doc<'projectGithubMirrorJobs'> | null = null,
) {
  job ??= await ctx.db.get(input.jobId);
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
  // Only a stopped job has a stop row; a healthy resume reads nothing more.
  if (job.status === 'failed') await clearMirrorStop(ctx, job.projectId);
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
