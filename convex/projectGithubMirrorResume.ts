// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The owner's way to resume a stopped GitHub mirror (Issue 68361cd5, SM-E): `nforge github resume`
// and Resume in the web mirror panel. The operator mutation (projectGithubMirrorStore:resume) stays.
import { v } from 'convex/values';
import { mutation } from './cliServer';
import { activeOwnedProject } from './projectAuthority';
import { report } from './errors';
import { invariant } from '../src/errors';
import { effectivePolicy } from '../src/autonomy-policy';
import { resumeMirrorQueue } from './projectGithubMirrorCatchup';
import { retargetGithubMirror } from './projectGithubMirrorRetarget';
import { repostPullStatus } from './projectGithubPullStatusStore';
import { requireOwnerPerson } from './ownerPerson';
import { mirrorRow } from './projectGithubMirrorRows';
import { yieldToInbound } from './projectGithubInboundQueue';
import { repostMainStatus } from './projectGithubMirrorVerify';

/** Retry-safe by state: a second call finds the job running (`already-running`) or nothing left.
 * Reads the queue row and at most its active job; schedules at most one mirror step and one
 * forge/verify re-post. Owner devices may recover enabled work; only the person may un-pause in set-policy. */
export const resume = mutation({
  args: { projectId: v.id('hostedProjects') },
  returns: v.object({
    status: v.union(
      v.literal('scheduled'),
      v.literal('already-running'),
      v.literal('done'),
      v.literal('retargeted'),
      v.literal('nothing-to-resume'),
    ),
    jobId: v.union(v.string(), v.null()),
    step: v.union(v.number(), v.null()),
    /** A recorded forge/verify post that failed was scheduled again. */
    statusReposted: v.boolean(),
  }),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to recover the GitHub mirror.');
      const project = await activeOwnedProject(ctx, input.projectId, user.subject);
      const policy = effectivePolicy(project).githubMirror;
      invariant(
        project.sourceAuthority?.mode === 'server' && policy?.autoPush,
        'GITHUB_SYNC_DISABLED',
        'This project has no automatic GitHub mirror to resume.',
      );
      const repostedPull = await repostPullStatus(ctx, project._id);
      const retargeted = await retargetGithubMirror(ctx, project._id, policy.repo);
      const resumed = await resumeMirrorQueue(ctx, project);
      const statusReposted = (await repostMainStatus(ctx, project._id)) || repostedPull;
      return { ...resumed, ...(retargeted ? { status: 'retargeted' as const } : {}), statusReposted };
    } catch (error) {
      return report(error);
    }
  },
});
/** Item c63c2171: GitHub's main moved without Forge on a one-way mirror, and the owner person chooses
 * GitHub's commit with one press. The stopped publish waits behind one inbound job for GitHub's head,
 * the same job two-way sync queues by itself: the commit lands through the normal checks as the
 * owner's `github-inbound` agent, then the publish re-seeds on top of it. Nothing is written to GitHub
 * here. Retry-safe by state: a second press finds the inbound job active. Reads the queue row and its
 * active job; writes the job, the queue row and one inbound job; schedules one mirror step. */
export const bringIn = mutation({
  args: { projectId: v.id('hostedProjects') },
  returns: v.object({
    status: v.union(v.literal('bringing-in'), v.literal('already-running')),
    jobId: v.string(),
  }),
  handler: async (ctx, input) => {
    try {
      const user = await requireOwnerPerson(ctx, 'choose which main to keep');
      const project = await activeOwnedProject(ctx, input.projectId, user.subject);
      const policy = effectivePolicy(project).githubMirror;
      invariant(
        project.sourceAuthority?.mode === 'server' && policy?.autoPush,
        'GITHUB_SYNC_DISABLED',
        'This project has no automatic GitHub mirror to bring a commit in from.',
      );
      const queue = await mirrorRow(ctx, project._id);
      const active = queue?.activeId ? await ctx.db.get(queue.activeId) : null;
      if (queue && active?.inbound && !active.pullKey && !['done', 'failed'].includes(active.status))
        return { status: 'already-running' as const, jobId: active._id };
      invariant(
        queue &&
          active &&
          !active.inbound &&
          !active.pullKey &&
          active.status === 'failed' &&
          active.error === 'GITHUB_SYNC_CHANGED' &&
          active.repository.toLowerCase() === policy.repo.toLowerCase(),
        'GITHUB_SYNC_PENDING',
        'The mirror is not stopped on a GitHub main that moved without Forge; there is no GitHub commit to bring in.',
      );
      return {
        status: 'bringing-in' as const,
        jobId: await yieldToInbound(ctx, project, queue, active, true),
      };
    } catch (error) {
      return report(error);
    }
  },
});
