// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import { discardedRunnerSeconds } from './cost-budgets.js';
import type { HostedLandingAttempt, HostedLandingState } from './hosted-landing.js';

/** Distinct Candidates after the first, plus at most one recompose per unread attempt. */
export function landingRecomposeCount(attempts: HostedLandingAttempt[], lastNumber: number | undefined) {
  const lastRead = attempts.at(-1);
  if (!lastRead || lastNumber === undefined) return null;
  const candidates = new Set(attempts.map(attempt => attempt.candidate?.id ?? `n${attempt.number}`));
  return candidates.size - 1 + Math.max(0, lastNumber - lastRead.number);
}

/** The builder's own pre-submission measurement hold. Older submissions remain unknown. */
export function landingClientHoldSeconds(state: HostedLandingState | null) {
  const heldMs = state?.timing?.heldMs;
  return heldMs === undefined ? null : heldMs / 1000;
}

/** Counts already carried by the landing row. Missing stamps stay unknown, including on old servers. */
export const landingCostsSchema = z.object({
  attempts: z.number().nonnegative().nullable(),
  writes: z.number().nonnegative().nullable(),
  r2ClassA: z.number().nonnegative().nullable(),
  r2ClassB: z.number().nonnegative().nullable(),
  r2BytesPut: z.number().nonnegative().nullable(),
  runnerAccepted: z.number().nonnegative().nullable(),
  runnerDiscarded: z.number().nonnegative().nullable(),
  runnerDiscardedPending: z.literal(true).optional(),
  /** The accepted run's minutes when it was a full check; absent when scoped or unknown (Issue a217b83e). */
  runnerFull: z.number().nonnegative().optional(),
  /** Check runs the landing threw away: runs bound to its record minus the accepted one (Item 1018d0f8). Absent: unknown. */
  discardedRuns: z.number().int().nonnegative().optional(),
});
/** Same units as the ledger: runner seconds become minutes. No source or run lookup. */
export function landingCosts(
  state: HostedLandingState | null,
  attempt: number | undefined,
  pending = 0,
  discardedRuns: number | null = null,
) {
  const discarded = pending > 0 ? null : discardedRunnerSeconds(state);
  return {
    attempts: attempt === undefined ? null : attempt + 1,
    writes: Number.isSafeInteger(state?.version) ? state!.version + 1 : null,
    r2ClassA: state?.counts?.r2?.[0] ?? null,
    r2ClassB: state?.counts?.r2?.[1] ?? null,
    r2BytesPut: state?.counts?.r2?.[2] ?? null,
    runnerAccepted: state?.counts?.runnerSeconds === undefined ? null : state.counts.runnerSeconds / 60,
    runnerDiscarded: discarded === null ? null : discarded / 60,
    ...(pending > 0 ? { runnerDiscardedPending: true as const } : {}),
    ...(state?.counts?.runnerFull && state.counts.runnerSeconds !== undefined
      ? { runnerFull: state.counts.runnerSeconds / 60 }
      : {}),
    ...(discardedRuns === null ? {} : { discardedRuns }),
  };
}

/** Landings read (Issue b78ca196): bounded evidence of accepted landings in a time window. */
export const LANDINGS_DEFAULT_LIMIT = 20;
export const LANDINGS_MAX_LIMIT = 30;
/** A page stops early once its rows plus their joined records read this many bytes (limit 1 MB of DB). */
export const LANDINGS_READ_BYTES = 800 * 1024;
/** A page stops early once its encoded rows reach this many bytes (limit 64 KB a page). */
export const LANDINGS_OUTPUT_BYTES = 56 * 1024;
/** Landing attempts read per landing; a longer chain counts at most one recompose per unread attempt and flags the run id list as partial. */
export const LANDINGS_ATTEMPTS = 8;
/** A passed check that waited this long before its attempt settled is listed in `heldAfterCheck`. */
export const LANDINGS_HELD_MS = 60_000;
/** Stored reason text kept per held attempt. */
export const LANDINGS_REASON_CHARS = 400;
/** Check run ids listed per landing. */
export const LANDINGS_RUN_IDS = 8;
