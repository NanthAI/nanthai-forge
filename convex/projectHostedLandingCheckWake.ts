// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { progressWakeDue } from '../src/landing-stall';

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
  else await ctx.db.insert('projectHostedLandingCheckWakes', { ...input, version: 1, wake: { taskId, id } });
}
/** H10 schedules one coalesced metadata fan-out in its result transaction. Its
 * cost stays constant even if thousands of requests wait for the same run. */
export async function notifyLandingCheck(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    runId: string;
    /** Admission evaluation still waits for a terminal result. */
    terminal?: boolean;
  },
) {
  // The current run binding owns completion in either live queue phase. A
  // progress evaluation, recompose or claim must not make it undiscoverable.
  // Phase index order is checking, landed, queued, ready, terminal-failed.
  // One head probe finds a live binding or an empty set in the common case.
  // Landed history can precede queued waiters, so probe queued directly then;
  // never walk that history, even when many submissions reused the same run.
  let [waiting] = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_run_phase_checkWakeVersion', q =>
      q.eq('projectId', input.projectId).eq('runId', input.runId).lte('phase', 'queued'),
    )
    .take(1);
  if (waiting?.phase === 'landed')
    [waiting] = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_run_phase_checkWakeVersion', q =>
        q.eq('projectId', input.projectId).eq('runId', input.runId).eq('phase', 'queued'),
      )
      .take(1);
  if (!waiting || (input.terminal === false && waiting.admitting)) return;
  const row = await checkWakeRow(ctx, { projectId: input.projectId, runId: input.runId });
  // Advance even while a fanout is in flight. Pages which already consumed a
  // progress event must see a later terminal event before that fanout retires.
  if (row) await ctx.db.patch(row._id, { version: (row.version ?? 1) + 1 });
  // A progress event whose only waiter is a checking entry that retained
  // progress inside the throttle window cannot change anything: the wake would
  // read that row and the run, skip it unconsumed and retire. Schedule nothing.
  // The next event outside the window (or the terminal one, always) reaches the
  // entry through the version bumped above, exactly as a skipped wake would.
  if (input.terminal === false && waiting.phase === 'checking' && (await skippable(ctx, input, waiting)))
    return;
  if (row?.wake) {
    const task = await ctx.db.system.get(row.wake.taskId);
    if (task?.state.kind === 'pending' || task?.state.kind === 'inProgress') return;
  }
  await scheduleCheckWake(ctx, { projectId: input.projectId, runId: input.runId }, row);
}
/** The wake's own skip rule (`wakeLandingCheckPage`), evaluated from the head row
 * alone: a solo checking entry inside the throttle window. Batch members and any
 * run with a second waiter keep the earlier rule (no extra read for them). */
async function skippable(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; runId: string },
  waiting: Doc<'projectHostedLandingRequests'>,
) {
  if (waiting.admission?.status === 'checking') return false;
  const state = JSON.parse(waiting.value) as { batchId?: string; timing?: { ciProgressAt?: string } };
  if (state.batchId || progressWakeDue(state.timing?.ciProgressAt, Date.now())) return false;
  const waiters = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_run_phase_checkWakeVersion', q =>
      q.eq('projectId', input.projectId).eq('runId', input.runId).lte('phase', 'queued'),
    )
    .take(2);
  return waiters.length === 1;
}
