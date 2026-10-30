import { loadBatch, writeBatch } from './projectHostedLandingBatchStore';
import { advanceBatchFallback } from './projectHostedLandingBatchFallback';
import { wakeLandingQueue } from './projectHostedLandingWake';
import { finishRow, scheduleFinish } from './projectHostedFinishWake';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { LandingIdentity } from './projectHostedLandingStore';
import { landingRow, writeLanding } from './projectHostedLandingStore';
import { desiredLanding } from './projectHostedLandingDesiredWake';
import { hostedLandingStateSchema } from '../src/hosted-landing';
import { hostedLandingStall } from '../src/hosted-landing-stall';
import { canonicalPayload } from '../src/hosted-source-operation';
export const alarm = internalMutation({
  args: { projectId: v.id('hostedProjects'), submissionId: v.string(), lastProgressAt: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    return raiseLandingAlarm(ctx, input);
  },
});

export async function raiseLandingAlarm(
  ctx: MutationCtx,
  input: LandingIdentity & { lastProgressAt: string },
  now = Date.now(),
) {
  const canonical = await landingRow(ctx, input);
  const desired = canonical ? null : await desiredLanding(ctx, input);
  const row = canonical ?? desired;
  if (!row || row.alarm?.lastProgressAt !== input.lastProgressAt) return null;
  await ctx.db.patch(row._id, { alarm: null });
  const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
  const stall = hostedLandingStall(state, now);
  if (!stall || state.observation.stall?.lastProgressAt === stall.lastProgressAt) return null;
  const next = { ...state, version: state.version + 1, observation: { ...state.observation, stall } };
  if (canonical) {
    await writeLanding(ctx, canonical, next, canonical.runnable);
    if (state.phase === 'queued') {
      const batchId = state.batchId ?? state.batchOriginId;
      if (batchId) {
        const key = { projectId: input.projectId, batchId };
        const { batch: original } = await loadBatch(ctx, key);
        // A queued member has already exceeded the existing progress deadline.
        // An active batch must not retain it indefinitely while later work lands.
        const batch =
          original.phase === 'checking' || original.phase === 'composing'
            ? { ...original, phase: 'fallback' as const }
            : original;
        if (batch.phase === 'fallback' || batch.phase === 'landed') {
          // Repair and re-select in this alarm transaction, including legacy
          // members whose original batch leader has already stopped driving.
          await writeBatch(ctx, key, batch);
          await advanceBatchFallback(ctx, key, batch, state.id);
          const finish = await finishRow(ctx, input);
          if (finish) await scheduleFinish(ctx, finish);
        }
      } else if (state.observation.pendingReason !== 'waiting-for-dependency') {
        await ctx.db.patch(canonical._id, { runnable: true });
      }
      await wakeLandingQueue(ctx, { projectId: input.projectId, channel: 'main' });
    }
  } else await ctx.db.patch(row._id, { value: canonicalPayload(next) });
  return null;
}
