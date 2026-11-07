// SPDX-License-Identifier: Apache-2.0
import type { HostedQueueStatus } from './hosted-queue-status.js';
import { latestLandingProgress, landingStall } from './landing-stall.js';
import type { HostedLandingState } from './hosted-landing.js';
export const hostedLandingProgressAt = (state: HostedLandingState) =>
  latestLandingProgress([state.at, ...Object.values(state.timing ?? {})]);
export function hostedLandingStall(
  state: HostedLandingState,
  now = Date.now(),
  queue?: HostedQueueStatus | null,
) {
  if (state.observation.state !== 'pending') return undefined;
  if (state.phase === 'queued' && queue?.owner) return undefined;
  const progressAt =
    state.phase === 'queued' && queue
      ? latestLandingProgress([hostedLandingProgressAt(state), queue.lastProgressAt])
      : hostedLandingProgressAt(state);
  const step = state.observation.pendingReason === 'waiting-for-dependency' ? 'dependency' : state.phase;
  const owner =
    step === 'composing'
      ? 'source worker / desired landing controller'
      : step === 'checking'
        ? 'check runner / landing controller'
        : step === 'dependency'
          ? 'parent landing controller'
          : queue?.predecessor
            ? `predecessor ${queue.predecessor.id} (${queue.predecessor.phase}) / landing controller`
            : 'landing / finish controller';
  const stall = landingStall(step, owner, progressAt, now);
  // Retained deadlines use the entry's own progress token. Queue progress only
  // extends the alarm clock; it must not invalidate that token at publication.
  return stall && state.phase === 'queued' && queue
    ? { ...stall, lastProgressAt: hostedLandingProgressAt(state) }
    : stall;
}
/** A stalled goal has one reconciliation wake per hour (three controller calls),
 * while source completion still wakes it immediately. Alarm owns its own deadline. */
export function desiredWatchdogMs(state: HostedLandingState, now = Date.now()) {
  const age = Math.max(0, now - Date.parse(hostedLandingProgressAt(state)));
  return Math.min(60 * 60_000, 30_000 * 2 ** Math.min(7, Math.floor(age / 60_000)));
}
