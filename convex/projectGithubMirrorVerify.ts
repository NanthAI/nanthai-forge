// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './server';
import { internalAction, internalQuery } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { githubSyncCommitSchema } from '../src/github-sync-types';
import type { HostedCheckRun } from '../src/hosted-check';
import { auditMetadata } from '../src/main-audit';
import { githubRequest } from '../src/hosted-github-api';
import { installationTokenMinter, pullStatusPermissions } from './githubAppToken';
import { mirrorRow } from './projectGithubMirrorRows';
import { mirrorAudit, wakeHeldMirror } from './projectGithubMirrorCadence';
import { writeMirrorVerification, type MirrorVerification } from './projectGithubMirrorVerifyStatus';
import { effectivePolicy } from '../src/autonomy-policy';
import { mirrorCheckSamples } from '../src/hosted-github-mirror-status';
import { fullCheckWall } from './projectHostedCheckClock';

const pageSize = 12;
const projectId = v.id('hostedProjects');
const verdict = v.union(v.literal('success'), v.literal('failure'));
const state = v.union(verdict, v.literal('pending'));
const jobId = v.id('projectGithubMirrorJobs');
const entry = v.object({
  jobId,
  sha: v.string(),
  state,
  link: v.union(v.string(), v.null()),
});
const action = (name: string) => makeFunctionReference<'action'>(`projectGithubMirrorVerify:${name}`);
const mutation = (name: string) => makeFunctionReference<'mutation'>(`projectGithubMirrorVerify:${name}`);
type Queue = Doc<'projectGithubMirrors'>;
type Job = Doc<'projectGithubMirrorJobs'>;

function verifyEntry(
  job: Pick<Job, 'mapping' | 'verifyLink'>,
  project: Pick<Doc<'hostedProjects'>, 'visibility'>,
) {
  return {
    sha: githubSyncCommitSchema.parse(JSON.parse(job.mapping!)).commit,
    // Item d357d772: a link pinned earlier never names a private project on GitHub.
    link: project.visibility === 'public' ? (job.verifyLink ?? null) : null,
  };
}

export async function retryMirrorVerification(
  ctx: MutationCtx,
  queue: Queue,
  ids: Id<'projectGithubMirrorJobs'>[],
  attempt = 0,
) {
  await ctx.scheduler.runAfter(0, action('post'), {
    projectId: queue.projectId,
    repository: queue.repository,
    ids,
    attempt,
  });
}

async function settle(
  ctx: MutationCtx,
  queue: Queue,
  sequence: number,
  desired: Exclude<MirrorVerification, 'pending'>,
) {
  const jobs = await ctx.db
    .query('projectGithubMirrorJobs')
    .withIndex('by_project_and_repository_and_verify_and_sequence', q =>
      desired === 'failure'
        ? q
            .eq('projectId', queue.projectId)
            .eq('repositoryKey', queue.repository.toLowerCase())
            .eq('verify', 'pending')
            .eq('sequence', sequence)
        : q
            .eq('projectId', queue.projectId)
            .eq('repositoryKey', queue.repository.toLowerCase())
            .eq('verify', 'pending')
            .lte('sequence', sequence),
    )
    .take(pageSize);
  const pendingVerify = Math.max(0, (queue.pendingVerify ?? jobs.length) - jobs.length);
  // An authoritative failed audit can override a previous success for that exact State.
  if (desired === 'failure' && !jobs.length) {
    const verified = await ctx.db
      .query('projectGithubMirrorJobs')
      .withIndex('by_project_and_repository_and_verify_and_sequence', q =>
        q
          .eq('projectId', queue.projectId)
          .eq('repositoryKey', queue.repository.toLowerCase())
          .eq('verify', 'success')
          .eq('sequence', sequence),
      )
      .first();
    if (verified) jobs.push(verified);
  }
  if (!jobs.length) return queue;
  for (const job of jobs) await ctx.db.patch(job._id, { verify: desired });
  await ctx.db.patch(queue._id, { pendingVerify });
  await retryMirrorVerification(
    ctx,
    queue,
    jobs.map(job => job._id),
  );
  if (jobs.length === pageSize)
    await ctx.scheduler.runAfter(0, mutation('settlePage'), {
      projectId: queue.projectId,
      repository: queue.repository,
      sequence,
      state: desired,
    });
  return { ...queue, pendingVerify };
}

