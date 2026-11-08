// SPDX-License-Identifier: Apache-2.0
/** A pending landing that no queue, controller or agent advances on its own: it waits for a
 * person (review/owner approval) or for a dependency to land. Incident 5c59940b: a passed
 * protected-path landing sat in phase "ready" for 75+ min while every read said "queued to
 * land" and the queue dropped it, so the builder cancelled it as stranded. */
export type LandingHold = {
  kind: 'review' | 'dependency';
  /** The server's stored reason, verbatim (it names the protected paths). */
  reason: string;
  /** Protected paths named by the reason; null when the reason names none. */
  paths: string[] | null;
  next: string;
};
type HoldInput = {
  id?: string;
  observation?: { state?: string; pendingReason?: string | null } | null;
  error?: { code?: string; message?: string } | null;
};
// Both policy wordings: "protected paths: a, b" (autonomy) and "protected paths a, b" (public governance).
const PATHS = /protected paths:? (.+?)\s*(?:;|$)/;

/** Derived from the submission already in hand: no read, no call. */
export function landingHold(state: HoldInput | null | undefined, laneId?: string): LandingHold | null {
  const reason = state?.observation?.state === 'pending' ? state.observation.pendingReason : undefined;
  if (reason === 'waiting-for-review') {
    const stored = state?.error?.message?.trim() || 'Waiting for review by a person';
    const named = PATHS.exec(stored)?.[1];
    const lane = `{"laneId":"${laneId ?? 'LANE_ID'}"}`;
    return {
      kind: 'review',
      reason: stored,
      paths: named
        ? named
            .split(', ')
            .map(path => path.trim())
            .filter(Boolean)
        : null,
      next: `Check passed; held until the project owner accepts ${state?.id ? `submission ${state.id}` : 'it'} as a person (agents cannot approve; it does not time out). Tell the owner; to drop it instead: nforge agent ROOT land --withdraw '${lane}'.`,
    };
  }
  if (reason === 'waiting-for-dependency')
    return {
      kind: 'dependency',
      reason: state?.error?.message?.trim() || 'Waiting for a dependency to land',
      paths: null,
      next: 'Lands after the Candidate it depends on; no action needed. Withdraw only if that dependency will not land.',
    };
  return null;
}

/** The two lines a waiting agent reads: what holds it (verbatim reason) and the next step. */
export const holdLines = (hold: LandingHold) => [
  `${hold.kind === 'review' ? 'WAITING FOR REVIEW' : 'WAITING FOR DEPENDENCY'}; not landed yet: ${hold.reason.replace(/\s+/g, ' ').slice(0, 900)}`,
  hold.next,
];
