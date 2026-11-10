// SPDX-License-Identifier: Apache-2.0
import { readQueueStatus } from './projectHostedQueueStatus';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation } from './server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { LandingIdentity, LandingRow } from './projectHostedLandingStore';
import { landingRow, loadLanding, writeLanding } from './projectHostedLandingStore';
import { desiredLanding } from './projectHostedLandingDesiredWake';
import { hostedLandingStateSchema, type HostedLandingState } from '../src/hosted-landing';
import { hostedLandingProgressAt, hostedLandingStall } from '../src/hosted-landing-stall';
import { LANDING_DROP_MS, LANDING_STALL_MS } from '../src/landing-stall';
import { canonicalPayload } from '../src/hosted-source-operation';
import { scheduleStallAlert } from './projectHostedLandingStallAlert';
import { loadBatch, writeBatch } from './projectHostedLandingBatchStore';
import { advanceBatchFallback } from './projectHostedLandingBatchFallback';
import { splitLandingBatch } from './projectHostedLandingBatchSplit';
import { wakeLandingQueue } from './projectHostedLandingWake';
import { finishRow, scheduleFinish } from './projectHostedFinishWake';
import { cancelHostedLanding } from './projectHostedLandingCancel';
import { holdsLandingOrder } from './projectHostedLandingOrder';
import { reconcileUnacknowledgedCheck } from './projectHostedCheckReconcile';
import { redriveLanding } from './projectHostedLandingRedrive';
import { alertExhausted, exhaustLanding, exhaustedReason } from './projectHostedLandingExhaust';

type Stalled = LandingIdentity & { lastProgressAt: string };
const identity = { projectId: v.id('hostedProjects'), submissionId: v.string(), lastProgressAt: v.string() };
/** While a live owner keeps it waiting, the deadline re-arms at 2, 4, 8 and 16 h; at
 * the cap the supervisor ends the entry with a reason (19328518), unless a healthy
 * train is still moving the queue. */
export const LANDING_DROP_ATTEMPTS = 4;
/** Two consecutive supervisor rounds whose repair crashed, or whose replayed driver
 * failed again, prove a permanent fault (2026-10-30 14:20: the 15-minute retry
 * crashed the same way). A write outage cannot count: its own rounds cannot commit. */
export const LANDING_REPAIR_FAILURES = 2;
/** An ending transaction that itself crashes is retried this often, then the chain
 * stops; the cap alert has already gone out. */
export const LANDING_EXHAUST_RETRIES = 2;
const supervised = (phase: LandingRow['phase']) =>
  phase === 'queued' || phase === 'checking' || phase === 'ready';
/** Entries a supervisor round follows. A Ready entry counts only while a hosted
 * finish driver owns it; without one it waits for its requester (an explicit
 * person acceptance, H14), which is not a stall to end. */
async function supervises(ctx: MutationCtx, row: LandingRow) {
  if (row.phase !== 'ready') return supervised(row.phase);
  return Boolean(await finishRow(ctx, row));
}
const repairMode = v.union(v.literal('alarm'), v.literal('resolve'), v.literal('drop'), v.literal('exhaust'));
type RepairMode = 'alarm' | 'resolve' | 'drop' | 'exhaust';
type Round = Stalled & {
  attempt: number;
  repair?: Id<'_scheduled_functions'>;
  failures?: number;
  exhaust?: boolean;
  reason?: string;
};

export const alarm = internalMutation({
  args: identity,
  returns: v.null(),
  handler: async (ctx, input) => {
    return raiseLandingAlarm(ctx, input);
  },
});

export const deadline = internalMutation({
  args: {
    ...identity,
    attempt: v.number(),
    repair: v.optional(v.id('_scheduled_functions')),
    failures: v.optional(v.number()),
    exhaust: v.optional(v.boolean()),
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    return resolveStalledLanding(ctx, input);
  },
});

/** The supervisor's actions run apart from its bookkeeping: a repair that throws
 * fails only this task, and the next supervisor round sees it and escalates. */
export const repair = internalMutation({
  args: { ...identity, mode: repairMode, reason: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, input) => {
    await repairStalledLanding(ctx, input);
    return null;
  },
});

