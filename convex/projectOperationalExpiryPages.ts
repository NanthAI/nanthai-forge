// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { hostedCheckRunSchema, hostedCheckTerminal } from '../src/hosted-check';
import { loadSourceJob, sourceJobTerminal } from './projectSourceJobs';
import { checkDetailRetentionMs, exhaustRetentionMs } from './projectOperationalExpirySchedule';
import { ForgeError, invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';
import { projectExecution } from './projectExecution';

// Eight maximum-size documents fit below the provider's read/write window. No schema/index
// backfill: all access uses existing run/job/batch indexes, including first-run legacy cleanup.
const pageSize = 8;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const tableResult = v.object({ table: v.string(), rows: v.number(), bytes: v.number() });
export const expiryResult = v.object({
  tables: v.optional(v.array(tableResult)),
  readBytes: v.optional(v.number()),
  rows: v.number(),
  bytes: v.number(),
  more: v.boolean(),
  kept: v.boolean(),
  nextCursor: v.optional(v.union(v.string(), v.null())),
});
const empty = (kept = false) => ({ rows: 0, bytes: 0, more: false, kept });
async function remove(
  ctx: MutationCtx,
  rows: {
    _id: Id<'projectHostedCheckShards' | 'projectHostedActionsResults' | 'projectSourceTasks'>;
  }[],
) {
  let removedBytes = 0;
  for (const row of rows) {
    removedBytes += bytes(row);
    await ctx.db.delete(row._id);
  }
  return removedBytes;
}

type Outcome = ReturnType<typeof empty> & {
  readBytes?: number;
  nextCursor?: string | null;
  tables?: { table: string; rows: number; bytes: number }[];
};
type PageIdentity = { operationId: string; part?: number; continue?: boolean };
/** Reuse the existing maintenance receipt store. A lost reply replays its numeric result;
 * it cannot silently spend another page's delete-write budget. No per-row receipt. */
async function expiryPage(ctx: MutationCtx, input: PageIdentity, kind: string, work: () => Promise<Outcome>) {
  const part = `${kind}:${input.part ?? 0}`,
    request = canonicalPayload(input);
  const old = await ctx.db
    .query('legacyStorageCleanupPages')
    .withIndex('by_operation_and_part', q => q.eq('operationId', input.operationId).eq('part', part))
    .unique();
  if (old) {
    invariant(old.request === request, 'WORK_OPERATION_CHANGED', 'Retry the original expiry page.');
    return JSON.parse(old.result) as Outcome;
  }
  const outcome = await work();
  if (!outcome.kept)
    await ctx.db.insert('legacyStorageCleanupPages', {
      operationId: input.operationId,
      part,
      request,
      result: JSON.stringify(outcome),
    });
  if (outcome.more && input.continue !== false)
    await ctx.scheduler.runAfter(
      0,
      kind === 'source'
        ? makeFunctionReference<'mutation'>('projectOperationalExpiry:source')
        : makeFunctionReference<'mutation'>('projectOperationalExpiry:check'),
      {
        ...input,
        part: (input.part ?? 0) + 1,
        ...(kind === 'callbacks' ? { cursor: outcome.nextCursor } : {}),
      },
    );
  return outcome;
}

export const checkExpiryArgs = {
  tableStats: v.optional(v.boolean()),
  cutoff: v.optional(v.number()),
  projectId: v.id('hostedProjects'),
  runId: v.string(),
  operationId: v.string(),
  part: v.optional(v.number()),
  phase: v.union(v.literal('callbacks'), v.literal('detail')),
  cursor: v.optional(v.union(v.string(), v.null())),
  dueAt: v.number(),
  continue: v.optional(v.boolean()),
};
export async function expireCheck(
  ctx: MutationCtx,
  input: import('convex/values').ObjectType<typeof checkExpiryArgs>,
) {
  return expiryPage(ctx, input, input.phase, async () => {
    projectExecution(ctx, input.projectId);
    const row = await ctx.db
      .query('projectHostedCheckRuns')
      .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
      .unique();
    if (!row) return empty(true);
    const run = hostedCheckRunSchema.parse(JSON.parse(row.value));
    const window = input.phase === 'callbacks' ? exhaustRetentionMs : checkDetailRetentionMs;
    if (
      !hostedCheckTerminal(run) ||
      !run.endedAt ||
      Date.now() < Math.max(input.dueAt, Date.parse(run.endedAt) + window)
    )
      return empty(true);
    const tables: { table: string; rows: number; bytes: number }[] = [];
    let rows = 0,
      removedBytes = 0,
      more = false;
    if (input.phase === 'callbacks') {
      const page = await ctx.db
        .query('projectHostedCheckCallbacks')
        .withIndex('by_project_and_run', q =>
          q
            .eq('projectId', input.projectId)
            .eq('runId', input.runId)
            .lt('_creationTime', input.cutoff ?? Date.parse(run.endedAt!) + exhaustRetentionMs),
        )
        .paginate({ cursor: input.cursor ?? null, numItems: pageSize });
      // IDs/digests are retry receipts. Reuse aliases also authorize exact-tree evidence.
      // Neither is exhaust: only raw callback/heartbeat bodies can be reclaimed.
      for (const callback of page.page) {
        if (!callback.value || callback.value === '{}' || callback.eventId.startsWith('reuse:')) continue;
        removedBytes += bytes(callback) - bytes({ ...callback, value: '{}' });
        await ctx.db.patch(callback._id, { value: '{}' });
        rows++;
      }
      more = !page.isDone;
      console.log(`FORGE_EXHAUST_EXPIRY ${JSON.stringify({ kind: input.phase, rows, bytes: removedBytes })}`);
      return {
        rows,
        bytes: removedBytes,
        more,
        kept: false,
        nextCursor: page.isDone ? null : page.continueCursor,
        ...(input.tableStats
          ? {
              readBytes: bytes(row) + page.page.reduce((n, r) => n + bytes(r), 0),
              tables: [{ table: 'projectHostedCheckCallbacks', rows, bytes: removedBytes }],
            }
          : {}),
      };
    } else {
      // These tables contain execution/detail copies, never verdicts, acceptance receipts or logs.
      const shards = await ctx.db
        .query('projectHostedCheckShards')
        .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
        .take(pageSize);
      const reports = shards.length
        ? []
        : await ctx.db
            .query('projectHostedActionsResults')
            .withIndex('by_project_and_run_and_index', q =>
              q.eq('projectId', input.projectId).eq('runId', input.runId),
            )
            .take(pageSize);
      const page = [...shards, ...reports];
      rows = page.length;
      removedBytes = await remove(ctx, page);
      if (page.length)
        tables.push({
          table: shards.length ? 'projectHostedCheckShards' : 'projectHostedActionsResults',
          rows,
          bytes: removedBytes,
        });
      more = page.length > 0;
      if (!more && (run.contractReports || row.reportParts || row.reportDigest)) {
        const compact = { ...run };
        delete compact.contractReports;
        // Preserve testFiles, verdict/terminalDigest, request/source pins, proof, provider/receipt
        // links, output/cost references and all other audit fields. Readers see no detached pages.
        const value = JSON.stringify(compact);
        const { reportParts: _parts, reportDigest: _digest, ...kept } = row;
        void _parts;
        void _digest;
        const reclaimed = Math.max(0, bytes(row) - bytes({ ...kept, value }));
        removedBytes += reclaimed;
        tables.push({ table: 'projectHostedCheckRuns', rows: 1, bytes: reclaimed });
        await ctx.db.patch(row._id, { value, reportParts: undefined, reportDigest: undefined });
      }
    }
    console.log(`FORGE_EXHAUST_EXPIRY ${JSON.stringify({ kind: input.phase, rows, bytes: removedBytes })}`);
    return {
      rows,
      bytes: removedBytes,
      more,
      kept: false,
      ...(input.tableStats ? { readBytes: bytes(row) + removedBytes, tables } : {}),
    };
  });
}

export const sourceExpiryArgs = {
  tableStats: v.optional(v.boolean()),
  projectId: v.id('hostedProjects'),
  jobId: v.string(),
  operationId: v.string(),
  part: v.optional(v.number()),
  dueAt: v.number(),
  continue: v.optional(v.boolean()),
};
export async function expireSource(
  ctx: MutationCtx,
  input: import('convex/values').ObjectType<typeof sourceExpiryArgs>,
) {
  return expiryPage(ctx, input, 'source', async () => {
    projectExecution(ctx, input.projectId);
    let job;
    try {
      job = await loadSourceJob(ctx, input.projectId, input.jobId);
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'NOT_FOUND') return empty(true);
      throw error;
    }
    if (
      !sourceJobTerminal(job) ||
      Date.now() < Math.max(input.dueAt, Date.parse(job.at) + exhaustRetentionMs)
    )
      return empty(true);
    const batch = (
      await ctx.db
        .query('projectSourceBatches')
        .withIndex('by_project_and_job_and_step', q =>
          q.eq('projectId', input.projectId).eq('jobId', input.jobId),
        )
        .take(1)
    )[0];
    if (!batch) return empty();
    const tasks = await ctx.db
      .query('projectSourceTasks')
      .withIndex('by_batch_and_index', q => q.eq('batchId', batch._id))
      .take(pageSize);
    // Terminal jobs cannot join/retry. Physical tasks may still own pool slots after fencing;
    // never reclaim those rows before their scheduled execution has actually settled.
    const pool = await ctx.db
      .query('projectSourcePools')
      .withIndex('by_key', q => q.eq('key', 'source'))
      .unique();
    const active = new Map(pool?.active.map(slot => [typeof slot === 'string' ? slot : slot.task, slot]));
    for (const task of tasks) {
      const scheduled = task.scheduledId ? await ctx.db.system.get(task.scheduledId) : null;
      const slot = active.get(task._id);
      const held = slot && typeof slot !== 'string' ? await ctx.db.system.get(slot.scheduled) : null;
      if ([scheduled, held].some(run => run && ['pending', 'inProgress'].includes(run.state.kind))) {
        if (input.continue !== false)
          await ctx.scheduler.runAfter(
            3_600_000,
            makeFunctionReference<'mutation'>('projectOperationalExpiry:source'),
            input,
          );
        return empty(true);
      }
    }
    let removedBytes = await remove(ctx, tasks),
      rows = tasks.length;
    const tables = [{ table: 'projectSourceTasks', rows, bytes: removedBytes }];
    if (tasks.length < pageSize) {
      tables.push({ table: 'projectSourceBatches', rows: 1, bytes: bytes(batch) });
      removedBytes += bytes(batch);
      await ctx.db.delete(batch._id);
      rows++;
    }
    console.log(`FORGE_EXHAUST_EXPIRY ${JSON.stringify({ kind: 'source', rows, bytes: removedBytes })}`);
    return {
      rows,
      bytes: removedBytes,
      more: true,
      kept: false,
      ...(input.tableStats
        ? {
            readBytes: 3 * bytes(job) + bytes(batch) + bytes(pool) + tasks.reduce((n, r) => n + bytes(r), 0),
            tables,
          }
        : {}),
    };
  });
}
