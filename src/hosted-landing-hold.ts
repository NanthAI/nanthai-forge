// SPDX-License-Identifier: Apache-2.0
import { reviewHoldLine } from './receipt-slim.js';
/** A pending landing that no queue, controller or agent advances on its own: it waits for a
 * person (review/owner approval) or for a dependency to land. Incident 5c59940b: a passed
 * protected-path landing sat in phase "ready" for 75+ min while every read said "queued to
 * land" and the queue dropped it, so the builder cancelled it as stranded. */
export type LandingReview = { approver?: string | undefined; url?: string | undefined };
export type LandingHold = {
  /** `main-red`: the gate parked a ready entry until main's full check is green (B2/B3).
   * `ci-down`: CI ended every recent check on one infrastructure cause (e62d834b line 5). */
  kind: 'review' | 'dependency' | 'main-red' | 'ci-down';
  /** The server's stored reason, verbatim (it names the protected paths). */
  reason: string;
  /** Protected paths named by the reason; null when the reason names none. */
  paths: string[] | null;
  next: string;
  review?: LandingReview;
};
type HoldInput = LandingReview & {
  id?: string;
  operationId?: string;
  phase?: string | null;
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
  if (state?.observation?.state === 'pending' && state.error?.code === 'CI_DOWN')
    return {
      kind: 'ci-down',
      reason: state.error.message?.trim() || 'CI is failing for every check',
      paths: null,
      next: 'Held while CI is failing for every check; one held landing checks again on a backoff, and the first check CI runs again releases the rest (no queue position meanwhile). Nothing to do in this Lane. Keep waiting.',
    };
  if (reason === 'waiting-for-review') {
    const stored = state?.error?.message?.trim() || 'Waiting for review by a person';
    const named = PATHS.exec(stored)?.[1];
    const review = state?.approver || state?.url ? { approver: state.approver, url: state.url } : undefined;
    const lane = `{"laneId":"${laneId ?? 'LANE_ID'}"}`;
    return {
      kind: 'review',
      ...(review ? { review } : {}),
      reason: stored,
      paths: named
        ? named
            .split(', ')
            .map(path => path.trim())
            .filter(Boolean)
        : null,
      next: review?.url
        ? `Hand the approval link to the owner and keep waiting for their decision. To withdraw: nforge agent ROOT land --withdraw '${lane}'.`
        : `${state?.phase === 'checking' ? 'Check in progress' : 'Check passed'}; held until the project owner approves ${state?.id ? `submission ${state.id}` : 'it'} as a person (agents cannot approve; it does not time out). Hand the owner the link from nforge agent ROOT approve-link '{"operationId":"${state?.operationId ?? 'ORIGINAL_UUID'}"}' and keep waiting: this wait returns on their decision. To drop it instead: nforge agent ROOT land --withdraw '${lane}'.`,
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
  'ci-down': 'HELD: CI IS DOWN',
} as const satisfies Record<LandingHold['kind'], string>;
/** What holds the landing (verbatim reason), the available approval details, and the next step. */
export const holdLines = (hold: LandingHold) => [
  hold.kind === 'review' && hold.review
    ? reviewHoldLine(hold.review)
    : `${holdWords[hold.kind]}; not landed yet: ${hold.reason.replace(/\s+/g, ' ').slice(0, 900)}`,
  ...(hold.kind === 'review' && hold.review ? [hold.reason.replace(/\s+/g, ' ').slice(0, 900)] : []),
  hold.next,
];