export async function raiseLandingAlarm(ctx: MutationCtx, input: Stalled, now = Date.now()) {
  const canonical = await landingRow(ctx, input);
  const desired = canonical ? null : await desiredLanding(ctx, input);
  const row = canonical ?? desired;
  if (!row || row.alarm?.lastProgressAt !== input.lastProgressAt) return null;
  await ctx.db.patch(row._id, { alarm: null });
  const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
  const queue = canonical && state.phase === 'queued' ? await readQueueStatus(ctx, state, now) : null;
  const stall = hostedLandingStall(state, now, queue);
  if (!stall && queue && state.observation.state === 'pending') {
    // Keep the existing orphan-recovery deadline even when a healthy train owns
    // the wait. No follower alarm, alert or controller redrive is warranted.
    await scheduleDeadline(
      ctx,
      canonical!._id,
      { ...input, attempt: 0 },
      Date.parse(input.lastProgressAt) + LANDING_DROP_MS,
    );
    return null;
  }
  if (!stall) return null;
  if (state.observation.stall?.lastProgressAt === stall.lastProgressAt)
    // The stall was raised already: this is a supervisor round restored after it
    // was lost (a redrive re-arms a failed one as this alarm). Continue the ladder.
    return canonical && (await supervises(ctx, canonical))
      ? resolveStalledLanding(ctx, { ...input, attempt: 0 }, now)
      : null;
  // A passed entry waiting for an older submission is not stalled: the older
  // one owns progress and its own alarm. If it no longer holds its place, re-drive.
  if (canonical?.orderWait && canonical.phase === 'ready' && (await aheadHoldsOrder(ctx, canonical)))
    return null;
  const token = { ...input, lastProgressAt: stall.lastProgressAt };
  // Only a Ready entry's repair replays settlement IO that can crash (2026-10-30
  // 14:20): it runs as its own task. Queued and checking repairs stay inline, as
  // before, so a batch waiting on slow CI costs one call per member.
  const inline = canonical?.phase !== 'ready';
  // Ready: schedule the repair only when a driver is lost (a read-only probe) or
  // an order waiter lost its place; a member waiting on its leader costs nothing.
  const repair =
    !inline &&
    (canonical!.orderWait || (await redriveLanding(ctx, input, { row: canonical!, probe: true })).length)
      ? await scheduleRepair(ctx, token, 'alarm')
      : undefined;
  const next = { ...state, version: state.version + 1, observation: { ...state.observation, stall } };
  const project = await ctx.db.get(input.projectId);
  if (project) await scheduleStallAlert(ctx, token, project);
  if (canonical) {
    await writeLanding(ctx, canonical, next, canonical.runnable);
    const redriven = inline ? await repairStalledLanding(ctx, { ...token, mode: 'alarm' }, now) : null;
    // A live check keeps its own run lease and execution watchdog: no round follows.
    // A replayed driver (lost check wake or queue step after the run ended) has no
    // such owner, so one round sees the replay take or ends the entry (d910db6b).
    if (canonical.phase === 'checking' && !redriven?.some(kind => kind !== 'alarm')) return null;
    // This alarm fires once per progress time. One retained supervisor round
    // follows its repair (Issue 108a24e3: an owner that stopped after the alarm
    // left two entries queued for 36 h; 19328518: a Ready head nobody drove).
    // A dependency wait has its parent's own outcome event instead.
    if (state.observation.pendingReason !== 'waiting-for-dependency' && (await supervises(ctx, canonical)))
      await scheduleDeadline(ctx, canonical._id, { ...token, attempt: 0, repair }, now + LANDING_STALL_MS);
  } else {
    await ctx.db.patch(row._id, { value: canonicalPayload(next) });
    await repairStalledLanding(ctx, { ...token, mode: 'alarm' }, now);
  }
  return null;
}

async function aheadHoldsOrder(ctx: MutationCtx, row: LandingRow) {
  const ahead = await landingRow(ctx, { projectId: row.projectId, submissionId: row.orderWait! });
  return Boolean(ahead && holdsLandingOrder(ahead, hostedLandingStateSchema.parse(JSON.parse(ahead.value))));
}

/** One supervisor action. `alarm`/`resolve` replay every lost driver (queue wake,
 * finish step, check callback, dispatch, compose, dependency event) and repair a
 * queued entry's ownership; `drop` may then end an ownerless queued entry (metric
 * 5.3); `exhaust` ends it with the supervisor's typed reason. */
