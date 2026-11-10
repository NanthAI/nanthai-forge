// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { hostedLandingStateSchema, type HostedLandingState } from '../src/hosted-landing';
import { hostedLandingProgressAt } from '../src/hosted-landing-stall';
import { armLandingAlarm } from './projectHostedLandingStallWake';
import {
  HOSTED_FINISH_COMPOSE_WATCHDOG_MS,
  HOSTED_FINISH_COMPOSE_WATCH_WINDOW_MS,
} from '../src/hosted-finish';
export const finishRow = (
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; submissionId: string },
) =>
  ctx.db
    .query('projectHostedFinishes')
    .withIndex('by_project_and_submission', q =>
      q.eq('projectId', input.projectId).eq('submissionId', input.submissionId),
    )
    .unique();
/** Only pending work has a timer. Failed scheduling receipts can be repaired by
 * the original enqueue/resume; a running step retains its exact IO generation. */
export async function scheduleFinish(
  ctx: MutationCtx,
  row: Doc<'projectHostedFinishes'>,
  delay = 0,
  retainId = false,
) {
  if (row.wake && !retainId) {
    const task = await ctx.db.system.get(row.wake.taskId);
    if (task?.state.kind === 'pending' || task?.state.kind === 'inProgress') return;
  }
  if (row.wake) await ctx.scheduler.cancel(row.wake.taskId);
  const id = retainId && row.wake ? row.wake.id : crypto.randomUUID();
  const taskId = await ctx.scheduler.runAfter(
    delay,
    makeFunctionReference<'action'>('projectHostedFinishDriver:drive'),
    {
      projectId: row.projectId,
      submissionId: row.submissionId,
      wakeId: id,
    },
  );
  await ctx.db.patch(row._id, { wake: { id, taskId, at: Date.now() + delay } });
}
/** Incident 2026-10-30: a source step action that threw (fetch failed) left its
 * compose running with no owner wake; the whole train waited for the 15-minute
 * stall alarm. The wake replays submit, whose lookup resumes the same step. */
export async function watchFinishCompose(
  ctx: MutationCtx,
  rowId: Id<'projectHostedFinishes'>,
  startedAt: string,
  settle: () => Promise<void>,
) {
  const remaining = Date.parse(startedAt) + HOSTED_FINISH_COMPOSE_WATCH_WINDOW_MS - Date.now();
  const row = (await ctx.db.get(rowId))!;
  if (remaining <= 0) {
    await settle();
    return;
  }
  await scheduleFinish(ctx, row, Math.min(HOSTED_FINISH_COMPOSE_WATCHDOG_MS, remaining));
}
export async function notifyFinish(ctx: MutationCtx, state: HostedLandingState) {
  const projectId = state.projectId as Id<'hostedProjects'>;
  if (state.batchId && (state.phase === 'landed' || state.phase === 'terminal-failed')) {
    const batch = await ctx.db
      .query('projectHostedLandingBatches')
      .withIndex('by_project_and_batch', q => q.eq('projectId', projectId).eq('batchId', state.batchId!))
      .unique();
    if (batch && JSON.parse(batch.value).phase === 'fallback') {
      const leader = await finishRow(ctx, {
        projectId,
        submissionId: JSON.parse(batch.value).leaderId ?? state.batchId,
      });
      if (leader) await scheduleFinish(ctx, leader);
    }
  }
  const row = await finishRow(ctx, { projectId, submissionId: state.id });
  if (
    row &&
    !JSON.parse(row.value).pending &&
    state.observation.pendingReason !== 'waiting-for-dependency' &&
    state.observation.pendingReason !== 'waiting-for-review' &&
    ['ready', 'terminal-failed', 'landed'].includes(state.phase)
  )
    await scheduleFinish(ctx, row);
  if (state.phase !== 'landed' && state.phase !== 'terminal-failed') return;
  const dependents = await ctx.db
    .query('projectHostedFinishes')
    .withIndex('by_project_and_parent_and_waiting', q =>
      q.eq('projectId', projectId).eq('parentSubmissionId', state.id).eq('waiting', true),
    )
    .take(1);
  if (dependents.length)
    await ctx.scheduler.runAfter(
      0,
      makeFunctionReference<'mutation'>('projectHostedFinishDriver:dependents'),
      { projectId, submissionId: state.id },
    );
}
/** An older submission stopped holding its place in the landing order: re-drive
 * the oldest passed entry that waited for it and hand the rest to that entry,
 * which takes main before them anyway. Exact indexed waiters, one drive per
 * transition, never one per waiter; the woken claim re-reads the order. Waiters
 * own no alarm, so every one is reached: each page leaves the index range. */
