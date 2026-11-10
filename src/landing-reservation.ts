// SPDX-License-Identifier: Apache-2.0
import { pathsOverlap } from './hosted-cross-head-proof.js';

/** Landing reservation (core-claim incident 10d253c6, 2026-11-10). A 130-path Lane took 10 land
 * operations and about 2.5 h: its pre-queue check holds no queue order, so while it ran, small
 * Lanes landed into the same hot files, and its passed check then failed COMPOSITION_CONFLICT at
 * acceptance. After one such supersession the Intent's next submission reserves the files it
 * changes: a landing that changes any of them waits (at most until the reservation ends) instead
 * of taking main first, so the reserved change publishes on its passed check. Bounded: the
 * reservation ends when its landing lands or fails, or at `until`, whichever is first; nothing
 * extends it. The landing-queue model checks no starvation, no deadlock and expiry
 * (models/landing-queue, `reserve*.cfg`). */
export const HOSTED_RESERVATION_AFTER = 1;
/** Covers one full check (about 10-22 min on dogfood) plus acceptance. */
export const HOSTED_RESERVATION_MS = 30 * 60_000;

/** What the previous landing of the same Intent left behind (row fields already loaded). */
export type PriorLanding = {
  phase: string;
  errorCode: string | null;
  /** Its own check passed: an admission (pre-queue) pass or an ended run before the conflict. */
  checkPassed: boolean;
  /** Supersessions in a row that ended with that landing (0 when absent). */
  superseded?: number;
};

/** Superseded after a passed check: the check passed, then composing onto a moved main conflicted. */
export const supersededAfterPass = (prior: PriorLanding) =>
  prior.phase === 'terminal-failed' && prior.errorCode === 'COMPOSITION_CONFLICT' && prior.checkPassed;

/** The supersession count a new submission carries, and the reservation end it is granted. */
export function landingReservation(prior: PriorLanding | null, now: number) {
  const superseded = prior && supersededAfterPass(prior) ? (prior.superseded ?? 0) + 1 : 0;
  return {
    superseded,
    until: superseded >= HOSTED_RESERVATION_AFTER ? now + HOSTED_RESERVATION_MS : null,
  };
}

/** A live reservation of another landing that a landing must wait for: granted earlier than the
 * waiter's own (a holder never waits for a later one, so holders cannot wait in a cycle), not yet
 * ended, and on files the waiter changes. Unknown paths never prove independence. Urgent owner
 * landings and members of the holder's own group never wait. */
export function reservationHolds(
  holder: { until: number; grantedAt: number; paths: string[] | null; batchId?: string | undefined },
  waiter: {
    paths: string[] | null;
    priority?: string | undefined;
    reservedAt?: number | undefined;
    batchId?: string | undefined;
  },
  now: number,
) {
  if (holder.until <= now || waiter.priority === 'urgent') return false;
  if (holder.batchId && holder.batchId === waiter.batchId) return false;
  if (waiter.reservedAt !== undefined && waiter.reservedAt <= holder.grantedAt) return false;
  return !holder.paths || !waiter.paths || pathsOverlap(holder.paths, waiter.paths);
}
