// SPDX-License-Identifier: Apache-2.0
import { latestLandingProgress, landingStall } from './landing-stall.js';
import type { HostedLandingState } from './hosted-landing.js';
export const hostedLandingProgressAt = (state: HostedLandingState) =>
  latestLandingProgress([state.at, ...Object.values(state.timing ?? {})]);
export function hostedLandingStall(state: HostedLandingState, now = Date.now()) {
  if (state.observation.state !== 'pending') return undefined;
  const step = state.observation.pendingReason === 'waiting-for-dependency' ? 'dependency' : state.phase;
  const owner =
    step === 'composing'
      ? 'source worker / desired landing controller'
      : step === 'checking'
        ? 'check runner / landing controller'
        : step === 'dependency'
          ? 'parent landing controller'
          : 'landing / finish controller';
  return landingStall(step, owner, hostedLandingProgressAt(state), now);
}
/** A stalled goal has one reconciliation wake per hour (three controller calls),
 * while source completion still wakes it immediately. Alarm owns its own deadline. */
export function desiredWatchdogMs(state: HostedLandingState, now = Date.now()) {
  const age = Math.max(0, now - Date.parse(hostedLandingProgressAt(state)));
  return Math.min(60 * 60_000, 30_000 * 2 ** Math.min(7, Math.floor(age / 60_000)));
}
