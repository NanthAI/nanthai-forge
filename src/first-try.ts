// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Forge's one "first try" (owner 2026-11-19, Item a61d3c91): a change landed with no resubmission and no discarded
 * check. Stats (convex/projectStats.ts#statsLanding) and metrics 5.1 (src/self-metrics.ts) both use it.
 * - Resubmission: an earlier submission of the same Intent ended without landing (failed, cancelled, interrupted or
 *   replaced by a new save) before this one, or this one supersedes another.
 * - Discarded check: a check of this change ran and was thrown away (main moved and Forge rechecked, or a recheck
 *   replaced it). A batch join, or a recompose before any check ran, discards nothing.
 * Returns the attempt count Stats stores: 1 for a first try, 2 for anything else, null when unknown. */
export function firstTry(input: { resubmitted: boolean; discardedCheck: boolean; known: boolean }) {
  if (input.resubmitted || input.discardedCheck) return 2;
  return input.known ? 1 : null;
}

/** Metrics 5.1 path names that count as a first try under that rule: a main race resolved by adopting the passing
 * run discarded nothing, and a recompose after main moved counts only when it threw a started check away
 * (src/self-metrics.ts#pathFor names that 'after-recompose'). */
export const FIRST_TRY_PATHS = new Set(['first-try', 'reused-after-race']);
