// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
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
export async function landingAlarmPatch(ctx: MutationCtx, state: HostedLandingState) {
  const projectId = state.projectId as Id<'hostedProjects'>;
  const canonical = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_submission', q => q.eq('projectId', projectId).eq('submissionId', state.id))
    .unique();
  const desired = await ctx.db
    .query('projectHostedLandingDesired')
    .withIndex('by_project_and_submission', q => q.eq('projectId', projectId).eq('submissionId', state.id))
    .unique();
  if (canonical && desired?.alarm) {
    await ctx.scheduler.cancel(desired.alarm.taskId);
    await ctx.db.patch(desired._id, { alarm: null });
  }
  const row = canonical ?? desired;
  if (!row) return null;
  const at = hostedLandingProgressAt(state);
  const pending =
    state.observation.state === 'pending' &&
    state.observation.pendingReason !== 'waiting-for-review' &&
    state.observation.stall?.lastProgressAt !== at;
  if (pending && row.alarm?.lastProgressAt === at) return null;
  if (row.alarm) await ctx.scheduler.cancel(row.alarm.taskId);
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
) {
  const taskId = await ctx.scheduler.runAfter(
    Math.max(LANDING_STALL_MS, (Date.parse(lastProgressAt) || 0) + LANDING_STALL_MS - Date.now()),
    makeFunctionReference<'mutation'>('projectHostedLandingStall:alarm'),
    { projectId: row.projectId, submissionId: row.submissionId, lastProgressAt },
  );
  return { taskId, lastProgressAt };
}
