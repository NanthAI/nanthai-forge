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
  if (!row) return;
  const at = hostedLandingProgressAt(state);
  const pending = state.observation.state === 'pending' && state.observation.stall?.lastProgressAt !== at;
  if (pending && row.alarm?.lastProgressAt === at) return;
  if (row.alarm) await ctx.scheduler.cancel(row.alarm.taskId);
  if (!pending) {
    if (row.alarm) await ctx.db.patch(row._id, { alarm: null });
    return;
  }
  const taskId = await ctx.scheduler.runAfter(
    Math.max(0, Date.parse(at) + LANDING_STALL_MS - Date.now()),
    makeFunctionReference<'mutation'>('projectHostedLandingStall:alarm'),
    { projectId, submissionId: state.id, lastProgressAt: at },
  );
  await ctx.db.patch(row._id, { alarm: { taskId, lastProgressAt: at } });
}
