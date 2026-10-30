// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';
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
) {
  if (Date.now() - Date.parse(startedAt) >= HOSTED_FINISH_COMPOSE_WATCH_WINDOW_MS) return;
  await scheduleFinish(ctx, (await ctx.db.get(rowId))!, HOSTED_FINISH_COMPOSE_WATCHDOG_MS);
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
