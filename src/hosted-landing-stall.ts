// SPDX-License-Identifier: Apache-2.0
import type { HostedQueueStatus } from './hosted-queue-status.js';
import { latestLandingProgress, landingStall } from './landing-stall.js';
import type { HostedLandingState } from './hosted-landing.js';
export const hostedLandingProgressAt = (state: HostedLandingState) =>
  latestLandingProgress([
    state.at,
    ...Object.values(state.timing ?? {}).filter((value): value is string => typeof value === 'string'),
  ]);
export function hostedLandingStall(
  state: HostedLandingState,
  now = Date.now(),
  queue?: HostedQueueStatus | null,
) {
  if (state.observation.state !== 'pending') return undefined;
  const waiting = state.phase === 'queued' && queue?.predecessor && queue.owner;
  if (waiting) return undefined;
  const progressAt = hostedLandingProgressAt(state);
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
  return landingStall(step, owner, progressAt, now);
}
/** The predecessor a queued stall names as its missing owner (above), or undefined. Queue invariant
 * S12: such a follower is stuck because the predecessor is, so the predecessor alone alerts. */
export const stallPredecessor = (stall: HostedLandingState['observation']['stall']) =>
  /^predecessor (\S+) \(/.exec(stall?.missingOwner ?? '')?.[1];
/** Incident 8c9b84fc: a cohort repair's owner outlives its stall, in later observations and the
 * terminal receipt. A solo owner (Item 9a04d916) describes only the current stall: it goes with
 * that stall once progress resumes, exactly like an owner-less stall. */
export const COHORT_STALL_OWNER = 'cohort finish controller';
type Stall = HostedLandingState['observation']['stall'];
export const retainedStallOwner = (
  stall: Stall,
): stall is NonNullable<Stall> & { owner: NonNullable<NonNullable<Stall>['owner']> } =>
  Boolean(stall?.owner && stall.missingOwner === COHORT_STALL_OWNER);
/** A stalled goal has one reconciliation wake per hour (three controller calls),
 * while source completion still wakes it immediately. Alarm owns its own deadline. */
export function desiredWatchdogMs(state: HostedLandingState, now = Date.now()) {
  const age = Math.max(0, now - Date.parse(hostedLandingProgressAt(state)));
  return Math.min(60 * 60_000, 30_000 * 2 ** Math.min(7, Math.floor(age / 60_000)));
}
