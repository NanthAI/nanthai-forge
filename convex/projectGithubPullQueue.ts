// SPDX-License-Identifier: Apache-2.0
// Two-way sync PR checks, light side (the heavy side is convex/projectGithubPull.ts): the
// pull_request webhook, the composition and check-run completion hooks and the one settle path.
// convex/http.ts and the compose, check and mirror stores reach only this module, never the
// compose or check machinery (incident eb0491bb).
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { v } from 'convex/values';
import { internalMutation } from './server';
import { scheduleMirror } from './projectGithubMirrorRows';
import { parseInbound, twoWay } from './projectGithubInboundQueue';
import { accountFor } from './urlIdentity';
import type { HostedCheckRun } from '../src/hosted-check';
import { canonicalPayload } from '../src/hosted-source-operation';
import { hostedProjectRoot } from '../src/project-routes';
import { checkRunStatus, forkStatus, isPullOperation, type PullJob } from '../src/github-pull-check';
import type { InboundJob } from '../src/github-inbound-job';

type Job = Doc<'projectGithubMirrorJobs'>;
type Outcome = NonNullable<PullJob['outcome']>;
/** Pull jobs sort after an inbound push job (0) and before every publish (revision >= 1). */
const outcome = v.union(
  v.literal('success'),
  v.literal('failure'),
  v.literal('error'),
  v.literal('superseded'),
);
export const pullSequence = 0.5;
export const pullOf = (job: Job) => (job.inbound ? parseInbound(job).pull : undefined);
/** The Forge web page a status links to: the PR's Lane, else the project. Null without a
 * configured web URL (the status then carries no link). */
export async function projectLink(
  ctx: QueryCtx | MutationCtx,
  project: Doc<'hostedProjects'>,
  laneId?: string,
) {
  const web = process.env.FORGE_WEB_URL;
  const account = web && project.slug ? await accountFor(ctx, project.owner) : null;
  if (!web || !account?.handle || !project.slug) return null;
  const url = new URL(web);
  url.pathname = `${hostedProjectRoot(account.handle, project.slug)}${laneId ? `/lanes/${laneId}` : ''}`;
  url.search = '';
  url.hash = '';
  return url.href;
}
const descriptions: Record<Outcome, string> = {
  success: 'Forge check passed.',
  failure: 'Forge check failed.',
  error: 'Forge could not check this head.',
  superseded: 'Superseded by a newer push to this pull request.',
};
/** Record the final outcome once and schedule its one forge/verify write, plus the Lane's
 * retirement. Later events for this head change nothing. */
export async function settlePull(ctx: MutationCtx, job: Job, result: Outcome, description?: string) {
  const inbound = parseInbound(job),
    pull = inbound.pull;
  if (!pull || pull.outcome) return null;
  const project = await ctx.db.get(job.projectId);
  await ctx.db.patch(job._id, {
    inbound: canonicalPayload({ ...inbound, pull: { ...pull, outcome: result } } satisfies InboundJob),
    waitKey: undefined,
  });
  // A fork head that never ran closes its approval request (one indexed read, forks only).
  if (pull.approval && inbound.laneId)
    await endForkApproval(ctx, job.projectId, inbound.laneId, pull.approval);
  if (!project || project.removal) return null;
  await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectGithubPullStatus:post'), {
    projectId: project._id,
    repository: job.repository,
    sha: pull.head,
    state: result === 'superseded' ? 'error' : result,
    description: description ?? descriptions[result],
    link: await projectLink(ctx, project, inbound.laneId),
  });
  // Separate transaction: a Lane or run that cannot be retired never loses the status.
  if (inbound.laneId || pull.runId)
    await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectGithubPull:retire'), {
      jobId: job._id,
    });
  return null;
}

/** Close a fork PR head's open approval request (its run started, or the head settled). */
export async function endForkApproval(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  operationId: string,
) {
  const row = await ctx.db
    .query('projectHostedApprovals')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();
  if (row?.pullRequest === undefined || row.operationId !== operationId || row.ended) return;
  await ctx.db.patch(row._id, {
    live: false,
    ended: { kind: 'settled', at: Date.now() },
    version: row.version + 1,
  });
}
const waiting = (ctx: MutationCtx, projectId: Id<'hostedProjects'>, key: string) =>
  ctx.db
    .query('projectGithubMirrorJobs')
    .withIndex('by_project_and_wait', q => q.eq('projectId', projectId).eq('waitKey', key))
    .take(1);
/** A composition settled (writeComposeState): one indexed read, empty unless a PR job waits on
 * it; that job starts its check in its own transactions. */
