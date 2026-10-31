// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { LandingIdentity, LandingRow } from './projectHostedLandingStore';
import { landingRow, loadLanding, writeLanding } from './projectHostedLandingStore';
import { desiredLanding } from './projectHostedLandingDesiredWake';
import { hostedLandingStateSchema, type HostedLandingState } from '../src/hosted-landing';
import { hostedLandingProgressAt, hostedLandingStall } from '../src/hosted-landing-stall';
import { LANDING_DROP_MS } from '../src/landing-stall';
import { canonicalPayload } from '../src/hosted-source-operation';
import { scheduleStallAlert } from './projectHostedLandingStallAlert';
import { loadBatch, writeBatch } from './projectHostedLandingBatchStore';
import { advanceBatchFallback } from './projectHostedLandingBatchFallback';
import { splitLandingBatch } from './projectHostedLandingBatchSplit';
import { wakeLandingQueue } from './projectHostedLandingWake';
import { finishRow, scheduleFinish } from './projectHostedFinishWake';
import { cancelHostedLanding } from './projectHostedLandingCancel';

type Stalled = LandingIdentity & { lastProgressAt: string };
const identity = { projectId: v.id('hostedProjects'), submissionId: v.string(), lastProgressAt: v.string() };
/** While a live owner keeps it waiting, the deadline re-arms at 2, 4, 8 and 16 h, then stops. */
export const LANDING_DROP_ATTEMPTS = 4;

export const alarm = internalMutation({
  args: identity,
  returns: v.null(),
  handler: async (ctx, input) => {
    return raiseLandingAlarm(ctx, input);
  },
});

export const deadline = internalMutation({
  args: { ...identity, attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, input) => {
    return resolveStalledLanding(ctx, input);
  },
});

export async function raiseLandingAlarm(ctx: MutationCtx, input: Stalled, now = Date.now()) {
  const canonical = await landingRow(ctx, input);
  const desired = canonical ? null : await desiredLanding(ctx, input);
  const row = canonical ?? desired;
  if (!row || row.alarm?.lastProgressAt !== input.lastProgressAt) return null;
  await ctx.db.patch(row._id, { alarm: null });
  const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
  const stall = hostedLandingStall(state, now);
  if (!stall || state.observation.stall?.lastProgressAt === stall.lastProgressAt) return null;
  const next = { ...state, version: state.version + 1, observation: { ...state.observation, stall } };
  const project = await ctx.db.get(input.projectId);
  if (project) await scheduleStallAlert(ctx, { ...input, lastProgressAt: stall.lastProgressAt }, project);
  if (canonical) {
    await writeLanding(ctx, canonical, next, canonical.runnable);
    // This alarm fires once per progress time. One later deadline makes sure the
    // entry is re-driven or ends (Issue 108a24e3: an owner that stopped after
    // the alarm left two entries queued for 36 h). Only queued entries can lose
    // every owner: checking ones keep the run lease watchdog, desired goals their own.
    if (state.phase === 'queued' && state.observation.pendingReason !== 'waiting-for-dependency')
      await scheduleDropDeadline(
        ctx,
        { ...input, lastProgressAt: stall.lastProgressAt },
        0,
        Date.parse(stall.lastProgressAt) + LANDING_DROP_MS,
      );
    if (state.phase === 'queued') await redriveQueued(ctx, input, canonical, state);
  } else await ctx.db.patch(row._id, { value: canonicalPayload(next) });
  return null;
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
    const batch = original.phase === 'checking' ? { ...original, phase: 'fallback' as const } : original;
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

async function scheduleDropDeadline(ctx: MutationCtx, input: Stalled, attempt: number, at: number) {
  await ctx.scheduler.runAfter(
    Math.max(0, at - Date.now()),
    makeFunctionReference<'mutation'>('projectHostedLandingStall:deadline'),
    { ...input, attempt },
  );
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
export async function resolveStalledLanding(
  ctx: MutationCtx,
  input: Stalled & { attempt: number },
  now = Date.now(),
) {
  const row = await landingRow(ctx, input);
  if (!row) return null;
  const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
  if (state.phase !== 'queued' || !stalledSince(state, input.lastProgressAt)) return null;
  await redriveQueued(ctx, input, row, state);
  const after = await loadLanding(ctx, input);
  if (after.state.phase !== 'queued' || !stalledSince(after.state, input.lastProgressAt)) return null;
  const owner = await liveOwner(ctx, input, after.row, after.state);
  if (owner) {
    // Never end work something live still drives; its own path re-selects this entry.
    if (input.attempt < LANDING_DROP_ATTEMPTS)
      await scheduleDropDeadline(
        ctx,
        input,
        input.attempt + 1,
        now + LANDING_DROP_MS * 2 ** (input.attempt + 1),
      );
    return null;
  }
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
