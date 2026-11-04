import { invariant } from '../src/errors';
import {
  finishReadAttempt,
  finishReadCheck,
  finishReadMain,
  finishReadPeer,
  finishReadAheadQueue,
} from './projectFinishReadPins';
import type { LandingOrder } from './projectHostedLandingOrder';
// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { type HostedLandingState } from '../src/hosted-landing';
import { QUEUE_AHEAD_LIMIT } from '../src/queue-ahead-preview';
import { queueAheadSelectionSchema } from '../src/queue-ahead-hosted-schema';

/** Called only after current project authorization by the containing read. The
 * indexed ranges are reactive dependencies: terminal transitions retract a peer
 * transactionally, with no fan-out job, source in Convex, timer or idle work. */
async function selectQueueAhead(
  ctx: QueryCtx | MutationCtx,
  state: HostedLandingState,
  selected?: LandingOrder,
  entriesAhead?: number,
) {
  if (
    entriesAhead === 0 ||
    !['queued', 'checking', 'ready'].includes(state.phase) ||
    (state.phase !== 'queued' && state.sequence <= 1)
  )
    return null;
  const projectId = state.projectId as Id<'hostedProjects'>;
  const queue = selected ? null : await finishReadAheadQueue(ctx, { projectId, channel: 'main' });
  const ordered = selected ?? (queue?.status?.horizon ?? []).map(submissionId => ({ submissionId }));
  const position = ordered.findIndex(row => row.submissionId === state.id);
  const aheadKeys = position < 0 ? ordered : ordered.slice(0, position);
  const rows = [];
  for (const key of aheadKeys.slice(0, QUEUE_AHEAD_LIMIT)) {
    const row = await finishReadPeer(ctx, { projectId, submissionId: key.submissionId });
    if (row && row.submissionId !== state.id && ['queued', 'checking', 'ready'].includes(row.phase))
      rows.push(row);
  }
  if (!rows.length) return null;
  const mine = await finishReadAttempt(ctx, { projectId, attemptId: state.attemptId });
  if (!mine.candidate.head) return null;
  const ahead = [];
  for (const row of rows.slice(0, QUEUE_AHEAD_LIMIT)) {
    const peer = JSON.parse(row.value) as Pick<HostedLandingState, 'id' | 'batchId' | 'attemptId'>;
    if (state.batchId && peer.batchId === state.batchId) continue;
    const attempt = await finishReadAttempt(ctx, { projectId, attemptId: peer.attemptId });
    if (!attempt.candidate.head) continue;
    let status = row.phase;
    if (row.phase === 'queued' && row.runId) {
      const { run } = await finishReadCheck(ctx, { projectId, runId: row.runId });
      invariant(run, 'NOT_FOUND', 'Hosted check run not found.');
      if (run.status === 'passed') status = 'ready';
    }
    ahead.push({ id: peer.id, head: attempt.candidate.head, inputs: attempt.candidate.inputs, status });
  }
  const main = await finishReadMain(ctx, projectId);
  return queueAheadSelectionSchema.parse({
    main: main.head,
    mine: mine.candidate.head,
    ahead,
    more: selected
      ? aheadKeys.length > QUEUE_AHEAD_LIMIT
      : (entriesAhead ?? (queue?.status?.total ?? 1) - 1) > QUEUE_AHEAD_LIMIT && position < 0,
  });
}

export async function hostedQueueAheadSelection(
  ctx: QueryCtx | MutationCtx,
  state: HostedLandingState,
  selected?: LandingOrder,
  entriesAhead?: number,
) {
  try {
    return await selectQueueAhead(ctx, state, selected, entriesAhead);
  } catch {
    return { unavailable: true };
  }
}
