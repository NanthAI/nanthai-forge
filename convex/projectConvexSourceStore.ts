// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { reserveSourceProvider, recordSourceProvider, lookupSourceProvider } from './projectSourceProvider';
import {
  loadSourceJob,
  sourceJobTerminal,
  claimSourceJob,
  advanceSourceJob,
  saveSourceJob,
} from './projectSourceJobs';
import { receiveConvexSourceJobCallback } from './projectSourceJobCallbacks';
import { sourceDispatch, driveSourceJob } from '../src/hosted-source-job-controller';
import { canonicalPayload } from '../src/hosted-source-operation';
import { convexSourceWorker, convexSourceRuntime, ConvexSourceProvider } from '../src/convex-source-provider';
import { invariant } from '../src/errors';
import { activeStep, sourceStep, rowFor } from './projectConvexSourceActive';
export { activeStep, sourceStep } from './projectConvexSourceActive';
import { sourceMutation } from './projectConvexSourceErrors';
import { hostedWriteProject } from './projectHostedRecords';
import { saveObject } from './projectHostedSaveStore';
import { drainSourcePool, requeueSourceBatch } from './projectConvexSourcePool';
import { ForgeError } from '../src/errors';
import { sourceOutput, sourceFailure } from './projectSourceStepFields';
import { storeSourceOutputs } from './projectConvexSourceOutput';
import {
  exhaustSourceExecution,
  sourceFailureUpdate,
  sourceRetryExpired,
} from './projectConvexSourceFailure';
import {
  SOURCE_MAX_FAILED_ATTEMPTS,
  unknownSourceFailure,
  sourceFailureSchema,
} from '../src/hosted-source-retry';
import { presignGet, r2Config } from './r2';
import { findObject } from './projectObjectFind';
import { packRange, packHeaders } from '../src/object-pack-range';
import { recordSourceStep, sourceStepTiming } from './projectSourceStepTiming';
import { sourceResultInlineBytes } from './projectConvexSourceTransport';
import { digest } from '../src/portable-hash';
const identity = { projectId: v.id('hostedProjects'), jobId: v.string() };
/** The step's own result text, when publication may take it without the complete action's R2 read. */
export function inlineSourceResult(
  kind: string,
  output: { sha256: string; size: number } | null | undefined,
  result: string | undefined,
): boolean {
  return (
    (kind === 'save' || kind === 'sync') &&
    output != null &&
    result !== undefined &&
    output.size <= sourceResultInlineBytes &&
    new TextEncoder().encode(result).length === output.size &&
    digest(result) === output.sha256
  );
}
export const start = internalMutation({
  args: { ...identity, input: v.string() },
  returns: v.string(),
  handler: startConvexSource,
});
export async function startConvexSource(
  ctx: MutationCtx,
  args: { projectId: Id<'hostedProjects'>; jobId: string; input: string },
) {
  const input = JSON.parse(args.input),
    job = await loadSourceJob(ctx, args.projectId, args.jobId);
  invariant(
    input.provider === 'convex' &&
      input.worker === convexSourceWorker &&
      input.runtime === convexSourceRuntime,
    'SOURCE_PROVIDER_CHANGED',
    'Select the fixed Convex source computation.',
  );
  const prior = await rowFor(ctx, args.projectId, args.jobId);
  if (prior) {
    await hostedWriteProject(ctx, args.projectId, job.control.actor, job.authorityEpoch);
    invariant(
      prior.dispatch === canonicalPayload(input) &&
        prior.dispatch === canonicalPayload(sourceDispatch(args.projectId, job)),
      'SOURCE_PROVIDER_CHANGED',
      'Original source dispatch changed.',
    );
    return canonicalPayload({ status: 'accepted', executionId: prior.executionId });
  }
  const token = crypto.randomUUID(),
    reserved = await reserveSourceProvider(ctx, { ...args, input, token });
  if (!reserved.create) return canonicalPayload({ status: 'unknown' });
  const executionId = `convex:${input.dispatchKey}`;
  await recordSourceProvider(ctx, { ...args, input, token, executionId });
  const rowId = await ctx.db.insert('projectSourceSteps', {
    projectId: args.projectId,
    jobId: args.jobId,
    dispatch: canonicalPayload(input),
    executionId,
    step: 0,
    cursor: null,
    timing: { queuedAt: Date.now(), scheduledAt: Date.now(), steps: [] },
  });
  const scheduledId = await ctx.scheduler.runAfter(
    0,
    makeFunctionReference<'action'>('projectConvexSource:step'),
    { projectId: args.projectId, jobId: args.jobId, step: 0 },
  );
  await ctx.db.patch(rowId, { scheduledId });
  return canonicalPayload({ status: 'accepted', executionId });
}

