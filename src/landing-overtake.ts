// SPDX-License-Identifier: Apache-2.0
import { pathsOverlap } from './hosted-cross-head-proof.js';
import { globalRiskBetween } from './first-check-risk.js';

/** The older live entry a passed (Ready) landing is about to wait for. */
export type OvertakeTarget = {
  phase: 'queued' | 'checking' | 'ready';
  priority?: 'urgent' | 'normal';
  attemptId: string;
  runId: string | null;
  /** Entered the queue after its own pre-queue Lane check (its Lane run can go stale). */
  admitted: boolean;
  /** `overtakeMark` of the generation a newer landing already overtook, if any. */
  overtaken?: string;
};

/** The check generation a newer landing makes stale by taking main first. */
export const overtakeMark = (target: Pick<OvertakeTarget, 'attemptId' | 'runId'>) =>
  `${target.attemptId}:${target.runId ?? ''}`;

/** Bounded overtaking (core-claim incident 7d98c7da, 2026-11-08). Strict submission
 * order (e4aee4fe) made every passed landing wait out an older entry's whole check,
 * related or not: with ~14 parallel builders, passed landings waited 17-40 min. A
 * passed landing now takes main ahead of an older live entry it is unrelated to
 * (`unrelatedChanges`, checked by the caller) once per check generation of that
 * entry: the older one lands on its stale pass through the first-check proof, or
 * re-checks at most once because of it, and from its next check on it holds strict
 * order again, so it cannot starve.
 *
 * - `hold`: wait as before (a Ready entry about to land, an urgent entry, or one
 *   that already gave up its place for an earlier generation);
 * - `free`: skip it at no cost to it (queued with no check of its own in flight,
 *   or this same generation was already overtaken);
 * - `spend`: skip it and record `overtakeMark(target)` on it.
 * Pure: no reads, so the claim transaction adds one patch per spent entry only. */
export function overtakeOlder(target: OvertakeTarget): 'hold' | 'free' | 'spend' {
  if (target.phase === 'ready' || target.priority === 'urgent') return 'hold';
  if (target.overtaken !== undefined) return target.overtaken === overtakeMark(target) ? 'free' : 'hold';
  if (target.phase === 'queued' && !target.admitted) return 'free';
  return 'spend';
}

/** Two changes are unrelated when neither's paths equal, contain or sit inside the
 * other's and together they touch no global-risk file (the first-check rule's own
 * tests, `clean-disjoint` without the Markdown allowance). Only an unrelated older
 * entry is overtaken: landing a related change first would make it re-check anyway
 * and gain nothing for the other waiters. Unknown paths are related. */
export function unrelatedChanges(
  mine: readonly string[] | null,
  theirs: readonly string[] | null,
  checkEntries: readonly string[],
) {
  return Boolean(
    mine?.length &&
    theirs?.length &&
    !pathsOverlap([...mine], [...theirs]) &&
    !globalRiskBetween(mine, theirs, checkEntries),
  );
}
