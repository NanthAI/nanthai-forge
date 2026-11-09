// SPDX-License-Identifier: Apache-2.0
// The forge/verify commit status on a pull request head (two-way sync, Issue 0b481f5f). Default
// runtime: the status write needs only fetch and the App token module.
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './_generated/server';
import { convexFetch } from './networkFetch';
import { installationTokenMinter, pullStatusPermissions } from './githubAppToken';
import { githubRequest, type GithubRequest } from '../src/hosted-github-api';
import { pullStatus, pullStatusContext, type PullStatus } from '../src/github-pull-check';

/** One status write. GitHub keeps every status; the newest per context decides the merge. */
export async function postPullStatus(
  api: GithubRequest,
  repository: string,
  sha: string,
  state: PullStatus['state'],
  description: string,
  link?: string | null,
) {
  const status = pullStatus(state, description);
  await api(`/repos/${repository}/statuses/${sha}`, 'POST', {
    state: status.state,
    context: pullStatusContext,
    description: status.description,
    ...(link?.startsWith('https://') ? { target_url: link } : {}),
  });
}
/** Status writes retried after a transient GitHub or network failure. When every attempt fails the
 * failure is recorded on the job (projectGithubPullStatusStore:statusFailed) and shown in the mirror
 * status with its next step; GitHub keeps the last accepted status, so merging stays blocked,
 * never silently allowed. */
const attempts = 3;
const postFailureCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,60}$/.test(code) ? code : 'GITHUB_STATUS_POST_FAILED';
};
/** The final forge/verify status: the App's token minted for statuses write on this one bound
 * repository, then one POST. Scheduled once per settled PR head. */
export const post = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    repository: v.string(),
    sha: v.string(),
    state: v.union(v.literal('pending'), v.literal('success'), v.literal('failure'), v.literal('error')),
    description: v.string(),
    link: v.union(v.string(), v.null()),
    attempt: v.optional(v.number()),
    /** The PR job this status settles; the failure after the last attempt is recorded on it. */
    jobId: v.optional(v.id('projectGithubMirrorJobs')),
    /** Set only by an owner re-post: a success then clears the recorded failure (one mutation). */
    clear: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const mint = await installationTokenMinter(ctx, input.projectId, input.repository);
      const api = githubRequest(await mint(pullStatusPermissions), convexFetch);
      await postPullStatus(api, input.repository, input.sha, input.state, input.description, input.link);
    } catch (error) {
      const attempt = (input.attempt ?? 1) + 1;
      if (attempt > attempts) {
        if (!input.jobId || input.state === 'pending') throw error;
        await ctx.runMutation(
          makeFunctionReference<'mutation'>('projectGithubPullStatusStore:statusFailed'),
          {
            jobId: input.jobId,
            state: input.state,
            description: input.description,
            error: postFailureCode(error),
          },
        );
        return null;
      }
      await ctx.scheduler.runAfter(
        30_000 * 2 ** (attempt - 2),
        makeFunctionReference<'action'>('projectGithubPullStatus:post'),
        { ...input, attempt },
      );
      return null;
    }
    if (input.clear && input.jobId)
      await ctx.runMutation(makeFunctionReference<'mutation'>('projectGithubPullStatusStore:statusPosted'), {
        jobId: input.jobId,
      });
    return null;
  },
});
