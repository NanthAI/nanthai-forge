// SPDX-License-Identifier: Apache-2.0
/** A pending landing that no queue, controller or agent advances on its own: it waits for a
 * person (review/owner approval) or for a dependency to land. Incident 5c59940b: a passed
 * protected-path landing sat in phase "ready" for 75+ min while every read said "queued to
 * land" and the queue dropped it, so the builder cancelled it as stranded. */
export type LandingHold = {
  /** `main-red`: the gate parked a ready entry until main's full check is green (B2/B3). */
  kind: 'review' | 'dependency' | 'main-red';
  /** The server's stored reason, verbatim (it names the protected paths). */
  reason: string;
  /** Protected paths named by the reason; null when the reason names none. */
  paths: string[] | null;
  next: string;
};
type HoldInput = {
  id?: string;
  operationId?: string;
  observation?: { state?: string; pendingReason?: string | null } | null;
  error?: { code?: string; message?: string } | null;
};
// Both policy wordings: "protected paths: a, b" (autonomy) and "protected paths a, b" (public governance).
const PATHS = /protected paths:? (.+?)\s*(?:;|$)/;

/** Derived from the submission already in hand: no read, no call. */
export function landingHold(state: HoldInput | null | undefined, laneId?: string): LandingHold | null {
  const reason = state?.observation?.state === 'pending' ? state.observation.pendingReason : undefined;
  // Stored with a queued observation, so only the code says it is parked (inventory B3).
  if (state?.observation?.state === 'pending' && state.error?.code === 'MAIN_RED')
    return {
      kind: 'main-red',
      reason: state.error.message?.trim() || "Main's full check is red",
      paths: null,
      next: "Held while main's full check is red; it resumes by itself when main is green again (no queue position meanwhile). Nothing to do in this Lane: fixing main releases it. Keep waiting.",
    };
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
      next: `Check passed; held until the project owner accepts ${state?.id ? `submission ${state.id}` : 'it'} as a person (agents cannot approve; it does not time out). Hand the owner the link from nforge agent ROOT approve-link '{"operationId":"${state?.operationId ?? 'ORIGINAL_UUID'}"}' and keep waiting: this wait returns on their decision. To drop it instead: nforge agent ROOT land --withdraw '${lane}'.`,
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

const holdWords = {
  review: 'WAITING FOR REVIEW',
  dependency: 'WAITING FOR DEPENDENCY',
  'main-red': 'HELD: MAIN IS RED',
} as const satisfies Record<LandingHold['kind'], string>;
/** The two lines a waiting agent reads: what holds it (verbatim reason) and the next step. */
export const holdLines = (hold: LandingHold) => [
  `${holdWords[hold.kind]}; not landed yet: ${hold.reason.replace(/\s+/g, ' ').slice(0, 900)}`,
  hold.next,
];
