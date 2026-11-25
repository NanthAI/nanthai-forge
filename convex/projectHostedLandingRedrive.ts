// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { mutation, internalMutation } from './cliServer';
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
import { loadBatch } from './projectHostedLandingBatchState';
import { redriveCohortHold } from './projectHostedLandingCohortHold';
import { auditRow } from './projectHostedMainAuditState';
import { redriveCiDown } from './projectHostedLandingCiDown';
import { storedLandingStateSchema } from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';
import { report } from './errors';

/** Issue 72d50375: any write outage (OCC exhaustion, a
 * platform incident) makes a scheduled settlement step or stall alarm throw.
 * Convex does not retry it and the row keeps pointing at the failed task, so the
 * entry has no owner. Re-drive is event driven only: when an operator runs the
 * sweep after an outage, and when a waiting reader's entry stays Ready with no new
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
    /** Report the lost drivers without replaying them (the supervisor tick, 19328518). */
    probe?: boolean;
    /** One sweep transaction's main-red release check: one audit read and one release per project. */
    mainRed?: { green?: boolean; scheduled?: boolean };
    /** One sweep transaction's CI-down backstop: one queue read and one task per project. */
    ciDown?: { checked?: boolean };
  } = {},
) {
  const done: string[] = [];
  const act = !options.probe;
  const row = options.row ?? (await landingRow(ctx, input));
  if (!row) {
    const desired = await desiredLanding(ctx, input);
    if (!desired || storedLandingStateSchema.parse(JSON.parse(desired.value)).observation.state !== 'pending')
      return done;
    if (desired.wake && (await lost(ctx, desired.wake.taskId))) {
      if (act) await scheduleDesired(ctx, desired, 0);
      done.push('compose');
    }
    if (desired.alarm && (await lost(ctx, desired.alarm.taskId))) {
      if (act)
        await ctx.db.patch(desired._id, {
          alarm: await armLandingAlarm(ctx, input, desired.alarm.lastProgressAt),
        });
      done.push('alarm');
    }
    return done;
  }
  if (row.phase === 'landed' || row.phase === 'terminal-failed') return done;
  if (!options.probe && row.alarm && (await lost(ctx, row.alarm.taskId))) {
    const alarm = await armLandingAlarm(ctx, input, row.alarm.lastProgressAt);
    await ctx.db.patch(row._id, { alarm });
    done.push('alarm');
  }
  // Fix D backstop (Item 687d1eda): a parked entry has no alarm and no finish wake; only a
  // releaseHeld page moves it. When that page was lost (a failed task) and main is green, release
  // again. Held queued rows only: one audit-row read; every other row reads nothing more.
  if (row.phase === 'queued' && row.hold === 'main-red') {
    const memo = options.mainRed ?? {};
    memo.green ??= !(await auditRow(ctx, row.projectId))?.red;
    if (memo.green) {
      if (act && !memo.scheduled) {
        await ctx.scheduler.runAfter(
          0,
          makeFunctionReference<'mutation'>('projectHostedMainAudit:releaseHeld'),
          { projectId: row.projectId },
        );
        memo.scheduled = true;
      }
      done.push('main-red');
    }
  }
  // The CI-down hold's backstop (e62d834b line 5): a held row whose hold ended (its release page was
  // lost) is released again, and one whose hold has no armed probe gets one. Held rows only: one
  // queue-row read.
  if (row.phase === 'queued' && row.hold === 'ci-down') {
    const memo = options.ciDown ?? {};
    if (!memo.checked && (await redriveCiDown(ctx, row.projectId, act))) done.push('ci-down');
    memo.checked = true;
  }
  const finish = await finishRow(ctx, input);
  if (finish && row.phase === 'queued' && (await idleCohortLeader(ctx, row, finish))) {
    if (act) await scheduleFinish(ctx, finish, 0, true);
    done.push('cohort-finish');
  } else if (
    finish?.wake &&
    !(row.phase === 'queued' && row.orderWait) &&
    (await lost(ctx, finish.wake.taskId))
  ) {
    // Same generation: the lost step's IO fence stays valid and nothing is repeated twice.
    if (act) await scheduleFinish(ctx, finish, 0, true);
    done.push('finish');
  } else if (finish && row.phase === 'ready' && (await idleReady(ctx, row, finish))) {
    // 19328518 (88-minute landing, 2026-11-05): a passed head whose settlement
    // step ended without scheduling the next one has no driver at all. Only the
    // finish publishes it, and every later passed entry waits for it in order.
    if (act) await scheduleFinish(ctx, finish, 0, false, 'drive');
    done.push('finish-idle');
  } else if (finish?.waiting && finish.parentSubmissionId) {
    // The parent's terminal event (FinishDriver:dependents) was lost.
    const parent = await landingRow(ctx, {
      projectId: input.projectId,
      submissionId: finish.parentSubmissionId,
    });
    if (parent && (parent.phase === 'landed' || parent.phase === 'terminal-failed')) {
      if (act) {
        await ctx.db.patch(finish._id, { waiting: false });
        await scheduleFinish(ctx, { ...finish, waiting: false }, 0, false, 'drive');
      }
      done.push('dependency');
    }
  }
  if (act && row.phase === 'queued' && (await redriveCohortHold(ctx, row))) done.push('hold');
  if (row.phase === 'queued' || row.phase === 'checking') {
    if (!options.queueChecked && (await redriveQueue(ctx, input.projectId, act))) done.push('queue');
    if (row.phase === 'checking' && row.runId) {
      const wake = await checkWakeRow(ctx, {
        projectId: input.projectId,
        runId: row.runId,
      });
      if (wake?.wake && (await lost(ctx, wake.wake.taskId))) {
        if (act) await scheduleCheckWake(ctx, { projectId: input.projectId, runId: row.runId }, wake);
        done.push('check');
      }
    }
  }
  return done;
}
async function redriveQueue(ctx: MutationCtx, projectId: Id<'hostedProjects'>, act = true) {
  const queue = await landingQueue(ctx, { projectId, channel: 'main' });
  if (!queue?.wake || !(await lost(ctx, queue.wake.taskId))) return false;
  if (act) await scheduleLandingWake(ctx, queue, queue.wake.at);
  return true;
}
/** A Ready entry nothing drives: not parked behind an older entry (that one owns
 * it), not waiting for review or a parent, and its finish step neither pending
 * nor running. One scheduler-row read. */