export async function lookupConvexSource(
  ctx: MutationCtx,
  args: {
    projectId: Id<'hostedProjects'>;
    jobId: string;
    input: import('../src/hosted-source-job').SourceDispatch;
  },
) {
  const result = await lookupSourceProvider(ctx, args),
    row = await rowFor(ctx, args.projectId, args.jobId);
  const job = await loadSourceJob(ctx, args.projectId, args.jobId);
  const batch = row?.batchId ? await ctx.db.get(row.batchId) : null;
  if (row && batch && batch.status !== 'done' && !sourceJobTerminal(job)) {
    // A batch fenced only by lease expiry (for example queued behind another
    // project) is still this execution's work: renew, then requeue it once.
    if (
      (batch.status === 'fenced' || job.control.workerUntil <= Date.now()) &&
      (await renewConvexSource(ctx, { ...args, step: row.step })) &&
      batch.status === 'fenced'
    )
      await requeueSourceBatch(ctx, batch);
    await drainSourcePool(ctx, async batch => {
      try {
        const active = await activeStep(ctx, batch);
        return !!active && active.row.batchId === batch._id;
      } catch (error) {
        if (error instanceof ForgeError) return false;
        throw error;
      }
    });
    return result;
  }
  if (row?.scheduledId && !sourceJobTerminal(job)) {
    // Scheduled actions are never retried by Convex. Only a step whose action
    // failed, was cancelled or aged out of the system table is resumed.
    const scheduled = await ctx.db.system.get(row.scheduledId);
    if (scheduled?.state.kind === 'pending' && job.control.workerUntil <= Date.now())
      await renewConvexSource(ctx, { ...args, step: row.step });
    if (
      (!scheduled || scheduled.state.kind === 'failed' || scheduled.state.kind === 'canceled') &&
      (await renewConvexSource(ctx, { ...args, step: row.step }))
    ) {
      const update: Partial<ReturnType<typeof sourceFailureUpdate>> =
        row.failedGeneration === (row.generation ?? 0)
          ? {}
          : sourceFailureUpdate(row, unknownSourceFailure('scheduled-step'), job.control.retryUntil);
      const failures = update.failedAttempts ?? row.failedAttempts ?? 0;
      const current = await sourceStep(ctx, { ...args, step: row.step }, false);
      if (!current) return result;
      if (failures >= SOURCE_MAX_FAILED_ATTEMPTS || sourceRetryExpired(current)) {
        if (update.failedAttempts) await ctx.db.patch(row._id, update);
        await exhaustSourceExecution(ctx, { ...args, step: row.step }, update.lastFailure ?? row.lastFailure);
        return result;
      }
      const generation = (row.generation ?? 0) + 1;
      const scheduledId = await ctx.scheduler.runAfter(
        Math.max(0, (update.retryAt ?? row.retryAt ?? 0) - Date.now()),
        makeFunctionReference<'action'>(
          row.step === 0 ? 'projectConvexSource:step' : 'projectConvexSourceNode:step',
        ),
        { projectId: args.projectId, jobId: args.jobId, step: row.step, generation },
      );
      await ctx.db.patch(row._id, { ...update, generation, scheduledId });
    }
  }
  return result;
}
/** Explicit recovery only. The scheduler reports authoritatively that the
 * execution's one step action is not running, so resuming it renews the SAME
 * execution's lease. Changed authority, fence, attempt or pins never renew. */
