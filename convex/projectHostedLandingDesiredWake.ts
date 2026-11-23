// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { cancelPendingTask } from './schedulerCancel';
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { hostedOperationRow } from './projectHostedOperations';
type Row = Doc<'projectHostedLandingDesired'>;
export const desiredLanding = (
  ctx: MutationCtx | QueryCtx,
  input: { projectId: Id<'hostedProjects'>; submissionId: string },
) =>
  ctx.db
    .query('projectHostedLandingDesired')
    .withIndex('by_project_and_submission', q =>
      q.eq('projectId', input.projectId).eq('submissionId', input.submissionId),
    )
    .unique();
export async function scheduleDesired(ctx: MutationCtx, row: Row, delay: number) {
  await cancelPendingTask(ctx, row.wake?.taskId);
  const id = crypto.randomUUID();
  const taskId = await ctx.scheduler.runAfter(
    delay,
    makeFunctionReference<'action'>('projectHostedLandingDesired:drive'),
    { projectId: row.projectId, submissionId: row.submissionId, wakeId: id },
  );
  await ctx.db.patch(row._id, { wake: { id, taskId } });
  return id;
}
export async function notifyDesiredCompose(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  composeOperationId: string,
) {
  const rows = await ctx.db
    .query('projectHostedLandingDesired')
    .withIndex('by_project_and_compose', q =>
      q.eq('projectId', projectId).eq('composeOperationId', composeOperationId),
    )
    // Newest first (friction 9809f716): a compose can carry a cancelled or failed goal before the
    // live one, and only goals still holding a wake are pending. Three rows, as LaneFinish reads;
    // the backed-off watchdog stays the backstop beyond them.
    .order('desc')
    .take(3);
  for (const row of rows) if (row.wake) await scheduleDesired(ctx, row, 0);
}
/** A replay of the original request drives a preparing goal at once when its wake can no longer run
 * (failed, cancelled or gone: 08169467), or when it is a backed-off watchdog although its compose is
 * already terminal (9809f716). It keeps the wake id: a driver between claim and advance holds that
 * id and still admits the goal; the earlier drive then finds no wake. A running or due wake is left
 * alone. The operation read runs only on a replay with a future watchdog. */
export async function repairDesiredWake(ctx: MutationCtx, row: Row) {
  if (!row.wake) return;
  const task = await ctx.db.system.get(row.wake.taskId);
  const live = task && (task.state.kind === 'pending' || task.state.kind === 'inProgress');
  if (live && (task.state.kind !== 'pending' || task.scheduledTime <= Date.now())) return;
  if (live) {
    const operation = await hostedOperationRow(ctx, row.projectId, row.actor, row.composeOperationId);
    if (!operation || !(JSON.parse(operation.value) as { terminal?: unknown }).terminal) return;
  }
  await cancelPendingTask(ctx, row.wake.taskId);
  const taskId = await ctx.scheduler.runAfter(
    0,
    makeFunctionReference<'action'>('projectHostedLandingDesired:drive'),
    { projectId: row.projectId, submissionId: row.submissionId, wakeId: row.wake.id },
  );
  await ctx.db.patch(row._id, { wake: { id: row.wake.id, taskId } });
}
