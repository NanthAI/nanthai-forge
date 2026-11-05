// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { mutation, internalMutation, internalAction } from './cliServer';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { acceptanceActor } from './projectAutonomy';
import { activeProject } from './projectAuthority';
import { landingRow } from './projectHostedLandingStore';
import { landingQueue, scheduleLandingWake } from './projectHostedLandingEvents';
import { finishRow, scheduleFinish } from './projectHostedFinishWake';
import { armLandingAlarm } from './projectHostedLandingStallWake';
import { desiredLanding, scheduleDesired } from './projectHostedLandingDesiredWake';
import { checkWakeRow, scheduleCheckWake } from './projectHostedLandingCheckWake';
import { activeStoragePause } from './legacyStoragePause';
import { redriveCohortHold } from './projectHostedLandingCohortHold';
import { hostedLandingStateSchema } from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';
import { report } from './errors';

/** Issue 72d50375: any write outage (the dev storage pause, OCC exhaustion, a
 * platform incident) makes a scheduled settlement step or stall alarm throw.
 * Convex does not retry it and the row keeps pointing at the failed task, so the
 * entry has no owner. Re-drive is event driven only: when writes resume after
 * a pause (sweep), and when a waiting reader's entry stays Ready with no new
 * version (redrive, which finds the lost steps itself). No cron, no server
 * poll; an idle queue costs nothing. */
/** A step is lost when its function failed (a refused write, OCC exhaustion)
 * or the task no longer exists. Pending, running, succeeded and deliberately
 * cancelled steps are not. */
async function lost(ctx: MutationCtx, taskId: Id<'_scheduled_functions'>) {
  const task = await ctx.db.system.get(taskId);
  return !task || task.state.kind === 'failed';
}
type Identity = { projectId: Id<'hostedProjects'>; submissionId: string };
/** Bounded so one sweep transaction stays small at any queue length. */
export const REDRIVE_SWEEP_ENTRIES = 64;

/** Replays only steps that were lost: each kind keeps its own identity and
 * fence, so a repeated or concurrent re-drive schedules nothing new. A lost
 * alarm is re-armed one stall window from now, not fired at once: the outage
 * is not the entry's stall, and the re-driven step owns progress meanwhile. */
export async function redriveLanding(
  ctx: MutationCtx,
  input: Identity,
  options: {
    row?: Doc<'projectHostedLandingRequests'>;
    queueChecked?: boolean;
  } = {},
) {
  const done: string[] = [];
  const row = options.row ?? (await landingRow(ctx, input));
  if (!row) {
    const desired = await desiredLanding(ctx, input);
    if (!desired || hostedLandingStateSchema.parse(JSON.parse(desired.value)).observation.state !== 'pending')
      return done;
    if (desired.wake && (await lost(ctx, desired.wake.taskId))) {
      await scheduleDesired(ctx, desired, 0);
      done.push('compose');
    }
    if (desired.alarm && (await lost(ctx, desired.alarm.taskId))) {
      const alarm = await armLandingAlarm(ctx, input, desired.alarm.lastProgressAt);
      await ctx.db.patch(desired._id, { alarm });
      done.push('alarm');
    }
    return done;
  }
  if (row.phase === 'landed' || row.phase === 'terminal-failed') return done;
  if (row.alarm && (await lost(ctx, row.alarm.taskId))) {
    const alarm = await armLandingAlarm(ctx, input, row.alarm.lastProgressAt);
    await ctx.db.patch(row._id, { alarm });
    done.push('alarm');
  }
  const finish = await finishRow(ctx, input);
  if (finish?.wake && (await lost(ctx, finish.wake.taskId))) {
    // Same generation: the lost step's IO fence stays valid and nothing is repeated twice.
    await scheduleFinish(ctx, finish, 0, true);
    done.push('finish');
  } else if (finish?.waiting && finish.parentSubmissionId) {
    // The parent's terminal event (FinishDriver:dependents) was lost.
    const parent = await landingRow(ctx, {
      projectId: input.projectId,
      submissionId: finish.parentSubmissionId,
    });
    if (parent && (parent.phase === 'landed' || parent.phase === 'terminal-failed')) {
      await ctx.db.patch(finish._id, { waiting: false });
      await scheduleFinish(ctx, { ...finish, waiting: false });
      done.push('dependency');
    }
  }
  if (row.phase === 'queued' && (await redriveCohortHold(ctx, row))) done.push('hold');
  if (row.phase === 'queued' || row.phase === 'checking') {
    if (!options.queueChecked && (await redriveQueue(ctx, input.projectId))) done.push('queue');
    if (row.phase === 'checking' && row.runId) {
      const wake = await checkWakeRow(ctx, {
        projectId: input.projectId,
        runId: row.runId,
      });
      if (wake?.wake && (await lost(ctx, wake.wake.taskId))) {
        await scheduleCheckWake(ctx, { projectId: input.projectId, runId: row.runId }, wake);
        done.push('check');
      }
    }
  }
  return done;
}
async function redriveQueue(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const queue = await landingQueue(ctx, { projectId, channel: 'main' });
  if (!queue?.wake || !(await lost(ctx, queue.wake.taskId))) return false;
  await scheduleLandingWake(ctx, queue, queue.wake.at);
  return true;
}

/** A waiting reader asks for this when its entry stays Ready. Contributors only;
 * it never creates an attempt, a check or a new selection. */
export const redrive = mutation({
  args: { projectId: v.id('hostedProjects'), submissionId: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const actor = await acceptanceActor(ctx);
      await activeProject(ctx, input.projectId, actor.id);
      return canonicalPayload({ redriven: await redriveLanding(ctx, input) });
    } catch (error) {
      return report(error);
    }
  },
});

/** One project per transaction: its queue wake once, then its live entries. */
export const sweep = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('projectHostedLandingQueues')
      .withIndex('by_project_and_channel', q => q)
      .paginate({ cursor, numItems: 1 });
    for (const queue of page.page) {
      await redriveQueue(ctx, queue.projectId);
      for (const phase of ['ready', 'checking', 'queued'] as const) {
        const rows = await ctx.db
          .query('projectHostedLandingRequests')
          .withIndex('by_project_and_channel_and_phase_and_sequence', q =>
            q.eq('projectId', queue.projectId).eq('channel', 'main').eq('phase', phase),
          )
          .take(REDRIVE_SWEEP_ENTRIES);
        for (const row of rows) await redriveLanding(ctx, row, { row, queueChecked: true });
      }
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'mutation'>('projectHostedLandingRedrive:sweep'),
        {
          cursor: page.continueCursor,
        },
      );
    return null;
  },
});

/** Writes resumed after an approved dev storage pause. The window can end
 * before the operator removes the flag; wait for that (at most until the
 * window's own expiry, one check a minute) and then sweep once. */
export const resume = internalAction({
  args: {},
  returns: v.null(),
  handler: async ctx => {
    const pause = activeStoragePause();
    if (pause)
      await ctx.scheduler.runAfter(
        Math.max(1_000, Math.min(60_000, pause.expiresAt - Date.now())),
        makeFunctionReference<'action'>('projectHostedLandingRedrive:resume'),
        {},
      );
    else
      await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedLandingRedrive:sweep'), {
        cursor: null,
      });
    return null;
  },
});
