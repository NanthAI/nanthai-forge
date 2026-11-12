// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { rowFor, sourceStep } from './projectConvexSourceActive';
import { v } from 'convex/values';
import { internalMutation } from './server';
import { activeStep, dispatchConvexSource } from './projectConvexSourceStore';
import { enqueueSourceJob, loadSourceJob, sourceJobTerminal } from './projectSourceJobs';
import { findStoredObject } from './projectObjectFind';
import { sourceObjectLocation } from './projectSourceBeginReads';
import { sourceWorkerPlan } from '../src/convex-source-provider';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

/** Reserve the job and its first schedule together. Concurrent composes see the same project pointer;
 * no catalog reads or seed work run in this transaction. */
export const queue = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    jobId: v.string(),
    step: v.number(),
    generation: v.optional(v.number()),
    state: v.object({ sha256: v.string(), size: v.number() }),
    refresh: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const active = await activeStep(ctx, args);
    invariant(
      active?.job.jobKind === 'compose' && active.row.physicalManifests,
      'SOURCE_JOB_FENCED',
      'Only an enabled compose schedules its physical seed.',
    );
    const selected = await findStoredObject(ctx, args.projectId, args.state.sha256);
    invariant(
      selected && selected.size === args.state.size,
      'SOURCE_UNAVAILABLE',
      'Seed an exact registered State.',
    );
    if (selected.statePhysical) return 'null';
    const prior = active.project.physicalSeed;
    let base;
    if (prior) {
      const job = await loadSourceJob(ctx, args.projectId, prior.jobId);
      if (!sourceJobTerminal(job)) return 'null';
      const object = await findStoredObject(ctx, args.projectId, prior.state.sha256);
      if (object?.statePhysical) {
        if (!args.refresh)
          return canonicalPayload(await sourceObjectLocation(ctx, args.projectId, prior.state));
        base = prior.state;
      } else if (job.status === 'completed' && prior.state.sha256 === args.state.sha256) return 'null';
    }
    const jobId = crypto.randomUUID(),
      operationId = crypto.randomUUID(),
      actor = active.job.control.actor,
      expected = { authorityEpoch: active.job.authorityEpoch },
      at = new Date().toISOString(),
      payload = {
        jobKind: 'register-state',
        input: args.state,
        inputDigest: args.state.sha256,
        ...sourceWorkerPlan(process.env),
      };
    await enqueueSourceJob(ctx, {
      projectId: args.projectId,
      actor,
      request: {
        schema: 1,
        projectId: args.projectId,
        actor,
        operationId,
        expected,
        payloadHash: hostedPayloadHash(payload, expected),
      },
      payload,
      firstAttempt: {
        projectId: args.projectId,
        operationId,
        id: jobId,
        parentAttemptId: null,
        at,
        expected,
        ids: { job: jobId },
      },
    });
    await ctx.db.patch(args.projectId, {
      physicalSeed: { jobId, state: args.state, ...(base ? { base } : {}) },
    });
    await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectPhysicalSeed:dispatch'), {
      projectId: args.projectId,
      jobId,
    });
    return 'null';
  },
});

/** Runs entirely off the compose request. Provider reservation, the first action,
 * captured writer flag and crash wake commit atomically. */
export const dispatch = internalMutation({
  args: { projectId: v.id('hostedProjects'), jobId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await dispatchConvexSource(ctx, args);
    const row = await rowFor(ctx, args.projectId, args.jobId);
    if (!row || row.physicalSeed) return null;
    const seedWatchId = await ctx.scheduler.runAfter(
      650000,
      makeFunctionReference<'mutation'>('projectPhysicalSeed:watch'),
      { ...args, step: 0 },
    );
    await ctx.db.patch(row._id, { physicalSeed: true, physicalManifests: true, seedWatchId });
    return null;
  },
});

/** One crash recovery wake per active step, beyond the provider action bound.
 * A healthy commit cancels it. No timer survives a completed seed. */
export const watch = internalMutation({
  args: { projectId: v.id('hostedProjects'), jobId: v.string(), step: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const active = await sourceStep(ctx, args, false);
    if (active?.row.physicalSeed) await dispatchConvexSource(ctx, args);
    return null;
  },
});
