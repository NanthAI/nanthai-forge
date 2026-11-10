// SPDX-License-Identifier: Apache-2.0
// Pure: runs in the Convex non-Node runtime and in test fixtures.
import { digest } from './state/hash.js';

/** Lanes of one reverted receipt told per revert; a receipt usually carries one Lane, a cohort a few. */
export const REVERT_NOTICE_FANOUT = 20;

/** The command that brings a reverted Lane back at its saved head (kept on revert, never deleted). */
export const reopenCommand = (laneId: string) => `nforge agent ROOT start --reopen '{"laneId":"${laneId}"}'`;

/** The one-line board note the reverted Lane receives (Issue 8dbccdfb): what happened and the exact
 * next command, under the board's 240-character limit, no names or machine paths. */
export function revertNoticeText(input: { revertOf: string; receiptId: string; laneId: string }) {
  return `Reverted: your landing ${input.revertOf.slice(0, 8)} is off main (revert receipt ${input.receiptId.slice(0, 8)}). Saved head kept; reopen it to fix and re-land: ${reopenCommand(input.laneId)}`;
}

/** The Now/CLI notice summary for a revert that no main audit asked for (a person or agent ran it). */
export function revertNoticeSummary(input: { revertOf: string; receiptId: string }) {
  return `Reverted receipt ${input.revertOf} by receipt ${input.receiptId}: the change is off main. Its Lane keeps the saved head.`;
}

/** Board message id: derived from the revert and the Lane, so a replayed notice writes nothing new. */
export function revertNoticeId(receiptId: string, laneId: string) {
  const hex = digest(JSON.stringify(['revert-notice', receiptId, laneId])).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
