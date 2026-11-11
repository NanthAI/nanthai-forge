// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, type MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { expireCheck, expireSource } from './projectOperationalExpiryPages';
import { hostedCheckRunSchema, hostedCheckTerminal } from '../src/hosted-check';
import { loadSourceJob, sourceJobTerminal } from './projectSourceJobs';
import { checkDetailRetentionMs, exhaustRetentionMs } from './projectOperationalExpirySchedule';
import { ForgeError, invariant } from '../src/errors';
import { HOSTED_WORK_INDEX_FORMAT } from '../src/work-hosted-summary';
import { repairLandingSpeedPage } from './projectLandingSpeedRepair';
import { projectExecution } from './projectExecution';

type Total = { table: string; rows: number; bytes: number };
type Progress = {
  step: number;
  cutoff: number;
  phase: 'checks' | 'source' | 'generations' | 'done';
  after: string;
  cursor: string | null;
  check?: { id: string; phase: 'callbacks' | 'detail'; part: number; cursor: string | null };
  job?: { id: string; part: number };
  totals: Total[];
  queue: number;
  serviceMs: number;
  paused: boolean;
  /** Undefined on older receipts; null once the one-time stamp repair is complete. */
  speedAfter?: string | null;
  speedCutoff?: number;
};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const ref = makeFunctionReference<'mutation'>('projectOperationalExpiry:catchup');
const identity = (projectId: Id<'hostedProjects'>) => `exhaust-catchup:v1:${projectId}`;
async function receipt(ctx: MutationCtx, operationId: string) {
  return ctx.db
    .query('legacyStorageCleanupPages')
    .withIndex('by_operation_and_part', q => q.eq('operationId', operationId).eq('part', 'cursor'))
    .unique();
}
/** Piggyback on a due expiry, never on an idle timer or the landing's hot write. */
export async function armExpiryCatchup(ctx: MutationCtx, projectId: Id<'hostedProjects'>, schedule = true) {
  const operationId = identity(projectId);
  const old = await receipt(ctx, operationId);
  if (old) {
    const p: Progress = JSON.parse(old.result);
    if (schedule && (p.speedAfter !== null || (p.paused && p.phase !== 'done')))
      await ctx.scheduler.runAfter(1_000, ref, { projectId, operationId, step: p.step });
    return;
  }
  const progress: Progress = {
    step: 0,
    cutoff: Date.now(),
    phase: 'checks',
    after: '',
    cursor: null,
    totals: [],
    queue: 0,
    serviceMs: 0,
    paused: false,
  };
  await ctx.db.insert('legacyStorageCleanupPages', {
    operationId,
    part: 'cursor',
    request: projectId,
    result: JSON.stringify(progress),
  });
  if (schedule) await ctx.scheduler.runAfter(1_000, ref, { projectId, operationId, step: 0 });
}
async function deferCheck(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  runId: string,
  phase: 'callbacks' | 'detail',
  ended: number,
) {
  const dueAt = ended + (phase === 'callbacks' ? exhaustRetentionMs : checkDetailRetentionMs);
  await ctx.scheduler.runAfter(
    Math.max(0, dueAt - Date.now()),
    makeFunctionReference<'mutation'>('projectOperationalExpiry:check'),
    { projectId, runId, phase, dueAt, operationId: `exhaust:${runId}:${phase}`, part: 0 },
  );
}
async function next(ctx: MutationCtx, projectId: Id<'hostedProjects'>, operationId: string, p: Progress) {
  if (p.speedAfter !== null) {
    const page = await repairLandingSpeedPage(
      ctx,
      projectId,
      p.speedAfter ?? '',
      (p.speedCutoff ??= Date.now()),
    );
    p.speedAfter = page.done ? null : page.after;
    return page.readBytes + 4096;
  }
  if (p.check) {
    const c = p.check;
    const out = await expireCheck(ctx, {
      tableStats: true,
      cutoff: p.cutoff,
      projectId,
      runId: c.id,
      phase: c.phase,
      operationId: `${operationId}:${c.id}:${c.phase}`,
      part: c.part,
      cursor: c.cursor,
      dueAt: 0,
      continue: false,
    });
    for (const total of out.tables ?? []) add(p, total);
    if (out.more) {
      c.part++;
      c.cursor = out.nextCursor ?? null;
    } else if (c.phase === 'callbacks') p.check = { ...c, phase: 'detail', part: 0, cursor: null };
    else delete p.check;
    return (out.readBytes ?? 3 * 1024 * 1024) + 16 * 1024;
  }
  if (p.job) {
    const out = await expireSource(ctx, {
      tableStats: true,
      projectId,
      jobId: p.job.id,
      operationId: `${operationId}:${p.job.id}`,
      part: p.job.part,
      dueAt: 0,
      continue: false,
    });
    for (const total of out.tables ?? []) add(p, total);
    if (out.more) p.job.part++;
    else {
      // Still-live physical tasks keep their original inputs and get the existing targeted wake.
      if (out.kept)
        await ctx.scheduler.runAfter(
          3_600_000,
          makeFunctionReference<'mutation'>('projectOperationalExpiry:source'),
          { projectId, jobId: p.job.id, operationId: `${operationId}:${p.job.id}:physical`, dueAt: 0 },
        );
      delete p.job;
    }
    return (out.readBytes ?? 3 * 1024 * 1024) + 16 * 1024;
  }
  if (p.phase === 'checks') {
    const [row] = await ctx.db
      .query('projectHostedCheckRuns')
      .withIndex('by_project_and_run', q => q.eq('projectId', projectId).gt('runId', p.after))
      .take(1);
    if (!row) {
      p.phase = 'source';
      p.after = '';
      return 1024;
    }
    p.after = row.runId;
    if (row._creationTime > p.cutoff) return bytes(row);
    const run = hostedCheckRunSchema.parse(JSON.parse(row.value));
    if (!hostedCheckTerminal(run) || !run.endedAt || run.configuration.provider === 'ci-status')
      return bytes(row);
    const ended = Date.parse(run.endedAt);
    for (const phase of ['callbacks', 'detail'] as const) {
      if (Date.now() < ended + (phase === 'callbacks' ? exhaustRetentionMs : checkDetailRetentionMs))
        await deferCheck(ctx, projectId, run.id, phase, ended);
    }
    if (Date.now() >= ended + exhaustRetentionMs)
      p.check = { id: run.id, phase: 'callbacks', part: 0, cursor: null };
    return bytes(row) + 4096;
  }
  if (p.phase === 'source') {
    // Seek distinct jobs: do not scan a large task input or revisit all batches in a job.
    const [batch] = await ctx.db
      .query('projectSourceBatches')
      .withIndex('by_project_and_job_and_step', q => q.eq('projectId', projectId).gt('jobId', p.after))
      .take(1);
    if (!batch) {
      p.phase = 'generations';
      p.after = '';
      return 1024;
    }
    p.after = batch.jobId;
    if (batch._creationTime > p.cutoff) return bytes(batch);
    let job;
    try {
      job = await loadSourceJob(ctx, projectId, batch.jobId);
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'NOT_FOUND') return 3 * 1024 * 1024;
      throw error;
    }
    if (!sourceJobTerminal(job)) return bytes(batch) + 3 * bytes(job) + 4096;
    const dueAt = Date.parse(job.at) + exhaustRetentionMs;
    if (Date.now() < dueAt) {
      await ctx.scheduler.runAfter(
        dueAt - Date.now(),
        makeFunctionReference<'mutation'>('projectOperationalExpiry:source'),
        { projectId, jobId: job.id, operationId: `exhaust:${job.id}:source`, dueAt },
      );
    } else p.job = { id: job.id, part: 0 };
    return bytes(batch) + 3 * bytes(job) + 4096;
  }
  const page = await ctx.db
    .query('projectWorkGenerations')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .paginate({ cursor: p.cursor, numItems: 8, maximumBytesRead: 64 * 1024, maximumRowsRead: 8 });
  const project = await ctx.db.get(projectId);
  for (const generation of page.page) {
    if (
      project &&
      generation._creationTime <= p.cutoff &&
      project.work?.generationId !== generation._id &&
      (generation.status === 'failed' ||
        generation.format !== HOSTED_WORK_INDEX_FORMAT ||
        project.work?.backupId !== generation.backupId ||
        project.work.revision !== generation.revision)
    )
      await ctx.scheduler.runAfter(1_000, makeFunctionReference<'mutation'>('projectWorkIndexStore:retire'), {
        generationId: generation._id,
        projectId,
      });
  }
  p.cursor = page.continueCursor;
  if (page.isDone) p.phase = 'done';
  return page.page.reduce((n, r) => n + bytes(r), 0) + bytes(project) + 4096;
}
function add(p: Progress, total: Total) {
  const old = p.totals.find(t => t.table === total.table);
  if (old) {
    old.rows += total.rows;
    old.bytes += total.bytes;
  } else p.totals.push({ ...total });
}
/** One resumable, fixed-cutoff walk per project/version. Explicit steps reconcile lost replies;
 * queue/service growth pauses without polling. The next due expiry or an operator resumes it. */
