// SPDX-License-Identifier: Apache-2.0
// The owner's way to resume a stopped GitHub mirror (Issue 68361cd5, SM-E): `nforge github resume`
// and Resume in the web mirror panel. The operator mutation (projectGithubMirrorStore:resume) stays.
import { v } from 'convex/values';
import { mutation } from './cliServer';
import { activeOwnedProject } from './projectAuthority';
import { report } from './errors';
import { invariant } from '../src/errors';
import { effectivePolicy } from '../src/autonomy-policy';
import { mirrorRow } from './projectGithubMirrorRows';
import { resumeMirrorJob } from './projectGithubMirrorStore';
import { retargetGithubMirror } from './projectGithubMirrorRetarget';
import { repostPullStatus } from './projectGithubPullStatusStore';

/** Retry-safe by state: a second call finds the job running (`already-running`) or nothing left.
 * Reads the queue row and at most its active job; schedules at most one mirror step and one
 * forge/verify re-post. Owner only, like the policy that points the mirror. */
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
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to resume the GitHub mirror.');
      const project = await activeOwnedProject(ctx, input.projectId, user.subject);
      const policy = effectivePolicy(project).githubMirror;
      invariant(
        project.sourceAuthority?.mode === 'server' && policy?.autoPush,
        'GITHUB_SYNC_DISABLED',
        'This project has no automatic GitHub mirror to resume.',
      );
      const statusReposted = await repostPullStatus(ctx, project._id);
      if (await retargetGithubMirror(ctx, project._id, policy.repo))
        return { status: 'retargeted' as const, jobId: null, step: null, statusReposted };
      const queue = await mirrorRow(ctx, project._id);
      if (!queue?.activeId)
        return { status: 'nothing-to-resume' as const, jobId: null, step: null, statusReposted };
      const result = await resumeMirrorJob(ctx, queue.activeId);
      return {
        status: result.status === 'missing' ? ('nothing-to-resume' as const) : result.status,
        jobId: queue.activeId,
        step: result.step,
        statusReposted,
      };
    } catch (error) {
      return report(error);
    }
  },
});
