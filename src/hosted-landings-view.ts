// SPDX-License-Identifier: Apache-2.0
/** Landings read (Issue b78ca196): bounded evidence of accepted landings in a time window. */
export const LANDINGS_DEFAULT_LIMIT = 20;
export const LANDINGS_MAX_LIMIT = 30;
/** A page stops early once its rows plus their joined records read this many bytes (limit 1 MB of DB). */
export const LANDINGS_READ_BYTES = 800 * 1024;
/** A page stops early once its encoded rows reach this many bytes (limit 64 KB a page). */
export const LANDINGS_OUTPUT_BYTES = 56 * 1024;
/** Landing attempts read per landing; a longer chain keeps the true recompose count and flags the run id list as partial. */
export const LANDINGS_ATTEMPTS = 8;
/** Check run ids listed per landing. */
export const LANDINGS_RUN_IDS = 8;