export const notifyMirrorCoverage = (ctx: MutationCtx, queue: Queue, sequence: number) =>
  settle(ctx, queue, sequence, 'success');

/** Record compact timing on connected mirrors only. The terminal audit can also settle statuses. */
export async function noteMirrorCheck(ctx: MutationCtx, run: HostedCheckRun) {
  if (run.status !== 'passed' && run.status !== 'failed') return;
  const wall = fullCheckWall(run);
  const terminalAudit = run.gate?.mode === 'audit';
  if (wall === undefined && !terminalAudit) return;
  const id = run.projectId as Id<'hostedProjects'>;
  const queue = await mirrorRow(ctx, id);
  if (!queue) return;
  if (wall !== undefined && !queue.checkWalls?.some(check => check.runId === run.id))
    await ctx.db.patch(queue._id, {
      checkWalls: [{ runId: run.id, at: Date.now(), milliseconds: wall }, ...(queue.checkWalls ?? [])].slice(
        0,
        mirrorCheckSamples,
      ),
    });
  if (!terminalAudit) return;
  const audit = await mirrorAudit(ctx, id);
  if (audit?.lastGreen?.runId === run.id && !audit.red) {
    if (queue.hold?.red) await wakeHeldMirror(ctx, queue, Date.now());
    await settle(ctx, queue, audit.lastGreen.sequence, 'success');
  } else if (audit?.red?.runId === run.id) {
    await settle(ctx, queue, auditMetadata(run).sequence, 'failure');
  }
}

/** A check may finish during the GitHub IO of a pending publication. The publication's
 * existing commit transaction closes that race for this exact pushed head. */
export async function mirrorVerifyAfterPush(ctx: MutationCtx, queue: Queue, job: Job) {
  const audit = await mirrorAudit(ctx, job.projectId);
  const desired =
    audit?.red?.head === job.state
      ? 'failure'
      : (audit?.lastGreen?.sequence ?? -1) >= job.sequence
        ? 'success'
        : null;
  if (!desired) return;
  await ctx.db.patch(job._id, { verify: desired });
  const pendingVerify = Math.max(0, (queue.pendingVerify ?? 1) - 1);
  await ctx.db.patch(queue._id, { pendingVerify });
  await retryMirrorVerification(ctx, queue, [job._id], 1);
  return true;
}

export const settlePage = internalMutation({
  args: { projectId, repository: v.string(), sequence: v.number(), state: verdict },
  returns: v.null(),
  handler: async (ctx, input) => {
    const queue = await mirrorRow(ctx, input.projectId);
    if (queue?.repository.toLowerCase() === input.repository.toLowerCase())
      await settle(ctx, queue, input.sequence, input.state);
    return null;
  },
});

const scope = { projectId, repository: v.string() };
const query = (name: string) => makeFunctionReference<'query'>(`projectGithubMirrorVerify:${name}`);
export const select = internalQuery({
  args: { ...scope, ids: v.array(jobId) },
  returns: v.array(entry),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    const policy = project && effectivePolicy(project).githubMirror;
    const repo = input.repository.toLowerCase();
    if (
      !project ||
      project.removal ||
      !policy?.autoPush ||
      policy.repo.toLowerCase() !== repo ||
      project.sourceAuthority?.mode !== 'server'
    )
      return [];
    const jobs = await Promise.all(input.ids.map(id => ctx.db.get(id)));
    return jobs.flatMap(job =>
      job?.projectId === project._id &&
      job.repository.toLowerCase() === repo &&
      job.authorityEpoch === project.sourceAuthority?.epoch &&
      job.mapping &&
      job.verify &&
      job.verify !== job.verifySent
        ? [{ jobId: job._id, state: job.verify, ...verifyEntry(job, project) }]
        : [],
    );
  },
});

