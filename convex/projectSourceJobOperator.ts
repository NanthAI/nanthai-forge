// SPDX-License-Identifier: Apache-2.0
// Reviewed, owner-scoped operator path for NAMED stale source jobs (Issue 11fd39de).
// A job is stale only when its worker lease expired more than a day ago, its step
// has nothing scheduled or running and no fan-out batch is open: nothing can
// resume it. Apply marks it failed with the operator's reason (SOURCE_JOB_STALE),
// drops the dead step cursor and schedules the existing parent settle action,
// which fails the save/sync/compose operation with that reason. A job that is
// already failed or cancelled only has its dead cursor dropped. Every other job is
// refused with a code, never forced. An ordinary paused write (refused during a
// cleanup pause). It moves or deletes no bytes.
import { internalMutation, internalQuery } from './server';
import type { QueryCtx } from './server';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import { activeOwnedProject } from './projectAuthority';
import { hostedWriteProject } from './projectHostedRecords';
import { loadSourceJob, saveSourceJob, type SourceJob } from './projectSourceJobs';
import { invariant } from '../src/errors';

export const STALE_SOURCE_JOB_MS = 24 * 60 * 60_000;
export const STALE_SOURCE_JOB_CODE = 'SOURCE_JOB_STALE';
const scope = {
  projectId: v.id('hostedProjects'),
  actor: v.string(),
  jobIds: v.array(v.string()),
  reason: v.string(),
};
const outcome = v.array(
  v.object({
    jobId: v.string(),
    /** fail: mark failed + drop cursor + settle parent; clear: drop a terminal job's cursor; done: nothing left. */
    action: v.union(v.literal('fail'), v.literal('clear'), v.literal('done'), v.null()),
    code: v.union(v.string(), v.null()),
  }),
);
type Args = { projectId: Id<'hostedProjects'>; actor: string; jobIds: string[]; reason: string };
type Loaded = SourceJob & { control: NonNullable<SourceJob['control']> };
type Decision = {
  jobId: string;
  action: 'fail' | 'clear' | 'done' | null;
  code: string | null;
  job?: Loaded;
  step?: Doc<'projectSourceSteps'> | null;
};

async function decide(ctx: QueryCtx, args: Args, jobId: string, now: number): Promise<Decision> {
  let job: Loaded;
  try {
    job = await loadSourceJob(ctx, args.projectId, jobId);
  } catch {
    return { jobId, action: null, code: 'SOURCE_JOB_UNAVAILABLE' };
  }
  const step = await ctx.db
    .query('projectSourceSteps')
    .withIndex('by_project_and_job', q => q.eq('projectId', args.projectId).eq('jobId', jobId))
    .unique();
  const clear = step && step.cursor !== null;
  if (job.status === 'completed') return { jobId, action: null, code: 'SOURCE_JOB_COMPLETED' };
  if (job.status === 'failed' || job.status === 'cancelled')
    return { jobId, action: clear ? 'clear' : 'done', code: null, job, step };
  if (job.control.provider !== 'convex') return { jobId, action: null, code: 'SOURCE_PROVIDER_CHANGED' };
  const lease = job.control.lease;
  if (
    job.control.workerUntil > now - STALE_SOURCE_JOB_MS ||
    (lease && lease.until > now - STALE_SOURCE_JOB_MS)
  )
    return { jobId, action: null, code: 'SOURCE_JOB_NOT_STALE' };
  if (step?.retryAt !== undefined && step.retryAt > now - STALE_SOURCE_JOB_MS)
    return { jobId, action: null, code: 'SOURCE_JOB_NOT_STALE' };
  if (step?.scheduledId) {
    const scheduled = await ctx.db.system.get(step.scheduledId);
    if (scheduled?.state.kind === 'pending' || scheduled?.state.kind === 'inProgress')
      return { jobId, action: null, code: 'SOURCE_JOB_ACTIVE' };
  }
  if (step?.batchId) {
    const batch = await ctx.db.get(step.batchId);
    if (batch?.status === 'queued' || batch?.status === 'waiting')
      return { jobId, action: null, code: 'SOURCE_JOB_ACTIVE' };
  }
  try {
    await hostedWriteProject(ctx, args.projectId, job.control.actor, job.authorityEpoch);
  } catch {
    return { jobId, action: null, code: 'SOURCE_AUTHORITY_CHANGED' };
  }
  return { jobId, action: 'fail', code: null, job, step };
}
async function check(ctx: QueryCtx, args: Args, now: number) {
  await activeOwnedProject(ctx, args.projectId, args.actor);
  invariant(
    args.jobIds.length > 0 &&
      args.jobIds.length <= 10 &&
      new Set(args.jobIds).size === args.jobIds.length &&
      args.reason.trim().length > 0 &&
      args.reason.length <= 240,
    'BAD_ARGUMENT',
    'Name at most 10 unique jobs of one project and a reason of at most 240 characters.',
  );
  const decisions: Decision[] = [];
  for (const jobId of args.jobIds) decisions.push(await decide(ctx, args, jobId, now));
  return decisions;
}
const report = (decisions: Decision[]) =>
  decisions.map(({ jobId, action, code }) => ({ jobId, action, code }));

/** Dry run: the exact checks apply makes, no writes. */
export const plan = internalQuery({
  args: scope,
  returns: outcome,
  handler: async (ctx, args) => report(await check(ctx, args, Date.now())),
});
/** Retry-safe: a replay finds the jobs already failed and their cursors dropped (`done`). */
export const apply = internalMutation({
  args: { ...scope, operationId: v.string() },
  returns: outcome,
  handler: async (ctx, args) => {
    invariant(
      /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(args.operationId),
      'BAD_ARGUMENT',
      'Pass a UUID operationId.',
    );
    const now = Date.now(),
      decisions = await check(ctx, args, now);
    for (const decision of decisions) {
      const { job, step } = decision;
      if (!job || (decision.action !== 'fail' && decision.action !== 'clear')) continue;
      if (decision.action === 'fail') {
        await saveSourceJob(
          ctx,
          args.projectId,
          job,
          {
            ...job,
            status: 'failed',
            control: {
              ...job.control,
              failureCode: STALE_SOURCE_JOB_CODE,
              failureReason: args.reason.trim(),
            },
          },
          now,
        );
        if (job.jobKind !== 'register-state')
          await ctx.scheduler.runAfter(
            0,
            makeFunctionReference<'action'>(
              job.jobKind === 'save'
                ? 'projectHostedSaveJobs:complete'
                : job.jobKind === 'compose'
                  ? 'projectHostedComposeJobs:complete'
                  : 'projectHostedSyncJobs:complete',
            ),
            { projectId: args.projectId, jobId: job.id },
          );
      }
      // The cursor is the dead continuation; the job's inputs and identity stay.
      if (step && step.cursor !== null) await ctx.db.patch(step._id, { cursor: null });
    }
    return report(decisions);
  },
});
