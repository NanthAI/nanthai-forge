// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { splitAgentActor } from '../src/agent-slug';
import { QUEUE_VIEW_LIMIT } from '../src/hosted-queue-view';
import { landingStateField } from '../src/landing-state';
import { landingRow, landingStateFromRow, type LandingRow } from './projectHostedLandingStore';
import type { ApprovalLink } from './projectHostedApprovalStore';
import { queueComposeLanes, queueIntentLanes, queueViewKeys } from './projectHostedQueueEntries';
import type { HostedLandingState } from '../src/hosted-landing';

/** Use observed execution, not a reservation. Both held-review paths already have the landing row. */
export function reviewCheckEvidence(row: LandingRow, state: HostedLandingState) {
  if (row.runId && (state.timing?.ciObservedAt || state.timing?.ciEndedAt))
    return { reviewCheck: 'ran' as const };
  return { reviewCheck: state.request.check ? ('pending' as const) : ('none' as const) };
}

export function reviewSubmitter(row: LandingRow, state: HostedLandingState) {
  const agentAuthored = state.request.authorship
    ? state.request.authorship.kind === 'agent'
    : Boolean(row.agentRun || row.agentClient || state.request.agent);
  return {
    actor: row.actor,
    agent: agentAuthored ? (row.agentRun ?? splitAgentActor(row.actor)?.agent ?? null) : null,
    ...(agentAuthored && row.agentClient ? { agentClient: row.agentClient } : {}),
    ...(agentAuthored ? { agentAuthored: true as const } : {}),
  };
}

/** Read only review entries in the queue's existing directory window. A Lane mark
 * may overlap, move to a newer head, or be absent while its submitted attempt still waits. */
export async function openLandingReviews(ctx: QueryCtx, projectId: Id<'hostedProjects'>, link: ApprovalLink) {
  const keys = (await queueViewKeys(ctx, projectId)).filter(key => key.held === 'review');
  const rows = await Promise.all(
    keys.slice(0, QUEUE_VIEW_LIMIT).map(async key => {
      const row = await landingRow(ctx, { projectId, submissionId: key.id }, false);
      if (!row) return null;
      const state = landingStateFromRow(row);
      if (landingStateField(state).state !== 'held-review') return null;
      const intentId = row.intentId ?? null;
      const composed = await queueComposeLanes(ctx, projectId, state);
      const byIntent = composed.length === 1 ? [] : await queueIntentLanes(ctx, projectId, intentId);
      const laneId = composed.length === 1 ? composed[0]!.key : (byIntent[0]?.key ?? null);
      // The link names a Lane only when exactly one is known; otherwise Needs me decides it (Item 0a99ab23).
      const exact =
        composed.length === 1 ? laneId : !composed.length && byIntent.length === 1 ? laneId : null;
      return {
        laneId,
        intentId,
        submissionId: state.id,
        attemptId: state.attemptId,
        ...reviewCheckEvidence(row, state),
        url: await link(exact, state.id),
        note: state.error?.message ?? null,
        since: Date.parse(state.timing?.ciEndedAt ?? state.timing?.selectedAt ?? state.at),
        ...reviewSubmitter(row, state),
      };
    }),
  );
  return { reviews: rows.filter(row => row !== null), reviewsComplete: keys.length <= QUEUE_VIEW_LIMIT };
}