async function renewConvexSource(
  ctx: MutationCtx,
  args: { projectId: Id<'hostedProjects'>; jobId: string; step: number },
) {
  let active;
  try {
    active = await sourceStep(ctx, args, false);
  } catch (error) {
    if (error instanceof ForgeError) return false;
    throw error;
  }
  if (!active) return false;
  const now = Date.now(),
    control = active.job.control;
  await saveSourceJob(
    ctx,
    args.projectId,
    active.job,
    { ...active.job, control: { ...control, workerUntil: now + control.workerLeaseMs } },
    now,
  );
  return true;
}
export const lookup = internalMutation({
  args: { ...identity, input: v.string() },
  returns: v.string(),
  handler: async (ctx, args) =>
    canonicalPayload(await lookupConvexSource(ctx, { ...args, input: JSON.parse(args.input) })),
});
export const begin = sourceMutation({
  args: { ...identity, step: v.number(), generation: v.optional(v.number()) },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const active = await activeStep(ctx, { ...args, generation: args.generation ?? 0 });
    if (!active) return null;
    if (sourceRetryExpired(active)) {
      await exhaustSourceExecution(ctx, args, active.row.lastFailure);
      return null;
    }
    const batch = active.row.batchId ? await ctx.db.get(active.row.batchId) : null;
    if (batch && batch.status !== 'done') return null;
    const locations = [];
    if (!active.row.cursor) {
      const descriptor = await saveObject(ctx, args.projectId, active.job.input);
      const object = await findObject(ctx, args.projectId, active.job.input.sha256);
      invariant(object, 'SOURCE_UNAVAILABLE', 'Source input is absent.');
      const url =
        object.location === 'r2' && object.r2Key
          ? await presignGet(r2Config(), object.r2Key, packHeaders(packRange(object), object.size))
          : null;
      locations.push({
        descriptor,
        storageId: url ? null : (object.storageId ?? null),
        url,
        ...(object.pack ? { range: packRange(object)! } : {}),
      });
    }
    return canonicalPayload({
      generation: active.row.generation ?? 0,
      input: active.job.input,
      jobKind: active.job.jobKind,
      dispatch: active.row.dispatch,
      executionId: active.row.executionId,
      cursor: active.row.cursor,
      locations,
      batchId: active.row.batchId ?? null,
    });
  },
});
export const commit = sourceMutation({
  args: {
    ...identity,
    step: v.number(),
    generation: v.optional(v.number()),
    cursor: v.union(v.string(), v.null()),
    objects: v.array(sourceOutput),
    output: v.union(v.object({ sha256: v.string(), size: v.number() }), v.null()),
    failure: v.union(v.string(), v.null()),
    timing: v.optional(sourceStepTiming),
    /** The output manifest's exact text when small: publication then needs no R2 re-read. */
    result: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const active = await activeStep(ctx, { ...args, generation: args.generation ?? 0 });
    if (!active) return null;
    const terminal = !!args.output || !!args.failure;
    const now = Date.now();
    // A terminal result may win the race with the watch, but expired work must
    // never schedule another quantum or discard the retained failure context.
    if (!terminal && sourceRetryExpired(active)) {
      await exhaustSourceExecution(ctx, args, active.row.lastFailure);
      return null;
    }
    invariant(args.objects.length <= 100, 'SOURCE_JOB_INVALID', 'Commit source output in bounded windows.');
    await storeSourceOutputs(ctx, args.projectId, active.row.executionId, args.objects);
    const callback = {
      ...JSON.parse(active.row.dispatch),
      executionId: active.row.executionId,
      result: args.failure
        ? { status: 'failed', code: args.failure }
        : args.output
          ? { status: 'completed', output: args.output }
          : { status: 'heartbeat', sequence: active.job.control.heartbeat + 1 },
    };
    // Dispatch-only fields do not belong to the existing terminal manifest.
    delete callback.jobKind;
    delete callback.input;
    delete callback.dispatchKey;
    await receiveConvexSourceJobCallback(ctx, args.projectId, callback);
    await ctx.db.patch(active.row._id, {
      step: args.step + 1,
      cursor: args.cursor,
      batchId: undefined,
      generation: undefined,
      failedAttempts: undefined,
      failedGeneration: undefined,
      lastFailure: undefined,
      lastFailureAt: undefined,
      retryAt: undefined,
      timing: recordSourceStep(active.row.timing, args.timing, now, terminal),
    });
    if (terminal) {
      const kind = active.job.jobKind;
      const api =
        kind === 'save'
          ? 'projectHostedSaveJobs'
          : kind === 'compose'
            ? 'projectHostedComposeJobs'
            : 'projectHostedSyncJobs';
      // A small save or sync result the step produced itself goes straight to the publish mutation,
      // which checks it against the job's signed output digest exactly as after an R2 read. Anything
      // else (a failure, a larger or missing result) takes the complete action, which reads it back.
      // Compose keeps the action for now: its results reach 512 KiB and its landing path is separate.
      const inline = inlineSourceResult(kind, args.output, args.result);
      if (kind !== 'register-state')
        await ctx.scheduler.runAfter(
          0,
          makeFunctionReference<'action' | 'mutation'>(`${api}:${inline ? 'publish' : 'complete'}`),
          {
            projectId: args.projectId,
            jobId: args.jobId,
            ...(inline ? { result: args.result } : {}),
          },
        );
    } else {
      const scheduledId = await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'action'>('projectConvexSourceNode:step'),
        { projectId: args.projectId, jobId: args.jobId, step: args.step + 1 },
      );
      await ctx.db.patch(active.row._id, { scheduledId });
    }
    return null;
  },
});

