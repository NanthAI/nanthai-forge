// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { z } from 'zod';
import { composeRow } from './projectHostedComposeStore';

/** Only the fields this wait reads; the full states are validated where they are written. */
const composeCandidate = z.looseObject({ candidateId: z.uuid() });
const settledLanding = z.looseObject({
  at: z.string(),
  timing: z.looseObject({ settledAt: z.string().optional() }).optional(),
  error: z.looseObject({ code: z.string() }).nullable().optional(),
});

export type PeerLanding = {
  operationId: string;
  phase: 'landed' | 'terminal-failed';
  /** terminal-failed only: "cancelled" for LANDING_CANCELLED, else "failed". */
  outcome?: 'failed' | 'cancelled';
  code?: string;
};

/**
 * The terminal outcome of an open peer Lane's latest landing, or null while it is not terminal (no
 * landing yet, queued, checking, ready) or the Lane moved on after it settled. No new field or write:
 * the same bounded reverse lookup as `liveLaneFinish` (newest compose selection of the Lane, its
 * compose row, then the newest landing request of that Candidate). At most 3 rows read, and the
 * subscription re-runs when any of them changes.
 *
 * `recordedAt` is the Lane's last record time (ms; the overlap row's presence stamp). A Lane
 * recorded after its landing settled (a fix saved, a sync) is working again, so the old failure
 * no longer ends a wait. With no stamp the landing counts.
 */
export async function peerLatestLanding(
  ctx: QueryCtx,
  input: { projectId: Id<'hostedProjects'>; laneId: string; recordedAt?: number },
): Promise<PeerLanding | null> {
  const [selection] = await ctx.db
    .query('projectHostedComposeSelections')
    .withIndex('by_project_and_kind_and_key', q =>
      q.eq('projectId', input.projectId).eq('kind', 'inputs').eq('key', input.laneId),
    )
    .order('desc')
    .take(1);
  if (!selection) return null;
  const compose = await composeRow(ctx, selection);
  if (!compose) return null;
  const { candidateId } = composeCandidate.parse(JSON.parse(compose.value));
  const [request] = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_candidate_and_sequence', q =>
      q.eq('projectId', input.projectId).eq('candidateId', candidateId),
    )
    .order('desc')
    .take(1);
  if (!request || (request.phase !== 'landed' && request.phase !== 'terminal-failed')) return null;
  const state = settledLanding.parse(JSON.parse(request.value));
  const settledAt = Date.parse(state.timing?.settledAt ?? state.at);
  if (input.recordedAt !== undefined && Number.isFinite(settledAt) && input.recordedAt > settledAt)
    return null;
  if (request.phase === 'landed') return { operationId: request.operationId, phase: 'landed' };
  return {
    operationId: request.operationId,
    phase: 'terminal-failed',
    outcome: state.error?.code === 'LANDING_CANCELLED' ? 'cancelled' : 'failed',
    ...(state.error?.code ? { code: state.error.code } : {}),
  };
}