async function idleReady(
  ctx: MutationCtx,
  row: Doc<'projectHostedLandingRequests'>,
  finish: Doc<'projectHostedFinishes'>,
) {
  if (row.orderWait || finish.waiting) return false;
  const reason = storedLandingStateSchema.parse(JSON.parse(row.value)).observation.pendingReason;
  if (reason === 'waiting-for-review' || reason === 'waiting-for-dependency') return false;
  const task = finish.wake ? await ctx.db.system.get(finish.wake.taskId) : null;
  return task?.state.kind !== 'pending' && task?.state.kind !== 'inProgress';
}

/** A composing leader that stopped without a successor is as ownerless as a Ready finish. */
async function idleCohortLeader(
  ctx: MutationCtx,
  row: Doc<'projectHostedLandingRequests'>,
  finish: Doc<'projectHostedFinishes'>,
) {
  if (row.orderWait || finish.waiting) return false;
  const state = storedLandingStateSchema.parse(JSON.parse(row.value));
  if (!state.batchId) return false;
  const { batch } = await loadBatch(ctx, { projectId: row.projectId, batchId: state.batchId });
  if (batch.phase !== 'composing' || (batch.leaderId ?? batch.id) !== row.submissionId) return false;
  const task = finish.wake ? await ctx.db.system.get(finish.wake.taskId) : null;
  return task?.state.kind !== 'pending' && task?.state.kind !== 'inProgress';
}

/** Holders followed per ask. Each hop is strictly older, so the walk ends. */
export const REDRIVE_ORDER_HOPS = 8;
/** Incident c329d191 class: a parked Ready entry waits for the older entry that
 * holds its order, and its reader only ever asks about itself. When the holder
 * lost its step and its stall alarm too, nothing owns the chain, and every
 * waiter behind it waits forever. The ask follows the order wait to each holder
 * and replays only their lost steps. Ask-only: healthy landings and the sweep
 * (which visits every live entry) add nothing. */
async function redriveHolders(ctx: MutationCtx, row: Doc<'projectHostedLandingRequests'> | null) {
  const holders: { submissionId: string; redriven: string[] }[] = [];
  const seen = new Set<string>();
  // The queue wake is read at most once per ask.
  let queueChecked = row?.phase === 'queued' || row?.phase === 'checking';
  for (let next = row?.orderWait; row && next && !seen.has(next) && seen.size < REDRIVE_ORDER_HOPS;) {
    seen.add(next);
    const holder = await landingRow(ctx, { projectId: row.projectId, submissionId: next });
    if (!holder) break;
    const redriven = await redriveLanding(ctx, holder, { row: holder, queueChecked });
    queueChecked ||= holder.phase === 'queued' || holder.phase === 'checking';
    if (redriven.length) holders.push({ submissionId: holder.submissionId, redriven });
    next = holder.orderWait;
  }
  return holders;
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
      const row = await landingRow(ctx, input);
      const redriven = await redriveLanding(ctx, input, row ? { row } : {});
      const holders = await redriveHolders(ctx, row);
      return canonicalPayload({ redriven, ...(holders.length ? { holders } : {}) });
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
      const mainRed = {},
        ciDown = {};
      for (const phase of ['ready', 'checking', 'queued'] as const) {
        const rows = await ctx.db
          .query('projectHostedLandingRequests')
          .withIndex('by_project_and_channel_and_phase_and_sequence', q =>
            q.eq('projectId', queue.projectId).eq('channel', 'main').eq('phase', phase),
          )
          .take(REDRIVE_SWEEP_ENTRIES);
        for (const row of rows) await redriveLanding(ctx, row, { row, queueChecked: true, mainRed, ciDown });
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
