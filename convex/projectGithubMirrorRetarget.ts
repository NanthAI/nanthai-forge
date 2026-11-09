// SPDX-License-Identifier: Apache-2.0
// The mirror repository changed (Issue 68361cd5, SM-E): re-point the queue row, off the landing
// hot path. `projectGithubMirrors.repository` was written only at insert, so every later publish
// became a failed job that never became active and no surface showed it.
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { mirrorRow } from './projectGithubMirrorRows';
import { queuedJobs } from './projectGithubInboundQueue';

/** Failed publish jobs that are not the queue's active job: a retarget's binding failures. Pull
 * request and inbound jobs fail without holding the queue and say why elsewhere, so they are
 * not counted. One indexed read, bounded. */
export async function strandedMirrorJobs(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  activeId: Id<'projectGithubMirrorJobs'> | null,
) {
  const failed = await ctx.db
    .query('projectGithubMirrorJobs')
    .withIndex('by_project_and_status_and_sequence', q => q.eq('projectId', projectId).eq('status', 'failed'))
    .order('desc')
    .take(10);
  return failed.filter(job => job._id !== activeId && !job.pullKey && !job.inbound);
}
const superseded = (repo: string) =>
  `Mirror repository changed to ${repo}; its next publish seeds the new repository from Forge main.`;
/** Point the queue at `repo`, drop what belonged to the old repository (its mapping and its open or
 * stranded publish jobs, marked done with this reason) and leave the queue idle: the next accepted
 * State enqueues a normal job. A case-only change keeps the mapping. Returns whether it changed. */
export async function retargetGithubMirror(ctx: MutationCtx, projectId: Id<'hostedProjects'>, repo: string) {
  const queue = await mirrorRow(ctx, projectId);
  if (!queue || queue.repository === repo) return false;
  if (queue.repository.toLowerCase() === repo.toLowerCase()) {
    await ctx.db.patch(queue._id, { repository: repo, repositoryKey: repo.toLowerCase() });
    return true;
  }
  const open: Doc<'projectGithubMirrorJobs'>[] = [];
  if (queue.activeId) {
    const active = await ctx.db.get(queue.activeId);
    if (active && !['done', 'failed'].includes(active.status)) open.push(active);
  }
  open.push(...(await queuedJobs(ctx, projectId, 100)).filter(job => job._id !== queue.activeId));
  open.push(...(await strandedMirrorJobs(ctx, projectId, null)));
  for (const job of open)
    await ctx.db.patch(job._id, { status: 'done', step: job.step + 1, detail: superseded(repo) });
  await ctx.db.patch(queue._id, {
    repository: repo,
    repositoryKey: repo.toLowerCase(),
    activeId: null,
    mapping: null,
    mirroredAt: undefined,
    inbound: undefined,
  });
  return true;
}