export async function notifyPullCompose(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  operationId: string,
) {
  if (!isPullOperation(operationId)) return;
  const [job] = await waiting(ctx, projectId, operationId);
  if (job)
    await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectGithubPull:start'), {
      jobId: job._id,
      key: operationId,
    });
}
/** A check run ended (completeHostedCheck): one indexed read; a PR job waiting on it settles. */
export async function notifyPullCheck(ctx: MutationCtx, run: HostedCheckRun) {
  if (!isPullOperation(run.request.operationId)) return;
  const [job] = await waiting(ctx, run.projectId as Id<'hostedProjects'>, run.id);
  if (!job) return;
  const status = checkRunStatus(run.status);
  await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectGithubPullQueue:settle'), {
    jobId: job._id,
    outcome: status.state === 'pending' ? 'error' : status.state,
    description: status.description,
    runId: run.id,
  });
}

/** The owner decided a fork PR head's run request (projectHostedApprovals decide/withdraw): one
 * indexed read. A grant starts the check-only run; a decline or withdrawal settles the head with
 * that reason. A request whose head already settled finds no job and changes nothing. */
export async function notifyPullApproval(
  ctx: MutationCtx,
  row: { projectId: Id<'hostedProjects'>; operationId: string },
  status: 'granted' | 'declined' | 'withdrawn',
) {
  const [job] = await waiting(ctx, row.projectId, row.operationId);
  if (!job) return;
  if (status === 'granted')
    await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectGithubPull:start'), {
      jobId: job._id,
      key: row.operationId,
    });
  else await settlePull(ctx, job, 'error', forkStatus[status]);
}
/** A fork PR head nobody approved: scheduled once when it asked, a no-op once it ran or settled. */
export const expire = internalMutation({
  args: { jobId: v.id('projectGithubMirrorJobs'), key: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const job = await ctx.db.get(input.jobId);
    if (!job || job.waitKey !== input.key) return null;
    return settlePull(ctx, job, 'error', forkStatus.expired);
  },
});

/** HMAC-verified pull_request webhook (convex/http.ts): one indexed mirror read; a repository
 * without two-way sync writes nothing. Redelivery of a known head is a no-op. */
export const receive = internalMutation({
  args: { repository: v.string(), number: v.number(), head: v.string(), fork: v.boolean() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const key = input.repository.toLowerCase();
    for (const queue of await ctx.db
      .query('projectGithubMirrors')
      .withIndex('by_repository_key', q => q.eq('repositoryKey', key))
      .take(8)) {
      const project = await ctx.db.get(queue.projectId);
      const policy = twoWay(project);
      if (!policy || policy.repo.toLowerCase() !== key) continue;
      const pullKey = String(input.number);
      const older = await ctx.db
        .query('projectGithubMirrorJobs')
        .withIndex('by_project_and_pull', q => q.eq('projectId', queue.projectId).eq('pullKey', pullKey))
        .order('desc')
        .take(10);
      if (older.some(job => pullOf(job)?.head === input.head)) continue;
      for (const job of older) {
        const pull = pullOf(job);
        if (!pull || pull.outcome) continue;
        // Not started: drop it; it posted nothing. Checking: settle it superseded (its run is
        // cancelled). Still reading or composing: it sees the newer head when it reaches land.
        if (job.status === 'queued' && queue.activeId !== job._id)
          await ctx.db.patch(job._id, {
            status: 'done',
            step: job.step + 1,
            detail: 'Superseded by a newer head of this pull request before it ran.',
            inbound: canonicalPayload({
              ...parseInbound(job),
              pull: { ...pull, outcome: 'superseded' },
            } satisfies InboundJob),
          });
        else if (parseInbound(job).phase === 'checking') await settlePull(ctx, job, 'superseded');
      }
      const id = await ctx.db.insert('projectGithubMirrorJobs', {
        projectId: project!._id,
        receiptId: `pull:${crypto.randomUUID()}`,
        sequence: pullSequence,
        repository: queue.repository,
        authorityEpoch: project!.sourceAuthority!.epoch,
        status: 'queued',
        step: 0,
        cursor: null,
        state: '0'.repeat(64),
        pullKey,
        inbound: canonicalPayload({
          phase: 'pending',
          pull: { number: input.number, head: input.head, fork: input.fork },
        } satisfies InboundJob),
      });
      if (!queue.activeId) {
        await ctx.db.patch(queue._id, { activeId: id });
        await scheduleMirror(ctx, { _id: id, step: 0 });
      }
    }
    return null;
  },
});

export const settle = internalMutation({
  args: {
    jobId: v.id('projectGithubMirrorJobs'),
    outcome,
    description: v.optional(v.string()),
    runId: v.optional(v.string()),
    waitKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const job = await ctx.db.get(input.jobId);
    if (!job) return null;
    const pull = pullOf(job);
    if (input.runId && pull?.runId !== input.runId) return null;
    if (input.waitKey && job.waitKey !== input.waitKey) return null;
    return settlePull(ctx, job, input.outcome, input.description);
  },
});