/** All control transitions are local calls in one transaction. Scheduling the
 * first action and recording its execution identity commit atomically. */
export const dispatch = internalMutation({
  args: identity,
  returns: v.union(v.literal('idle'), v.literal('observed'), v.literal('unknown')),
  handler: async (ctx, args) => {
    const owner = crypto.randomUUID();
    let failure: unknown;
    const result = await driveSourceJob(
      args.projectId,
      {
        claim: () => claimSourceJob(ctx, { ...args, owner, leaseMs: 60000 }),
        advance: (token, command) => advanceSourceJob(ctx, { ...args, owner, token, command }),
      },
      new ConvexSourceProvider(
        async input => {
          try {
            return JSON.parse(await startConvexSource(ctx, { ...args, input: canonicalPayload(input) }));
          } catch (error) {
            failure = error;
            throw error;
          }
        },
        input => lookupConvexSource(ctx, { ...args, input }),
      ),
      () => crypto.randomUUID(),
    );
    if (failure) throw failure;
    // The controller has no IO outside this transaction. Release only its
    // coordination lease so a failed action can reconcile before worker expiry.
    const job = await loadSourceJob(ctx, args.projectId, args.jobId);
    if (job.control.lease?.owner === owner && !sourceJobTerminal(job))
      await saveSourceJob(
        ctx,
        args.projectId,
        job,
        { ...job, control: { ...job.control, lease: null } },
        Date.now(),
      );
    return result;
  },
});

export const stage = sourceMutation({
  args: {
    ...identity,
    step: v.number(),
    generation: v.optional(v.number()),
    objects: v.array(sourceOutput),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const active = await activeStep(ctx, args);
    invariant(active, 'SOURCE_JOB_FENCED', 'Source step advanced.');
    invariant(args.objects.length <= 100, 'SOURCE_JOB_INVALID', 'Stage source outputs in windows.');
    await storeSourceOutputs(ctx, args.projectId, active.row.executionId, args.objects);
    return null;
  },
});

export const failed = sourceMutation({
  args: { ...identity, step: v.number(), generation: v.number(), cause: sourceFailure },
  returns: v.null(),
  handler: async (ctx, args) => {
    const active = await sourceStep(ctx, args, false);
    if (
      !active ||
      args.generation !== (active.row.generation ?? 0) ||
      active.row.failedGeneration === args.generation
    )
      return null;
    const update = sourceFailureUpdate(
      active.row,
      sourceFailureSchema.parse(args.cause),
      active.job.control.retryUntil,
    );
    await ctx.db.patch(active.row._id, update);
    if (update.failedAttempts >= SOURCE_MAX_FAILED_ATTEMPTS || sourceRetryExpired(active)) {
      await exhaustSourceExecution(ctx, args, update.lastFailure);
      await drainSourcePool(ctx, async batch => {
        const live = await activeStep(ctx, batch);
        return !!live && live.row.batchId === batch._id;
      });
    }
    return null;
  },
});
