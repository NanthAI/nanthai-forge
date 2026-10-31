// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

export const checkWakeRow = (ctx: MutationCtx, input: { projectId: Id<'hostedProjects'>; runId: string }) =>
  ctx.db
    .query('projectHostedLandingCheckWakes')
    .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
    .unique();
export async function scheduleCheckWake(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; runId: string },
  row: Awaited<ReturnType<typeof checkWakeRow>>,
) {
  const id = crypto.randomUUID();
  const taskId = await ctx.scheduler.runAfter(
    0,
    makeFunctionReference<'mutation'>('projectHostedLandingDriver:checkWake'),
    { ...input, wakeId: id },
  );
  if (row) await ctx.db.patch(row._id, { wake: { taskId, id } });
  else await ctx.db.insert('projectHostedLandingCheckWakes', { ...input, wake: { taskId, id } });
}
/** H10 schedules one coalesced metadata fan-out in its result transaction. Its
 * cost stays constant even if thousands of requests wait for the same run. */
export async function notifyLandingCheck(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    runId: string;
    /** False for a progress write: an admitting request waits for the terminal one. */
    terminal?: boolean;
  },
) {
  const waiting = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_run_and_phase', q =>
      q.eq('projectId', input.projectId).eq('runId', input.runId).eq('phase', 'checking'),
    )
    .take(1);
  if (!waiting.length || (input.terminal === false && waiting[0]!.admitting)) return;
  const row = await checkWakeRow(ctx, { projectId: input.projectId, runId: input.runId });
  if (row?.wake) {
    const task = await ctx.db.system.get(row.wake.taskId);
    if (task?.state.kind === 'pending' || task?.state.kind === 'inProgress') return;
  }
  await scheduleCheckWake(ctx, { projectId: input.projectId, runId: input.runId }, row);
}