export async function repairStalledLanding(
  ctx: MutationCtx,
  input: Stalled & { mode: RepairMode; reason?: string },
  now = Date.now(),
) {
  const canonical = await landingRow(ctx, input);
  if (!canonical) {
    if (input.mode === 'alarm') await redriveLanding(ctx, input);
    return null;
  }
  const state = hostedLandingStateSchema.parse(JSON.parse(canonical.value));
  if (
    !supervised(canonical.phase) ||
    state.observation.state !== 'pending' ||
    hostedLandingProgressAt(state) !== input.lastProgressAt
  )
    return null;
  if (input.mode === 'exhaust') {
    await exhaustLanding(ctx, state, input.reason ?? exhaustedReason('The landing supervisor gave up.'));
    return null;
  }
  // Incident a7de3a93: a checking entry whose dispatch no runner acknowledged
  // has no other owner for 12 h. Act on it, not only flag it (one read otherwise).
  if (canonical.phase === 'checking' && canonical.runId)
    await reconcileUnacknowledgedCheck(ctx, { projectId: input.projectId, runId: canonical.runId }, now);
  if (canonical.orderWait && canonical.phase === 'ready' && !(await aheadHoldsOrder(ctx, canonical))) {
    const finish = await finishRow(ctx, input);
    // The holder already ended; its old expiry timer must not suppress repair.
    if (finish) await scheduleFinish(ctx, finish, 0, true);
  }
  const redriven = await redriveLanding(ctx, input);
  if (canonical.phase !== 'queued') return redriven;
  const loaded = await loadLanding(ctx, input);
  if (input.mode === 'alarm') {
    if (loaded.state.phase === 'queued') await redriveQueued(ctx, input, loaded.row, loaded.state);
    return null;
  }
  return resolveQueued(ctx, input, loaded.row, loaded.state, input.mode === 'drop', now);
}

/** One supervisor round (pure bookkeeping: reads, schedules, one row patch): did
 * the last repair take? Escalate on a repeated failure, keep the dropped-landing
 * deadline and backoff otherwise, and end the entry at the cap. Retained on the
 * row as its alarm, so a lost round is restored like any lost step. No round
 * exists for an entry that progresses, settles or waits for review: idle is free. */
export async function resolveStalledLanding(ctx: MutationCtx, input: Round, now = Date.now()) {
  const row = await landingRow(ctx, input);
  if (!row) return null;
  const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
  if (!stalledSince(state, input.lastProgressAt) || !(await supervises(ctx, row))) return null;
  // Parked behind an older entry that still holds its place: that one owns
  // progress, and its exit re-arms this entry's alarm (c329d191).
  if (row.orderWait && row.phase === 'ready' && (await aheadHoldsOrder(ctx, row))) return null;
  const token = {
    projectId: input.projectId,
    submissionId: input.submissionId,
    lastProgressAt: input.lastProgressAt,
  };
  const task = input.repair ? await ctx.db.system.get(input.repair) : null;
  const crashed = task?.state.kind === 'failed';
  if (input.exhaust) {
    const failures = (input.failures ?? 0) + 1;
    if (!crashed || failures > LANDING_EXHAUST_RETRIES) return null;
    const repair = await scheduleRepair(ctx, token, 'exhaust', input.reason);
    await scheduleDeadline(ctx, row._id, { ...input, repair, failures }, now + LANDING_STALL_MS);
    return null;
  }
  // Read-only: which drivers are lost now (a failed task, or a finish step that
  // stopped without scheduling its next one). Lost again right after a repair
  // replayed it is a failure: a step that keeps stopping is a permanent fault.
  const found = await redriveLanding(ctx, input, { row, probe: true });
  const lost = [...new Set(found.map(kind => (kind === 'finish-idle' ? 'finish' : kind)))];
  const failing = crashed || (input.repair !== undefined && lost.length > 0);
  const failures = failing ? (input.failures ?? 0) + 1 : 0;
  if (failures >= LANDING_REPAIR_FAILURES)
    return endLanding(
      ctx,
      row._id,
      state,
      { ...input, failures: 0 },
      exhaustedReason(
        crashed
          ? `Forge's repair of this landing crashed ${failures} times in a row at ${row.phase}.`
          : `Forge re-drove the lost ${lost.join(', ')} step ${failures} times and it failed again each time.`,
      ),
      now,
    );
  if (crashed || lost.length) {
    const repair = await scheduleRepair(ctx, token, 'resolve');
    await scheduleDeadline(ctx, row._id, { ...input, repair, failures }, now + LANDING_STALL_MS);
    return null;
  }
  // A check keeps its own run lease and execution watchdog, which end a silent
  // run; the supervisor stays only while it is replaying lost drivers.
  if (row.phase === 'checking') return null;
  const queue = row.phase === 'queued' ? await readQueueStatus(ctx, state, now) : null;
  const dropAt = Date.parse(input.lastProgressAt) + LANDING_DROP_MS;
  if (now < dropAt) {
    // The repair took; hold the regular dropped-landing deadline.
    await scheduleDeadline(ctx, row._id, { ...token, attempt: input.attempt }, dropAt);
    return null;
  }
  // A live train already owns progress. Preserve its recovery deadline and
  // backoff, without redriving healthy controllers on every follower timer.
  const repair =
    row.phase !== 'queued' || !queue?.owner
      ? await scheduleRepair(ctx, token, row.phase === 'queued' ? 'drop' : 'resolve')
      : undefined;
  const next = { ...token, ...(repair ? { repair } : {}) };
  if (input.attempt < LANDING_DROP_ATTEMPTS) {
    await scheduleDeadline(
      ctx,
      row._id,
      { ...next, attempt: input.attempt + 1 },
      now + LANDING_DROP_MS * 2 ** (input.attempt + 1),
    );
    return null;
  }
  // A queued entry ends only through the drop repair (structurally ownerless);
  // work something still drives is never ended: a live check runner has its own
  // run watchdog, the controller lease its re-claim cap, and either exit
  // re-selects this entry. Leave no timer here, as before 19328518.
  if (row.phase === 'queued') return null;
  const hours = Math.round((now - Date.parse(input.lastProgressAt)) / 3_600_000);
  return endLanding(
    ctx,
    row._id,
    state,
    { ...token, attempt: input.attempt },
    exhaustedReason(
      `No landing progress for ${hours} h at ${row.phase} although its driver still looked live after every re-drive.`,
    ),
    now,
  );
}

