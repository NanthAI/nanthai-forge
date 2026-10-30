// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { mirrorJob, mirrorRow, scheduleMirror } from './projectGithubMirrorQueue';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { readHostedRecord } from './projectHostedRecords';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { githubSyncCommitSchema, githubSyncSchema } from '../src/github-sync-types';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
const identity = { jobId: v.id('projectGithubMirrorJobs'), step: v.number() };
async function seed(ctx: MutationCtx, input: { jobId: Id<'projectGithubMirrorJobs'>; step: number }) {
  const active = await mirrorJob(ctx, input);
  if (!active) return null;
  const { job, queue, project } = active;
  if (job.cursor) return { cursor: job.cursor, repository: job.repository };
  if (job.seed) return { cursor: null, repository: job.repository, seed: JSON.parse(job.seed) };
  const row = await acceptanceRow(ctx, { projectId: job.projectId, receiptId: job.receiptId });
  invariant(row, 'SOURCE_UNAVAILABLE', 'Mirror acceptance receipt is unavailable.');
  const receipt = hostedAcceptanceSchema.parse(JSON.parse(row.value));
  let binding = queue.mapping ? githubSyncCommitSchema.parse(JSON.parse(queue.mapping)) : null;
  if (!binding) {
    const generation = await selectedGeneration(ctx, project);
    const old = generation ? await record(ctx, recordPartition(generation), 'githubSync', 'github') : null;
    if (old) {
      const value = githubSyncSchema.parse(JSON.parse(old.value));
      invariant(
        value.repository.toLowerCase() === job.repository.toLowerCase() && value.branch === 'main',
        'GITHUB_SYNC_BINDING',
        'The native mirror mapping selects another repository or branch.',
      );
      invariant(
        value.pushed === value.commits.length,
        'GITHUB_SYNC_PENDING',
        'Reconcile the retained native mirror operation before bootstrap.',
      );
      binding = value.commits[value.pushed - 1] ?? null;
    }
  }
  const candidate = await readHostedRecord(ctx, {
    projectId: job.projectId,
    actor: project.owner,
    kind: 'candidate',
    key: receipt.candidate.id,
  });
  const intentId = candidate && JSON.parse(candidate.value).intentId;
  const intent = intentId
    ? await readHostedRecord(ctx, {
        projectId: job.projectId,
        actor: project.owner,
        kind: 'intent',
        key: intentId,
      })
    : null;
  invariant(
    intent,
    'SOURCE_UNAVAILABLE',
    'The accepted Intent is unavailable for the mirror commit message.',
  );
  const name = process.env.FORGE_GITHUB_SYNC_NAME?.trim() || binding?.committer.name;
  const email = process.env.FORGE_GITHUB_SYNC_EMAIL?.trim() || binding?.committer.email;
  invariant(
    name && email && !/[<>\r\n\0]/.test(name + email) && /no-?reply/i.test(email),
    'GITHUB_SYNC_IDENTITY',
    'Configure the existing noreply sync identity with FORGE_GITHUB_SYNC_NAME and FORGE_GITHUB_SYNC_EMAIL, or retain it in githubSync.',
  );
  const message = [
    JSON.parse(intent.value).outcome,
    '',
    `Forge-State: ${receipt.candidate.head}`,
    `Forge-Acceptance: ${receipt.id}`,
    `Forge-View: ${receipt.candidate.id}`,
  ].join('\n');
  const value = {
    cursor: null,
    repository: job.repository,
    seed: {
      repository: job.repository,
      state: receipt.candidate.head,
      previous: receipt.previous.head,
      acceptanceId: receipt.id,
      operationId: receipt.operationId,
      viewId: receipt.candidate.id,
      message,
      at: receipt.at,
      binding,
      verified: !!queue.mapping,
      identity: { name, email },
    },
  };
  // Pin mutable Intent prose and configured identity before any GitHub IO.
  // A lost commit/ref reply must replay these exact commit bytes.
  await ctx.db.patch(job._id, { seed: canonicalPayload(value.seed) });
  return value;
}
export const begin = internalMutation({
  args: identity,
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    const value = await seed(ctx, input);
    const job = value && (await ctx.db.get(input.jobId));
    // The action binds its App token to the job's project.
    return value && job ? canonicalPayload({ ...value, projectId: job.projectId }) : null;
  },
});
export const commit = internalMutation({
  args: { ...identity, cursor: v.union(v.id('_storage'), v.null()), mapping: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, input) => {
    const active = await mirrorJob(ctx, input);
    if (!active) return null;
    const { job, queue } = active;
    if (input.mapping) {
      const mapping = githubSyncCommitSchema.parse(JSON.parse(input.mapping));
      invariant(
        mapping.acceptanceId === job.receiptId && mapping.state === job.state,
        'GITHUB_SYNC_HISTORY',
        'Retain the mirror acceptance mapping.',
      );
      await ctx.db.patch(job._id, {
        status: 'done',
        mapping: canonicalPayload(mapping),
        step: job.step + 1,
        cursor: null,
        failures: 0,
        nextAttemptAt: undefined,
        error: undefined,
        detail: undefined,
      });
      const next = await ctx.db
        .query('projectGithubMirrorJobs')
        .withIndex('by_project_and_status_and_sequence', q =>
          q.eq('projectId', job.projectId).eq('status', 'queued'),
        )
        .order('asc')
        .take(1);
      await ctx.db.patch(queue._id, {
        mapping: canonicalPayload(mapping),
        mirroredAt: Date.now(),
        activeId: next[0]?._id ?? null,
      });
      if (next[0]) await scheduleMirror(ctx, next[0]);
    } else {
      invariant(input.cursor, 'SOURCE_UNAVAILABLE', 'Mirror continuation is unavailable.');
      await ctx.db.patch(job._id, {
        status: 'running',
        step: job.step + 1,
        cursor: input.cursor,
        failures: 0,
        nextAttemptAt: undefined,
        error: undefined,
        detail: undefined,
      });
      await scheduleMirror(ctx, { _id: job._id, step: job.step + 1 });
    }
    return null;
  },
});
export const failed = internalMutation({
  args: {
    ...identity,
    code: v.string(),
    detail: v.string(),
    httpStatus: v.optional(v.number()),
    apiOperation: v.optional(v.string()),
    requestBytes: v.optional(v.number()),
    cursor: v.optional(v.id('_storage')),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const job = await ctx.db.get(input.jobId);
    if (!job || job.step !== input.step || ['done', 'failed'].includes(job.status)) return null;
    const queue = await mirrorRow(ctx, job.projectId);
    if (queue?.activeId !== job._id) return null;
    const failures = (job.failures ?? 0) + 1;
    const transient =
      input.code === 'GITHUB_SYNC_API' &&
      (input.httpStatus === 429 ||
        (input.httpStatus !== undefined && input.httpStatus >= 500 && input.httpStatus <= 599));
    const delay = transient && failures < 5 ? 60_000 * 2 ** (failures - 1) : null;
    // Advance the worker fence, retaining the exact cursor/seed. Duplicate or
    // late callbacks cannot spend another attempt or overwrite newer progress.
    const step = job.step + 1;
    await ctx.db.patch(job._id, {
      status: delay === null ? 'failed' : 'retrying',
      step,
      failures,
      error: input.code,
      detail: input.detail,
      httpStatus: input.httpStatus,
      apiOperation: input.apiOperation,
      requestBytes: input.requestBytes,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      nextAttemptAt: delay === null ? undefined : Date.now() + delay,
    });
    if (delay !== null) await scheduleMirror(ctx, { _id: job._id, step }, delay);
    return null;
  },
});
/** Explicit recovery of the same cursor, fencing failed or expired workers. */
export const resume = internalMutation({
  args: { jobId: v.id('projectGithubMirrorJobs') },
  returns: v.object({
    status: v.union(
      v.literal('missing'),
      v.literal('done'),
      v.literal('already-running'),
      v.literal('scheduled'),
    ),
    step: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, input) => {
    const job = await ctx.db.get(input.jobId);
    if (!job) return { status: 'missing' as const, step: null };
    if (job.status === 'done') return { status: 'done' as const, step: job.step };
    const queue = await mirrorRow(ctx, job.projectId);
    invariant(queue?.activeId === job._id, 'GITHUB_SYNC_PENDING', 'Resume the active retained mirror job.');
    const task = job.scheduledId ? await ctx.db.system.get(job.scheduledId) : null;
    const live = task && ['pending', 'inProgress'].includes(task.state.kind);
    // Actions have a ten-minute runtime limit. A future backoff is still live;
    // an overdue task beyond that window is recoverable by explicit resume.
    if (live && job.status !== 'failed' && task.scheduledTime + 11 * 60_000 > Date.now())
      return { status: 'already-running' as const, step: job.step };
    if (live) await ctx.scheduler.cancel(task._id);
    const step = job.step + 1;
    await ctx.db.patch(job._id, {
      status: 'running',
      step,
      failures: 0,
      nextAttemptAt: undefined,
      error: undefined,
      detail: undefined,
      httpStatus: undefined,
      apiOperation: undefined,
      requestBytes: undefined,
    });
    await mirrorJob(ctx, { jobId: job._id, step });
    await scheduleMirror(ctx, { _id: job._id, step });
    return { status: 'scheduled' as const, step };
  },
});
