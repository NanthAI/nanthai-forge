// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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

/** What the project's `needsFix` entry for a revert somebody ran also says about it, beside the agent-facing summary
 * and undo (which stay as they are): which Lane, who took it out, who owns the Lane, and who has dealt with it. The web
 * words the card from these fields, never from the summary. Absent on an entry from a main audit or an older revert. */
export type TakenOut = { laneId: string; title: string | null; by: string; agent: string | null; at: number };
export type TakenEntry = TakenOut & { owner: string | null; left: string[]; back: boolean };

export function takenOutOf(fix: Record<string, unknown>): TakenEntry | null {
  const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
  const laneId = text(fix.lane);
  const by = text(fix.by);
  const at = typeof fix.at === 'string' ? Date.parse(fix.at) : NaN;
  if (!laneId || !by || !Number.isFinite(at)) return null;
  return {
    laneId,
    title: text(fix.title),
    by,
    agent: text(fix.agent),
    at,
    owner: text(fix.owner),
    left: Array.isArray(fix.left)
      ? fix.left.filter((value): value is string => typeof value === 'string')
      : [],
    back: fix.back === true,
  };
}

/** Who has left a revert's notice alone; the newest few, so the entry stays small. */
export const REVERT_NOTICE_LEFT = 20;
