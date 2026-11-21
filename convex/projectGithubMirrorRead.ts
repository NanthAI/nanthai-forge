// SPDX-License-Identifier: Apache-2.0
// The GitHub mirror for members (Item c63c2171): direction, the two ends and the one sentence that the web
// Mirror screen and `nforge github status` both show. One project read plus the mirror status rows
// (githubMirrorStatus: three selected rows on the healthy path); it re-runs only on mirror or policy
// writes, never on a timer.
import { v } from 'convex/values';
import { query, isDeviceIdentity } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { effectivePolicy } from '../src/autonomy-policy';
import { githubMirrorStatus } from './projectGithubMirrorStatus.idle';
import { mirrorSummary } from '../src/github-mirror-sentence';
import { invariant } from '../src/errors';
import { report } from './errors';
import { mirrorResumeInbound } from './projectGithubMirrorDirection';

export const read = query({
  args: { projectId: v.id('hostedProjects') },
  returns: v.object({
    repository: v.union(v.string(), v.null()),
    direction: v.union(v.literal('off'), v.literal('one-way'), v.literal('two-way')),
    state: v.string(),
    weight: v.union(v.literal('act'), v.literal('watch'), v.literal('reference')),
    sentence: v.string(),
    next: v.union(v.string(), v.null()),
    kept: v.optional(v.literal(true)),
    /** The two ends: Forge main's State and the GitHub commit it was last pushed as. */
    ends: v.union(
      v.object({
        forgeHead: v.union(v.string(), v.null()),
        mirroredHead: v.union(v.string(), v.null()),
        gitHead: v.union(v.string(), v.null()),
        mirroredAt: v.union(v.number(), v.null()),
        pendingSince: v.union(v.number(), v.null()),
        error: v.union(v.string(), v.null()),
        detail: v.union(v.string(), v.null()),
      }),
      v.null(),
    ),
    repoId: v.union(v.number(), v.null()),
    inbound: v.boolean(),
    /** The owner may change the mirror; others read it. */
    owner: v.boolean(),
  }),
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read the GitHub mirror.');
      const project = await accessibleProject(ctx, projectId, user.subject);
      const policy = effectivePolicy(project).githubMirror;
      const status = policy ? await githubMirrorStatus(ctx, project) : null;
      const owner = project.owner === user.subject && !isDeviceIdentity(user);
      const binding =
        owner && policy
          ? await ctx.db
              .query('projectGithubBindings')
              .withIndex('by_project_and_name', q =>
                q.eq('projectId', projectId).eq('fullName', policy.repo.toLowerCase()),
              )
              .first()
          : null;
      return {
        ...mirrorSummary(
          policy ? { ...policy, paused: project.githubMirrorPausedInbound !== undefined } : policy,
          status,
        ),
        ends: status
          ? {
              forgeHead: status.targetHead,
              mirroredHead: status.mirroredHead,
              gitHead: status.gitHead,
              mirroredAt: status.mirroredAt,
              pendingSince: status.pendingSince,
              error: status.error,
              detail: status.detail,
            }
          : null,
        owner,
        repoId: binding?.repoId ?? null,
        inbound: await mirrorResumeInbound(ctx, project),
      };
    } catch (error) {
      return report(error);
    }
  },
});
