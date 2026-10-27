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
async function selectQueueAhead(ctx: QueryCtx | MutationCtx, state: HostedLandingState) {
  if (state.sequence <= 1 || !['queued', 'checking', 'ready'].includes(state.phase)) return null;
  const projectId = state.projectId as Id<'hostedProjects'>;
  const rows = (
    await Promise.all(
      ['queued', 'checking', 'ready'].map(phase =>
        ctx.db
          .query('projectHostedLandingRequests')
          .withIndex('by_project_and_channel_and_phase_and_sequence', q =>
            q
              .eq('projectId', projectId)
              .eq('channel', 'main')
              .eq('phase', phase as 'queued' | 'checking' | 'ready')
              .lte('sequence', state.sequence - 1),
          )
          .take(QUEUE_AHEAD_LIMIT + 1),
      ),
    )
  )
    .flat()
    .sort((a, b) => a.sequence - b.sequence);
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
    more: rows.length > QUEUE_AHEAD_LIMIT,
  });
}

export async function hostedQueueAheadSelection(ctx: QueryCtx | MutationCtx, state: HostedLandingState) {
  try {
    return await selectQueueAhead(ctx, state);
  } catch {
    return { unavailable: true };
  }
}
