// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { loadSourceJob, sourceJobTerminal } from './projectSourceJobs';
import { hostedWriteProject } from './projectHostedRecords';
import { authorizeSourceTransfer } from './projectHostedSaveTransfers';
import { canonicalPayload } from '../src/hosted-source-operation';
import { sourceDispatch } from '../src/hosted-source-job-controller';
import { invariant } from '../src/errors';
import { makeFunctionReference } from 'convex/server';
import { cancelPendingTask } from './schedulerCancel';
export const rowFor = (ctx: MutationCtx, projectId: Id<'hostedProjects'>, jobId: string) =>
  ctx.db
    .query('projectSourceSteps')
    .withIndex('by_project_and_job', q => q.eq('projectId', projectId).eq('jobId', jobId))
    .unique();
type StepRow = NonNullable<Awaited<ReturnType<typeof rowFor>>>;
/** How long after its worker lease ends a step's repair wake runs. */
export const SOURCE_WAKE_SLACK_MS = 5_000;
/** The step's own repair wake (incident e62d834b): one scheduled mutation just after its worker lease
 * ends, armed wherever a step action is scheduled and kept through a fan-out. Every lease renewal
 * moves it (moveSourceWake) and the commit that ends the step cancels it, so a healthy step never
 * runs it. A worker that died or was fenced, or a batch queued behind a full pool, stops renewing its
 * lease, and the wake repairs the step then, instead of waiting for the landing watchdog's backoff or
 * a client. Replaces the row's earlier wake; returns the id for the caller's own patch of the row. */
export async function armSourceWake(
  ctx: MutationCtx,
  row: { projectId: Id<'hostedProjects'>; jobId: string; repairWakeId?: Id<'_scheduled_functions'> },
  target: { step: number; generation: number },
  leaseLeftMs: number,
  knownWake?: { state: { kind: string } } | null,
  /** The wake re-armed after a refused repair (expired): one more refusal ends its watch. */
  refused?: true,
) {
  if (row.repairWakeId) await cancelPendingTask(ctx, row.repairWakeId, knownWake);
  return ctx.scheduler.runAfter(
    Math.max(0, leaseLeftMs) + SOURCE_WAKE_SLACK_MS,
    makeFunctionReference<'mutation'>('projectConvexSourceLease:expired'),
    {
      projectId: row.projectId,
      jobId: row.jobId,
      step: target.step,
      generation: target.generation,
      ...(refused ? { refused } : {}),
    },
  );
}
/** After a renewal of the job's lease to `leaseLeftMs` from now: moves the row's wake to the new
 * lease end once it is due within half a lease, so frequent renewals (every fan-out task completion)
 * move it at most about once per half lease. A wake that still fires inside a live lease only looks
 * again at its end (`expired`). A fan-out (`arm`) always holds one; a single step only when it was
 * armed (an inline first step's fallback covers it instead). A physical seed has its own watch. */
export async function moveSourceWake(
  ctx: MutationCtx,
  row: StepRow,
  target: { step: number; generation: number },
  leaseLeftMs: number,
  arm = false,
) {
  if (row.physicalSeed || (!row.repairWakeId && !arm)) return;
  const wake = row.repairWakeId
    ? ((await ctx.db.system.get(row.repairWakeId)) as {
        state: { kind: string };
        scheduledTime?: number;
      } | null)
    : null;
  if (
    wake?.state.kind === 'pending' &&
    wake.scheduledTime !== undefined &&
    wake.scheduledTime > Date.now() + leaseLeftMs / 2
  )
    return;
  await ctx.db.patch(row._id, {
    repairWakeId: await armSourceWake(ctx, row, target, leaseLeftMs, row.repairWakeId ? wake : undefined),
  });
}
export type LoadedSourceJob = Awaited<ReturnType<typeof loadSourceJob>>;
/** Runs on the loaded job and row before the lease check: `null` skips the step, a job continues
 * with that (renewed) job. It reads nothing the step does not already read. */
export type StepGate = (job: LoadedSourceJob, row: StepRow) => Promise<LoadedSourceJob | null>;
export async function activeStep(
  ctx: MutationCtx,
  args: { projectId: Id<'hostedProjects'>; jobId: string; step: number; generation?: number; index?: number },
  gate?: StepGate,
) {
  const active = await sourceStep(ctx, args, true, gate);
  if (
    active &&
    args.index === undefined &&
    args.generation !== undefined &&
    args.generation !== (active.row.generation ?? 0)
  )
    return null;
  return active;
}
export async function sourceStep(
  ctx: MutationCtx,
  args: { projectId: Id<'hostedProjects'>; jobId: string; step: number },
  lease: boolean,
  gate?: StepGate,
) {
  const loaded = await loadSourceJob(ctx, args.projectId, args.jobId);
  const project = await hostedWriteProject(ctx, args.projectId, loaded.control.actor, loaded.authorityEpoch);
  const row = await rowFor(ctx, args.projectId, args.jobId);
  if (!row || sourceJobTerminal(loaded) || row.step !== args.step) return null;
  const job = gate ? await gate(loaded, row) : loaded;
  if (!job) return null;
  invariant(
    row.dispatch === canonicalPayload(sourceDispatch(args.projectId, job)),
    'SOURCE_JOB_FENCED',
    'Source step pins changed.',
  );
  if (job.jobKind !== 'register-state')
    await authorizeSourceTransfer(
      ctx,
      { projectId: args.projectId, input: row.dispatch, executionId: row.executionId },
      { lease, loaded: job },
    );
  else
    invariant(
      job.status === 'running' &&
        job.executionId === row.executionId &&
        (!lease || job.control.workerUntil > Date.now()),
      'SOURCE_JOB_FENCED',
      'Source execution changed or expired.',
    );
  // The project row this check already read: callers take flags from it without another read.
  return { job, row, project };
}