export const catchup = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    step: v.number(),
    pages: v.optional(v.number()),
    resume: v.optional(v.boolean()),
    continue: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    invariant(
      input.operationId === identity(input.projectId),
      'BAD_ARGUMENT',
      'Use the project catch-up operation identity.',
    );
    invariant(
      Number.isSafeInteger(input.step) && input.step >= 0,
      'BAD_ARGUMENT',
      'Use the returned catch-up step.',
    );
    const pages = input.pages ?? 16;
    invariant(
      Number.isSafeInteger(pages) && pages >= 1 && pages <= 16,
      'BAD_ARGUMENT',
      'Use one to sixteen bounded catch-up pages.',
    );
    projectExecution(ctx, input.projectId);
    let row = await receipt(ctx, input.operationId);
    if (!row) {
      await armExpiryCatchup(ctx, input.projectId, false);
      row = await receipt(ctx, input.operationId);
    }
    const p: Progress = JSON.parse(row!.result);
    invariant(input.step <= p.step, 'BAD_ARGUMENT', 'Resume the current catch-up step.');
    if (input.step < p.step || (p.phase === 'done' && p.speedAfter === null)) return row!.result;
    const queue = await ctx.db
      .query('projectHostedLandingQueues')
      .withIndex('by_project_and_channel', q => q.eq('projectId', input.projectId).eq('channel', 'main'))
      .unique();
    const depth = queue?.status?.total ?? 0,
      serviceMs = queue?.status?.serviceMs ?? 0;
    if (p.step === 0 || (input.resume && p.paused)) {
      p.queue = depth;
      p.serviceMs = serviceMs;
    }
    p.paused = depth > p.queue || (p.serviceMs > 0 && serviceMs > p.serviceMs * 1.25);
    if (!p.paused) {
      let readCharge = 0;
      for (
        let page = 0;
        page < pages &&
        readCharge < 256 * 1024 &&
        ((p as Progress).phase !== 'done' || p.speedAfter !== null);
        page++
      )
        readCharge += await next(ctx, input.projectId, input.operationId, p);
      p.step++;
      if (input.continue !== false && ((p as Progress).phase !== 'done' || p.speedAfter !== null))
        await ctx.scheduler.runAfter(1_000, ref, { ...input, step: p.step });
    }
    const result = JSON.stringify(p);
    await ctx.db.patch(row!._id, { result });
    return result;
  },
});
