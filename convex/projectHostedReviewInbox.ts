// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { splitAgentActor } from '../src/agent-slug';
import { QUEUE_VIEW_LIMIT } from '../src/hosted-queue-view';
import { landingStateField } from '../src/landing-state';
import { landingRow, landingStateFromRow, type LandingRow } from './projectHostedLandingStore';
import { approvePath, approveUrl } from './projectHostedOwnerReview';
import { queueComposeLanes, queueIntentLanes, queueViewKeys } from './projectHostedQueueEntries';
import type { HostedLandingState } from '../src/hosted-landing';

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
export async function openLandingReviews(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  const keys = (await queueViewKeys(ctx, projectId)).filter(key => key.held === 'review');
  const rows = await Promise.all(
    keys.slice(0, QUEUE_VIEW_LIMIT).map(async key => {
      const row = await landingRow(ctx, { projectId, submissionId: key.id }, false);
      if (!row) return null;
      const state = landingStateFromRow(row);
      if (landingStateField(state).state !== 'held-review') return null;
      const intentId = row.intentId ?? null;
      const composed = await queueComposeLanes(ctx, projectId, state);
      const laneId =
        composed.length === 1
          ? composed[0]!.key
          : ((await queueIntentLanes(ctx, projectId, intentId))[0]?.key ?? null);
      return {
        laneId,
        intentId,
        submissionId: state.id,
        attemptId: state.attemptId,
        url: approveUrl(projectId, state.id) ?? approvePath(projectId, state.id),
        note: state.error?.message ?? null,
        since: Date.parse(state.timing?.ciEndedAt ?? state.timing?.selectedAt ?? state.at),
        ...reviewSubmitter(row, state),
      };
    }),
  );
  return { reviews: rows.filter(row => row !== null), reviewsComplete: keys.length <= QUEUE_VIEW_LIMIT };
}