export async function wakeLandingOrderWaiters(
  ctx: MutationCtx,
  row: Doc<'projectHostedLandingRequests'>,
  speculativeOnly = false,
) {
  let next: Doc<'projectHostedLandingRequests'> | null = null;
  let after = -1;
  for (;;) {
    const waiters = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_orderWait_and_sequence', q =>
        q.eq('projectId', row.projectId).eq('orderWait', row.submissionId).gt('sequence', after),
      )
      .order('asc')
      .take(32);
    for (const waiter of waiters) {
      after = waiter.sequence;
      // A re-pin retires speculative source generations, but this predecessor
      // still owns its ordinary place in acceptance order. Only its parked
      // conflict cohorts need a new main-based compose before settlement.
      if (
        speculativeOnly &&
        (!waiter.wouldConflict ||
          JSON.parse(waiter.wouldConflict).predecessor?.submissionId !== row.submissionId)
      )
        continue;
      if (next) {
        await ctx.db.patch(waiter._id, { orderWait: next.submissionId });
        if (!next.orderWaited) await ctx.db.patch(next._id, { orderWaited: (next.orderWaited = true) });
        continue;
      }
      const finish = await finishRow(ctx, { projectId: row.projectId, submissionId: waiter.submissionId });
      const drive = finish && !JSON.parse(finish.value).pending;
      // Incident c329d191 (2026-11-05): this one scheduled drive is the waiter's
      // only wake and it can fail (OCC exhaustion). Arm the waiter's stall alarm
      // in this same transaction; landing or a later park cancels it.
      const alarm =
        drive && !waiter.alarm && waiter.phase === 'ready'
          ? await armLandingAlarm(
              ctx,
              waiter,
              hostedLandingProgressAt(hostedLandingStateSchema.parse(JSON.parse(waiter.value))),
            )
          : undefined;
      await ctx.db.patch(waiter._id, { orderWait: undefined, ...(alarm ? { alarm } : {}) });
      // The order ended early: replace its reservation/hold expiry timer.
      // Coalescing with that pending future task strands an already passed
      // cohort until the obsolete bound (stucktrain). A parked finish has no
      // IO in flight; keep its wake identity and cancel the old task atomically.
      if (drive) await scheduleFinish(ctx, finish, 0, true);
      // A waiter that no longer holds its place cannot wake others; wake the next one too.
      if (waiter.orderLive) next = waiter;
    }
    if (waiters.length < 32) return;
  }
}
export async function notifyFinishCompose(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  operationId: string,
) {
  const row = await ctx.db
    .query('projectHostedFinishes')
    .withIndex('by_project_and_compose', q =>
      q.eq('projectId', projectId).eq('composeOperationId', operationId),
    )
    .unique();
  // Completion replaces the compose watchdog; no IO is in flight while it waits.
  if (row) await scheduleFinish(ctx, row, 0, true);
  const batch = await ctx.db
    .query('projectHostedLandingBatches')
    .withIndex('by_project_and_compose', q =>
      q.eq('projectId', projectId).eq('composeOperationId', operationId),
    )
    .unique();
  if (batch && !['superseded', 'landed'].includes(JSON.parse(batch.value).phase)) {
    const leader = await finishRow(ctx, {
      projectId,
      submissionId: JSON.parse(batch.value).leaderId ?? batch.batchId,
    });
    if (leader) await scheduleFinish(ctx, leader, 0, true);
  }
}
