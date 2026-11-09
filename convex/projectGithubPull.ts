// SPDX-License-Identifier: Apache-2.0
// Two-way GitHub sync, pull request side (Issue 0b481f5f, owner decision B1). A PR head into main
// becomes a mirror queue job (sequence 0.5: after an inbound push, before publishes) that reads
// GitHub like an inbound push and stages a Lane and composition. It then releases the queue and
// waits, by `waitKey`, for the composition and then a check-only run on its Candidate; nothing
// lands. forge/verify goes pending when the job starts and gets one final status. A fork head
// waits for a project owner's grant before its run (convex/projectGithubPullFork.ts). A newer head
// of the same PR supersedes the older job. Event-driven only: no poll, idle zero.
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './_generated/server';
import { internalMutation, type MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { mirrorJob } from './projectGithubMirrorRows';
import { finish, parseInbound } from './projectGithubInboundQueue';
import { checkSetting } from './projectHostedCheckStore';
import { enqueueHostedCheck } from './projectHostedChecks';
import { cancelHostedCheck } from './projectHostedCheckCancel';
import { loadCompose } from './projectHostedComposeStore';
import { submitHostedCompose } from './projectHostedComposeJobs';
import { hostedWriteProject, readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { hostedRecordSchema } from '../src/hosted-records';
import { hostedLaneSchema } from '../src/hosted-lane';
import { hostedCheckTerminal } from '../src/hosted-check';
import { canonicalPayload } from '../src/hosted-source-operation';
import { checkRunStatus, pullOperationId } from '../src/github-pull-check';
import { pullOf, settlePull } from './projectGithubPullQueue';
import { forkGate } from './projectGithubPullFork';
import type { InboundJob } from '../src/github-inbound-job';

type Job = Doc<'projectGithubMirrorJobs'>;
/** The project's verify check, or its only check; null lets project policy decide. */
export async function checkRequest(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const rows = await ctx.db
    .query('projectHostedCheckSettings')
    .withIndex('by_project_and_kind', q => q.eq('projectId', projectId).eq('kind', 'definition'))
    .take(100);
  const checks = rows.map(row => ({ key: row.key, value: JSON.parse(row.value) }));
  const selected =
    checks.find(row => row.value.name === 'verify') ?? (checks.length === 1 ? checks[0] : null);
  if (!selected) return null;
  const runner = await checkSetting(ctx, projectId, 'runner', 'runner');
  if (!runner) return null;
  const configuration = JSON.parse(runner.value);
  return {
    kind: 'request' as const,
    checkId: selected.key,
    expectedDefinition: selected.value.definition,
    expectedConfiguration: runner.digest,
    expectedEnvironment: configuration.environmentFingerprint,
  };
}
/** A newer head of this PR was received after this job (one indexed read). */
async function superseded(ctx: MutationCtx, job: Job) {
  const [latest] = await ctx.db
    .query('projectGithubMirrorJobs')
    .withIndex('by_project_and_pull', q => q.eq('projectId', job.projectId).eq('pullKey', job.pullKey))
    .order('desc')
    .take(1);
  return !!latest && latest._id !== job._id;
}
/** The PR head has no changes against main: nothing to check (main itself passed). */
export const unchanged = internalMutation({
  args: { jobId: v.id('projectGithubMirrorJobs'), step: v.number() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const active = await mirrorJob(ctx, input);
    if (!active || !pullOf(active.job)) return null;
    await finish(ctx, active.job, active.queue, null, 'done');
    await settlePull(ctx, (await ctx.db.get(active.job._id))!, 'success', 'No changes against Forge main.');
    return null;
  },
});
/** The inbound `land` step of a pull job: submit the composition, release the queue and wait
 * for the composition by its operation id. A newer head settles this one superseded. */
export async function checkPull(
  ctx: MutationCtx,
  active: { job: Job; queue: Doc<'projectGithubMirrors'>; project: Doc<'hostedProjects'> },
  inbound: InboundJob,
) {
  const { job, queue, project } = active;
  const { uploads: _uploads, ...rest } = inbound;
  void _uploads;
  const stale = await superseded(ctx, job);
  // The wait key is set before the submit: a composition that settles at once still finds it.
  await ctx.db.patch(job._id, {
    inbound: canonicalPayload({ ...rest, phase: 'checking' } satisfies InboundJob),
    ...(stale ? {} : { waitKey: inbound.composeOperationId! }),
  });
  if (!stale)
    await submitHostedCompose(ctx, {
      projectId: project._id,
      actor: project.owner,
      operationId: inbound.composeOperationId!,
    });
  await finish(ctx, (await ctx.db.get(job._id))!, queue, null, 'done');
  if (stale) await settlePull(ctx, (await ctx.db.get(job._id))!, 'superseded');
  return null;
}
/** Start the check-only run, or settle the head with the reason it cannot run. */
export const start = internalAction({
  args: { jobId: v.id('projectGithubMirrorJobs'), key: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      await ctx.runMutation(makeFunctionReference<'mutation'>('projectGithubPull:startCheck'), input);
    } catch (error) {
      const data = (error as { data?: { code?: unknown; message?: unknown } }).data;
      const reason =
        typeof data?.code === 'string'
          ? `${data.code}${typeof data.message === 'string' ? `: ${data.message}` : ''}`
          : 'unexpected failure';
      await ctx.runMutation(makeFunctionReference<'mutation'>('projectGithubPullQueue:settle'), {
        jobId: input.jobId,
        outcome: 'error',
        description: `Forge could not start the check (${reason}).`,
        waitKey: input.key,
      });
    }
    return null;
  },
});
export const startCheck = internalMutation({
  args: { jobId: v.id('projectGithubMirrorJobs'), key: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const job = await ctx.db.get(input.jobId);
    if (!job || job.waitKey !== input.key) return null;
    const inbound = parseInbound(job),
      pull = inbound.pull;
    if (!pull || pull.outcome) return null;
    if (await superseded(ctx, job)) return settlePull(ctx, job, 'superseded');
    const project = (await ctx.db.get(job.projectId))!;
    const source = await loadCompose(
      ctx,
      { projectId: project._id, actor: project.owner, operationId: inbound.composeOperationId! },
      false,
    );
    const terminal = source.operation.terminal;
    if (!terminal) return null;
    if (terminal.outcome.status === 'failed')
      return settlePull(
        ctx,
        job,
        'failure',
        `Does not apply to Forge main (${terminal.outcome.error.code}).`,
      );
    const candidate = hostedRecordSchema.options[3].parse(terminal.outcome.result);
    if (candidate.result.status !== 'clean')
      return settlePull(ctx, job, 'failure', 'Conflicts with Forge main; update the branch from main.');
    const check = await checkRequest(ctx, project._id);
    if (!check) return settlePull(ctx, job, 'error', 'This Forge project has no check configured.');
    // A fork head runs only after the owner's grant, and never with private submodules.
    if (pull.fork && !(await forkGate(ctx, job, project))) return null;
    const { kind: _kind, ...selected } = check;
    void _kind;
    const run = await enqueueHostedCheck(ctx, {
      projectId: project._id,
      actor: project.owner,
      request: {
        operationId: pullOperationId(),
        authorityEpoch: project.sourceAuthority!.epoch,
        candidateId: candidate.id,
        expectedHead: candidate.result.head,
        ...selected,
        ...(pull.fork ? { origin: 'fork-pull' as const } : {}),
      },
    });
    await ctx.db.patch(job._id, {
      waitKey: run.id,
      inbound: canonicalPayload({ ...inbound, pull: { ...pull, runId: run.id } } satisfies InboundJob),
    });
    if (hostedCheckTerminal(run)) {
      const status = checkRunStatus(run.status);
      await settlePull(
        ctx,
        (await ctx.db.get(job._id))!,
        status.state === 'pending' ? 'error' : status.state,
        status.description,
      );
    }
    return null;
  },
});
/** A settled PR head's Lane is abandoned (its saved head stays readable) and a superseded
 * head's still-running check is cancelled. */
export const retire = internalMutation({
  args: { jobId: v.id('projectGithubMirrorJobs') },
  returns: v.null(),
  handler: async (ctx, input) => {
    const job = await ctx.db.get(input.jobId);
    const project = job && (await ctx.db.get(job.projectId));
    if (!job?.inbound || !project || project.removal || project.sourceAuthority?.mode !== 'server')
      return null;
    const inbound = parseInbound(job),
      epoch = project.sourceAuthority.epoch;
    await hostedWriteProject(ctx, project._id, project.owner, epoch);
    if (inbound.pull?.outcome === 'superseded' && inbound.pull.runId)
      await cancelHostedCheck(ctx, { projectId: project._id, runId: inbound.pull.runId });
    if (!inbound.laneId) return null;
    const current = await readHostedRecord(ctx, {
      projectId: project._id,
      actor: project.owner,
      kind: 'lane',
      key: inbound.laneId,
    });
    const lane = current && hostedLaneSchema.parse(JSON.parse(current.value));
    if (!lane || lane.state !== 'active') return null;
    await writeHostedRecord(ctx, {
      projectId: project._id,
      actor: project.owner,
      authorityEpoch: epoch,
      expectedVersion: lane.version,
      record: {
        ...lane,
        version: lane.version + 1,
        lifecycleVersion: lane.lifecycleVersion + 1,
        state: 'abandoned',
        at: new Date().toISOString(),
      },
    });
    return null;
  },
});