/** Decide the end: the alert goes out now, the ending runs as its own repair, and
 * one more round retries the ending if it crashed. */
async function endLanding(
  ctx: MutationCtx,
  rowId: Id<'projectHostedLandingRequests'>,
  state: HostedLandingState,
  input: Round,
  reason: string,
  now: number,
) {
  await alertExhausted(ctx, state, reason, input.lastProgressAt);
  const token = {
    projectId: input.projectId,
    submissionId: input.submissionId,
    lastProgressAt: input.lastProgressAt,
  };
  const repair = await scheduleRepair(ctx, token, 'exhaust', reason);
  await scheduleDeadline(
    ctx,
    rowId,
    { ...token, attempt: input.attempt, repair, failures: 0, exhaust: true, reason },
    now + LANDING_STALL_MS,
  );
  return null;
}

async function scheduleRepair(ctx: MutationCtx, input: Stalled, mode: RepairMode, reason?: string) {
  return ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedLandingStall:repair'), {
    projectId: input.projectId,
    submissionId: input.submissionId,
    lastProgressAt: input.lastProgressAt,
    mode,
    ...(reason ? { reason } : {}),
  });
}

/** The next supervisor round, retained as the row's alarm for this progress
 * time: progress or settlement cancels it, and a redrive restores it if it failed. */
async function scheduleDeadline(
  ctx: MutationCtx,
  rowId: Id<'projectHostedLandingRequests'>,
  input: Round,
  at: number,
) {
  const row = await ctx.db.get(rowId);
  // Never cancel the round that is running now; only a still-pending older one.
  const old = row?.alarm ? await ctx.db.system.get(row.alarm.taskId) : null;
  if (old?.state.kind === 'pending') await ctx.scheduler.cancel(old._id);
  const taskId = await ctx.scheduler.runAfter(
    Math.max(0, at - Date.now()),
    makeFunctionReference<'mutation'>('projectHostedLandingStall:deadline'),
    input,
  );
  await ctx.db.patch(rowId, { alarm: { taskId, lastProgressAt: input.lastProgressAt } });
}

async function redriveQueued(
  ctx: MutationCtx,
  input: LandingIdentity,
  row: LandingRow,
  state: HostedLandingState,
) {
  const batchId = state.batchId ?? state.batchOriginId;
  if (batchId) {
    const key = { projectId: input.projectId, batchId };
    const { batch: original } = await loadBatch(ctx, key);
    // A queued member has already exceeded the existing progress deadline.
    // An active batch must not retain it indefinitely while later work lands.
    // A cohort stuck composing (2026-10-30: one merge step failed on every
    // retry) splits into halves that compose apart, in parallel; no test
    // failed, so nobody joins a serial single-check line.
    if (original.phase === 'composing') {
      await splitLandingBatch(ctx, key, original);
      await wakeLandingQueue(ctx, { projectId: input.projectId, channel: 'main' });
      return;
    }
    const batch =
      original.phase === 'checking'
        ? {
            ...original,
            phase: 'fallback' as const,
            transition: { code: 'LANDING_STALLED', message: 'The shared check stopped making progress.' },
          }
        : original;
    if (batch.phase === 'landed' && state.batchId && (!batch.included || batch.included.includes(state.id))) {
      batch.phase = 'fallback';
      batch.transition = {
        code: 'BATCH_MEMBER_ORPHANED',
        message: 'A nonterminal member outlived its settled cohort; restore its individual preparation.',
      };
    }
    if (batch.phase === 'fallback' || batch.phase === 'landed') {
      // Repair and re-select in this transaction, including legacy members
      // whose original batch leader has already stopped driving.
      await writeBatch(ctx, key, batch);
      await advanceBatchFallback(ctx, key, batch, state.id);
      const finish = await finishRow(ctx, input);
      if (finish) await scheduleFinish(ctx, finish);
    }
  } else if (state.observation.pendingReason !== 'waiting-for-dependency') {
    await ctx.db.patch(row._id, { runnable: true });
  }
  await wakeLandingQueue(ctx, { projectId: input.projectId, channel: 'main' });
}

