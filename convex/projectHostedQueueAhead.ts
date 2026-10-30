import { activeLandingOrder, type LandingOrder } from './projectHostedLandingOrder';
import { landingRow } from './projectHostedLandingStore';
import { loadHostedCheck } from './projectHostedCheckStore';
// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { hostedStartMain } from './projectHostedChannels';
import { loadLandingAttempt } from './projectHostedLandingStore';
import { hostedLandingStateSchema, type HostedLandingState } from '../src/hosted-landing';
import { QUEUE_AHEAD_LIMIT } from '../src/queue-ahead-preview';
import { queueAheadSelectionSchema } from '../src/queue-ahead-hosted-schema';

/** Called only after current project authorization by the containing read. The
 * indexed ranges are reactive dependencies: terminal transitions retract a peer
 * transactionally, with no fan-out job, source in Convex, timer or idle work. */
async function selectQueueAhead(
  ctx: QueryCtx | MutationCtx,
  state: HostedLandingState,
  selected?: LandingOrder,
) {
  if (
    !['queued', 'checking', 'ready'].includes(state.phase) ||
    (state.phase !== 'queued' && state.sequence <= 1)
  )
    return null;
  const projectId = state.projectId as Id<'hostedProjects'>;
  const ordered = selected ?? (await activeLandingOrder(ctx, { projectId, channel: 'main' }));
  const position = ordered.findIndex(row => row.submissionId === state.id);
  const aheadKeys = position < 0 ? [] : ordered.slice(0, position);
  const rows = [];
  for (const key of aheadKeys.slice(0, QUEUE_AHEAD_LIMIT)) {
    const row = await landingRow(ctx, { projectId, submissionId: key.submissionId });
    if (row) rows.push(row);
  }
  if (!rows.length) return null;
  const mine = await loadLandingAttempt(ctx, { projectId, attemptId: state.attemptId });
  if (!mine.candidate.head) return null;
  const ahead = [];
  for (const row of rows.slice(0, QUEUE_AHEAD_LIMIT)) {
    const peer = hostedLandingStateSchema.parse(JSON.parse(row.value));
    const attempt = await loadLandingAttempt(ctx, { projectId, attemptId: peer.attemptId });
    if (!attempt.candidate.head) continue;
    const status =
      row.phase === 'queued' &&
      row.runId &&
      (await loadHostedCheck(ctx, { projectId, runId: row.runId })).run.status === 'passed'
        ? 'ready'
        : row.phase;
    ahead.push({ id: peer.id, head: attempt.candidate.head, inputs: attempt.candidate.inputs, status });
  }
  const main = await hostedStartMain(ctx, projectId);
  return queueAheadSelectionSchema.parse({
    main: main.head,
    mine: mine.candidate.head,
    ahead,
    more: aheadKeys.length > QUEUE_AHEAD_LIMIT,
  });
}

export async function hostedQueueAheadSelection(
  ctx: QueryCtx | MutationCtx,
  state: HostedLandingState,
  selected?: LandingOrder,
) {
  try {
    return await selectQueueAhead(ctx, state, selected);
  } catch {
    return { unavailable: true };
  }
}