export const noteResult = internalMutation({
  args: {
    ...scope,
    posted: v.array(v.object({ jobId, state })),
    failed: v.array(v.object({ jobId, error: v.string() })),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const queue = await mirrorRow(ctx, input.projectId);
    if (queue?.repository.toLowerCase() !== input.repository.toLowerCase()) return null;
    const changed = [];
    for (const posted of input.posted) {
      const job = await ctx.db.get(posted.jobId);
      if (job?.projectId !== input.projectId) continue;
      await ctx.db.patch(job._id, { verifySent: posted.state, verifyError: undefined });
      if (job.verify !== posted.state) changed.push(job._id);
    }
    for (const { jobId, error } of input.failed) await ctx.db.patch(jobId, { verifyError: error });
    if (queue) {
      const error =
        input.failed[0]?.error ??
        (queue.verifyError ? (await failedVerification(ctx, queue, 1))[0]?.verifyError : undefined);
      if (queue.verifyError !== error) await ctx.db.patch(queue._id, { verifyError: error });
    }
    if (queue && changed.length) await retryMirrorVerification(ctx, queue, changed, 1);
    return null;
  },
});

export const post = internalAction({
  args: {
    ...scope,
    ids: v.array(jobId),
    attempt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const { projectId, repository } = input;
    const jobs: {
      jobId: Id<'projectGithubMirrorJobs'>;
      sha: string;
      state: MirrorVerification;
      link: string | null;
    }[] = await ctx.runQuery(query('select'), { projectId, repository, ids: input.ids });
    if (!jobs.length) return null;
    const posted = [];
    const failed: { jobId: Id<'projectGithubMirrorJobs'>; error: string }[] = [];
    let index = 0;
    let error: string | undefined;
    try {
      const mint = await installationTokenMinter(ctx, projectId, repository);
      if (!mint.canWriteStatuses) error = 'GITHUB_APP_PERMISSIONS';
      else {
        const api = githubRequest(await mint(pullStatusPermissions));
        for (const { jobId, sha, state, link } of jobs) {
          const refused = await writeMirrorVerification(api, repository, sha, state, link, input.attempt > 0);
          if (refused === 'GITHUB_APP_PERMISSIONS') {
            error = refused;
            break;
          }
          if (refused) failed.push({ jobId, error: refused });
          else posted.push({ jobId, state });
          index++;
        }
      }
    } catch {
      const attempt = input.attempt + 1;
      if (attempt < 3) {
        if (posted.length || failed.length)
          await ctx.runMutation(mutation('noteResult'), { projectId, repository, posted, failed });
        await ctx.scheduler.runAfter(30_000 * 2 ** (attempt - 1), action('post'), {
          ...input,
          attempt,
          ids: jobs.slice(index).map(job => job.jobId),
        });
        return null;
      }
      error = 'GITHUB_STATUS_POST_FAILED';
    }
    if (error) failed.push(...jobs.slice(index).map(job => ({ jobId: job.jobId, error: error! })));
    await ctx.runMutation(mutation('noteResult'), { projectId, repository, posted, failed });
    return null;
  },
});

/** Resume uses the original desired state from failed jobs, never a fresh guess about the head. */
const failedVerification = (ctx: MutationCtx, queue: Queue, limit: number) =>
  ctx.db
    .query('projectGithubMirrorJobs')
    .withIndex('by_project_and_repository_and_verify_error', q =>
      q
        .eq('projectId', queue.projectId)
        .eq('repositoryKey', queue.repository.toLowerCase())
        .gt('verifyError', ''),
    )
    .take(limit);

export async function repostMainStatus(ctx: MutationCtx, id: Id<'hostedProjects'>) {
  const queue = await mirrorRow(ctx, id);
  if (!queue?.verifyError) return false;
  const jobs = await failedVerification(ctx, queue, pageSize);
  if (!jobs.length) return false;
  await ctx.db.patch(queue._id, { verifyError: undefined });
  await retryMirrorVerification(
    ctx,
    queue,
    jobs.map(job => job._id),
    1,
  );
  return true;
}
