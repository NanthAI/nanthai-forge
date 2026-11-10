// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { HostedLandingState } from './hosted-landing.js';

/** Counts already carried by the landing row. Missing stamps stay unknown, including on old servers. */
export const landingCostsSchema = z.object({
  attempts: z.number().nonnegative().nullable(),
  writes: z.number().nonnegative().nullable(),
  r2ClassA: z.number().nonnegative().nullable(),
  r2ClassB: z.number().nonnegative().nullable(),
  r2BytesPut: z.number().nonnegative().nullable(),
  runnerAccepted: z.number().nonnegative().nullable(),
  runnerDiscarded: z.number().nonnegative().nullable(),
});
/** Same units as the ledger: runner seconds become minutes. No source or run lookup. */
export function landingCosts(state: HostedLandingState | null, attempt: number | undefined) {
  return {
    attempts: attempt === undefined ? null : attempt + 1,
    writes: Number.isSafeInteger(state?.version) ? state!.version + 1 : null,
    r2ClassA: state?.counts?.r2?.[0] ?? null,
    r2ClassB: state?.counts?.r2?.[1] ?? null,
    r2BytesPut: state?.counts?.r2?.[2] ?? null,
    runnerAccepted: state?.counts?.runnerSeconds === undefined ? null : state.counts.runnerSeconds / 60,
    runnerDiscarded:
      state?.counts?.runnerSeconds === undefined ? null : (state.counts.discardedRunnerSeconds ?? 0) / 60,
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
