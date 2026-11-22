// SPDX-License-Identifier: Apache-2.0
import { cancelPendingTask } from './schedulerCancel';
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';
import { hostedLandingProgressAt } from '../src/hosted-landing-stall';
import { LANDING_STALL_MS } from '../src/landing-stall';
/** One retained deadline per pending goal. Progress replaces it, terminal outcomes
 * cancel it, and admission transfers it from preparation to the canonical queue. */
export async function scheduleLandingAlarm(ctx: MutationCtx, state: HostedLandingState) {
  const next = await landingAlarmPatch(ctx, state);
  if (next) await ctx.db.patch(next.id, { alarm: next.alarm });
}
/** The alarm change for this state without writing the canonical row, so a
 * caller that writes the row anyway folds it into that one write. */
export async function landingAlarmPatch(
  ctx: MutationCtx,
  state: HostedLandingState,
  consumedAlarm?: Id<'_scheduled_functions'>,
  canonicalRow?: Doc<'projectHostedLandingRequests'>,
) {
  const projectId = state.projectId as Id<'hostedProjects'>;
  const canonical =
    canonicalRow ??
    (await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_submission', q => q.eq('projectId', projectId).eq('submissionId', state.id))
      .unique());
  // Admission already transferred the preparation alarm. Progress writes reuse
  // their canonical row instead of re-reading both publications.
  const desired = canonicalRow
    ? null
    : await ctx.db
        .query('projectHostedLandingDesired')
        .withIndex('by_project_and_submission', q =>
          q.eq('projectId', projectId).eq('submissionId', state.id),
        )
        .unique();
  if (canonical && desired?.alarm) {
    await cancelPendingTask(ctx, desired.alarm.taskId);
    await ctx.db.patch(desired._id, { alarm: null });
  }
  const row = canonical ?? desired;
  if (!row) return null;
  const at = hostedLandingProgressAt(state);
  const live =
    state.observation.state === 'pending' &&
    (state.phase === 'checking' || state.observation.pendingReason !== 'waiting-for-review');
  const pending = live && state.observation.stall?.lastProgressAt !== at;
  // Same progress time: keep its alarm, or the supervisor round that follows a
  // raised stall (19328518); writes that make no progress must not cancel it.
  const consumed = row.alarm?.taskId === consumedAlarm && consumedAlarm !== undefined;
  if (live && row.alarm?.lastProgressAt === at) return consumed ? { id: row._id, alarm: null } : null;
  if (row.alarm && !consumed) await cancelPendingTask(ctx, row.alarm.taskId);
  if (!pending) return row.alarm ? { id: row._id, alarm: null } : null;
  const taskId = await ctx.scheduler.runAfter(
    Math.max(0, Date.parse(at) + LANDING_STALL_MS - Date.now()),
    makeFunctionReference<'mutation'>('projectHostedLandingStall:alarm'),
    { projectId, submissionId: state.id, lastProgressAt: at },
  );
  return { id: row._id, alarm: { taskId, lastProgressAt: at } };
}
/** One-shot stall alarm for an order waiter that was just woken (incident
 * c329d191): returns the alarm field for the caller's own write of the row. It
 * fires no sooner than 15 min after the wake and never before the stall rule
 * counts the entry stalled (a progress stamp can run slightly ahead of this clock). */
export async function armLandingAlarm(
  ctx: MutationCtx,
  row: { projectId: Id<'hostedProjects'>; submissionId: string },
  lastProgressAt: string,
  delay = LANDING_STALL_MS,
) {
  const taskId = await ctx.scheduler.runAfter(
    Math.max(delay, (Date.parse(lastProgressAt) || 0) + delay - Date.now()),
    makeFunctionReference<'mutation'>('projectHostedLandingStall:alarm'),
    { projectId: row.projectId, submissionId: row.submissionId, lastProgressAt },
  );
  return { taskId, lastProgressAt };
}
