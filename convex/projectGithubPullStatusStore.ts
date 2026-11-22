// SPDX-License-Identifier: Apache-2.0
// Whether a pull request head's final forge/verify status reached GitHub (Issue 68361cd5, SM-E).
// Recorded only on failure (healthy posts write nothing), so a settled head is never mistaken for
// a posted one while GitHub still shows the last accepted status.
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, internalQuery, type MutationCtx } from './server';
import type { Doc } from './_generated/dataModel';
import { parseInbound } from './projectGithubInboundQueue';
import { queuedStatus } from './projectGithubPullQueue';
import { isPrivateSafeDescription, pullOutcomeDescriptions } from '../src/github-pull-check';
import { canonicalPayload } from '../src/hosted-source-operation';
import type { InboundJob } from '../src/github-inbound-job';
import { mirrorRow } from './projectGithubMirrorRows';

type Job = Doc<'projectGithubMirrorJobs'>;
type StatusPost = NonNullable<NonNullable<InboundJob['pull']>['statusPost']>;
const withStatusPost = (job: Job, statusPost: StatusPost | undefined) => {
  const inbound = parseInbound(job);
  const pull: NonNullable<InboundJob['pull']> = { ...inbound.pull! };
  if (statusPost) pull.statusPost = statusPost;
  else delete pull.statusPost;
  return canonicalPayload({ ...inbound, pull } satisfies InboundJob);
};
/** Whether the project is public and live right now: the one read a queued public status makes just
 * before it posts (Item 966cb821). Gone or removed counts as not public, so the private form is sent. */
export const publicNow = internalQuery({
  args: { projectId: v.id('hostedProjects') },
  returns: v.boolean(),
  handler: async (ctx, { projectId }) => {
    const project = await ctx.db.get(projectId);
    return !!project && !project.removal && project.visibility === 'public';
  },
});
/** The last attempt failed: name the head on the job and point the queue row at it (one pointer, so
 * the status read needs one `get` only while this exists). */
export const statusFailed = internalMutation({
  args: {
    jobId: v.id('projectGithubMirrorJobs'),
    state: v.union(v.literal('success'), v.literal('failure'), v.literal('error')),
    description: v.string(),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const job = await ctx.db.get(input.jobId);
    const pull = job?.inbound ? parseInbound(job).pull : undefined;
    if (!job || !pull?.outcome) return null;
    const queue = await mirrorRow(ctx, job.projectId);
    if (!queue) return null;
    await ctx.db.patch(job._id, {
      inbound: withStatusPost(job, {
        state: input.state,
        description: input.description.slice(0, 200),
        error: input.error,
      }),
    });
    await ctx.db.patch(queue._id, { verifyFailedId: job._id });
    return null;
  },
});
/** A re-post reached GitHub. */
export const statusPosted = internalMutation({
  args: { jobId: v.id('projectGithubMirrorJobs') },
  returns: v.null(),
  handler: async (ctx, input) => {
    const job = await ctx.db.get(input.jobId);
    if (!job?.inbound || !parseInbound(job).pull?.statusPost) return null;
    await ctx.db.patch(job._id, { inbound: withStatusPost(job, undefined) });
    const queue = await mirrorRow(ctx, job.projectId);
    if (queue?.verifyFailedId === job._id) await ctx.db.patch(queue._id, { verifyFailedId: undefined });
    return null;
  },
});
/** A recorded description is reposted for a project that is no longer public only when it already is the
 * private form (isPrivateSafeDescription, matched in full); anything else gets the fixed sentence for the state. */
const safeDescription = (description: string, state: StatusPost['state']) =>
  isPrivateSafeDescription(description) ? description : pullOutcomeDescriptions[state];
/** Owner re-post of the recorded failed status (nforge github resume): the same state and text,
 * one scheduled post whose success clears the record. False when nothing is recorded. */
export async function repostPullStatus(ctx: MutationCtx, projectId: Job['projectId']) {
  const queue = await mirrorRow(ctx, projectId);
  if (!queue?.verifyFailedId) return false;
  const job = await ctx.db.get(queue.verifyFailedId);
  const inbound = job?.inbound ? parseInbound(job) : null;
  const statusPost = inbound?.pull?.statusPost;
  const project = await ctx.db.get(projectId);
  if (!job || !inbound || !statusPost || !project || project.removal) {
    if (!statusPost) await ctx.db.patch(queue._id, { verifyFailedId: undefined });
    return false;
  }
  await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectGithubPullStatus:post'), {
    projectId,
    repository: job.repository,
    sha: inbound.pull!.head,
    state: statusPost.state,
    ...(await queuedStatus(
      ctx,
      project,
      inbound.laneId,
      statusPost.description,
      safeDescription(statusPost.description, statusPost.state),
    )),
    jobId: job._id,
    clear: true,
  });
  return true;
}
