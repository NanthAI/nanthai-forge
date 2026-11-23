// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The forge/verify commit status on a pull request head (two-way sync, Issue 0b481f5f). Default
// runtime: the status write needs only fetch and the App token module.
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, type ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { convexFetch } from './networkFetch';
import { installationTokenMinter, pullStatusPermissions } from './githubAppToken';
import { githubRequest, type GithubRequest } from '../src/hosted-github-api';
import {
  pullOutcomeDescriptions,
  pullStatus,
  pullStatusContext,
  type PullStatus,
} from '../src/github-pull-check';

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
/** The form this post sends, read just before the write (Item 966cb821). A status queued while its project
 * was public carries a `privateForm`; one read of the project's visibility picks it when the project has since
 * gone private, been trashed or gone. A status queued private is marked `checked` and reads nothing. A payload
 * with neither mark was queued before this check existed: it is read too, and a non-public project then gets
 * no link and the fixed sentence for the state. */
export async function statusToPost(
  ctx: Pick<ActionCtx, 'runQuery'>,
  input: {
    projectId: Id<'hostedProjects'>;
    state: PullStatus['state'];
    description: string;
    link: string | null;
    privateForm?: StatusForm;
    checked?: boolean;
  },
): Promise<StatusForm> {
  if (input.checked) return { description: input.description, link: input.link };
  const open = await ctx.runQuery(makeFunctionReference<'query'>('projectGithubPullStatusStore:publicNow'), {
    projectId: input.projectId,
  });
  if (open) return { description: input.description, link: input.link };
  return input.privateForm ?? { description: pullOutcomeDescriptions[input.state], link: null };
}
type StatusForm = { description: string; link: string | null };
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
    /** What to send instead when the project is no longer public at post time (statusToPost). */
    privateForm: v.optional(v.object({ description: v.string(), link: v.union(v.string(), v.null()) })),
    /** Set when the form was chosen for a project that was already non-public: nothing to re-check. */
    checked: v.optional(v.boolean()),
    attempt: v.optional(v.number()),
    /** The PR job this status settles; the failure after the last attempt is recorded on it. */
    jobId: v.optional(v.id('projectGithubMirrorJobs')),
    /** Set only by an owner re-post: a success then clears the recorded failure (one mutation). */
    clear: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    // Safe until the visibility read succeeds: a recorded failure never keeps the public detail.
    let form: StatusForm =
      input.privateForm ??
      (input.checked ? input : { description: pullOutcomeDescriptions[input.state], link: null });
    try {
      const mint = await installationTokenMinter(ctx, input.projectId, input.repository);
      const token = await mint(pullStatusPermissions);
      // Each attempt re-checks, after the slow minting and just before the write.
      form = await statusToPost(ctx, input);
      const api = githubRequest(token, convexFetch);
      await postPullStatus(api, input.repository, input.sha, input.state, form.description, form.link);
    } catch (error) {
      const attempt = (input.attempt ?? 1) + 1;
      if (attempt > attempts) {
        if (!input.jobId || input.state === 'pending') throw error;
        await ctx.runMutation(
          makeFunctionReference<'mutation'>('projectGithubPullStatusStore:statusFailed'),
          {
            jobId: input.jobId,
            state: input.state,
            description: form.description,
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
