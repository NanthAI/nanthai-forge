// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { enqueueSourceJob, claimSourceJob, advanceSourceJob, cancelSourceJob } from './projectSourceJobs';
import { receiveSourceJobCallback } from './projectSourceJobCallbacks';
import { hostedRecordPage } from './projectHostedRecords';

// Trusted caller only; actor/worker/runtime/input pins are resolved by the parent
// operation, never by a public callback. JSON strings have strict shared schemas.
const identity = { projectId: v.id('hostedProjects'), jobId: v.string() };
export const enqueue = internalMutation({
  args: { projectId: v.id('hostedProjects'), actor: v.string(), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    const { request, payload, firstAttempt } = JSON.parse(input.request);
    return JSON.stringify(
      await enqueueSourceJob(ctx, {
        projectId: input.projectId,
        actor: input.actor,
        request,
        payload,
        firstAttempt,
      }),
    );
  },
});
export const claim = internalMutation({
  args: { ...identity, owner: v.string(), leaseMs: v.number() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    const job = await claimSourceJob(ctx, input);
    return job ? JSON.stringify(job) : null;
  },
});
export const advance = internalMutation({
  args: { ...identity, owner: v.string(), token: v.number(), command: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    const job = await advanceSourceJob(ctx, { ...input, command: JSON.parse(input.command) });
    return job ? JSON.stringify(job) : null;
  },
});
export const callback = internalMutation({
  args: { projectId: v.id('hostedProjects'), callback: v.string(), signature: v.string() },
  returns: v.string(),
  handler: async (ctx, input) =>
    JSON.stringify(
      await receiveSourceJobCallback(
        ctx,
        { ...input, callback: JSON.parse(input.callback) },
        keyId => process.env[`FORGE_SOURCE_JOB_KEY_${keyId}`] ?? '',
      ),
    ),
});
export const cancel = internalMutation({
  args: { ...identity, actor: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => JSON.stringify(await cancelSourceJob(ctx, input)),
});
/** Recovery pages only the selected project's live job status; no cron scans all
 * projects, no completed history hydration, and no per-Lane idle process. */
export const pending = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    status: v.union(v.literal('pending'), v.literal('dispatching'), v.literal('running')),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    page: v.array(v.object({ jobId: v.string(), version: v.number() })),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, input) => {
    const result = await hostedRecordPage(ctx, { ...input, kind: 'job' });
    return {
      page: result.page.map(row => ({ jobId: row.key, version: row.version })),
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});