const stalledSince = (state: HostedLandingState, lastProgressAt: string) =>
  state.observation.state === 'pending' &&
  state.observation.pendingReason !== 'waiting-for-review' &&
  state.observation.pendingReason !== 'waiting-for-dependency' &&
  hostedLandingProgressAt(state) === lastProgressAt;

/** Metric 5.3: no progress for 60 minutes. Re-drive the entry; if that makes no
 * progress and nothing live will drive it, end it with a stated outcome through
 * the cancellation path (peers re-selected, operation settled, queue released).
 * One read when progress happened since; at most 2 reads per batch member otherwise. */
async function resolveQueued(
  ctx: MutationCtx,
  input: Stalled,
  row: LandingRow,
  state: HostedLandingState,
  drop: boolean,
  now: number,
) {
  if (state.phase !== 'queued' || !stalledSince(state, input.lastProgressAt)) return null;
  const queue = await readQueueStatus(ctx, state, now);
  if (queue?.owner) return null;
  await redriveQueued(ctx, input, row, state);
  const after = await loadLanding(ctx, input);
  if (!drop || after.state.phase !== 'queued' || !stalledSince(after.state, input.lastProgressAt))
    return null;
  // Never end work something live still drives; its own path re-selects this entry.
  if (await liveOwner(ctx, input, after.row, after.state)) return null;
  const hours = Math.round((now - Date.parse(input.lastProgressAt)) / 3_600_000);
  await cancelHostedLanding(ctx, {
    projectId: input.projectId,
    actor: after.state.actor,
    drop: true,
    request: {
      operationId: crypto.randomUUID(),
      authorityEpoch: after.state.request.authorityEpoch,
      submissionId: after.state.id,
    },
    reason:
      `No landing progress for 60 minutes${hours > 1 ? ` (${hours} h)` : ''} while queued, and nothing ` +
      'is left to drive it after Forge re-drove it. Forge ended this landing instead of dropping it ' +
      'silently; nothing landed. Finish the same Lane again to retry.',
  });
  return null;
}

/** Who will still move this queued entry, or null: the queue (runnable), its own
 * pending attempt, an active batch, or a batch peer that holds the turn or a run.
 * Structural facts only, so clock skew cannot make a live peer look dead. */
async function liveOwner(
  ctx: MutationCtx,
  input: LandingIdentity,
  row: LandingRow,
  state: HostedLandingState,
) {
  if (row.runnable) return 'the landing queue';
  // A pending attempt (source preparation in flight) has the compose watchdog.
  if ((await finishRow(ctx, input))?.composeOperationId) return 'its own finish attempt';
  const batchId = state.batchId ?? state.batchOriginId;
  if (!batchId) return null;
  const { batch } = await loadBatch(ctx, { projectId: input.projectId, batchId });
  if (state.batchId === batch.id && ['composing', 'checking'].includes(batch.phase)) return 'the batch';
  if (state.batchId === batch.id && batch.phase !== 'fallback' && batch.phase !== 'landed') return null;
  for (const member of batch.members) {
    if (member.submissionId === state.id) continue;
    const peer = { projectId: input.projectId, submissionId: member.submissionId };
    const other = await landingRow(ctx, peer);
    if (!other || other.phase === 'landed' || other.phase === 'terminal-failed') continue;
    if (other.phase === 'checking' || other.phase === 'ready' || other.runnable) return 'a batch peer';
    const value = hostedLandingStateSchema.parse(JSON.parse(other.value));
    if (value.batchSolo && !value.batchNeedsSoloCompose) return 'a batch peer';
    if ((await finishRow(ctx, peer))?.composeOperationId) return 'a batch peer';
  }
  return null;
}
