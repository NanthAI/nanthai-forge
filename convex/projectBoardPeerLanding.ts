// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { z } from 'zod';
import { composeRow } from './projectHostedComposeStore';
import { landingRequestOriginalDb } from './projectLandingRequestBody';

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
  const compose = await latestLaneCompose(ctx, input);
  if (!compose) return null;
  const { candidateId } = composeCandidate.parse(JSON.parse(compose.value));
  const [request] = await latestCandidateLanding(ctx, input.projectId, candidateId);
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

async function latestLaneCompose(ctx: QueryCtx, input: { projectId: Id<'hostedProjects'>; laneId: string }) {
  const [selection] = await ctx.db
    .query('projectHostedComposeSelections')
    .withIndex('by_project_and_kind_and_key', q =>
      q.eq('projectId', input.projectId).eq('kind', 'inputs').eq('key', input.laneId),
    )
    .order('desc')
    .take(1);
  return selection ? composeRow(ctx, selection) : null;
}

function latestCandidateLanding(ctx: QueryCtx, projectId: Id<'hostedProjects'>, candidateId: string) {
  return landingRequestOriginalDb(ctx.db)
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_candidate_and_sequence', q =>
      q.eq('projectId', projectId).eq('candidateId', candidateId),
    )
    .order('desc')
    .take(1);
}

const recoveryCompose = composeCandidate.extend({
  request: z.object({ expectedMain: z.object({ receiptId: z.string() }) }),
  conflictSummary: z.object({ paths: z.array(z.string()), more: z.number() }).optional(),
});

/** A save can fix source without moving its base. A sync past a failed compose
 * clears the recovery. At most three indexed reads, plus one receipt lookup on
 * a failure whose compose used a different base. */
export async function lanePreflightRecovery(
  ctx: QueryCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    laneId: string;
    baseReceiptId: string;
    baseSequence: number | null;
  },
) {
  const compose = await latestLaneCompose(ctx, input);
  if (!compose) return;
  const parsed = recoveryCompose.safeParse(JSON.parse(compose.value));
  if (!parsed.success) return;
  const { candidateId, request, conflictSummary } = parsed.data;
  const [landing] = await latestCandidateLanding(ctx, input.projectId, candidateId);
  const error = landing
    ? landing.phase === 'terminal-failed'
      ? settledLanding.parse(JSON.parse(landing.value)).error?.code
      : undefined
    : conflictSummary
      ? 'COMPOSITION_CONFLICT'
      : undefined;
  if (error !== 'CHECK_FAILED' && error !== 'COMPOSITION_CONFLICT') return;
  const receiptId = request.expectedMain.receiptId;
  if (receiptId === input.baseReceiptId) return error;
  if (input.baseSequence === null) return;
  const failedBase = await ctx.db
    .query('projectHostedAcceptances')
    .withIndex('by_project_and_receipt', q => q.eq('projectId', input.projectId).eq('receiptId', receiptId))
    .unique();
  if (failedBase && input.baseSequence <= failedBase.sequence) return error;
}
