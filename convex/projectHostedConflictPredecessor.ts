// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { laneFinishes } from './projectHostedLaneFinish';
import { loadLandingAttempt } from './projectHostedLandingAttemptRead';
import { pipelinePredecessor } from './projectHostedLandingPipeline';
import { predecessorConflictAdvice } from '../src/hosted-would-conflict';

/** Read only after an exact saved-peer conflict exists. The current peer head and
 * installed check must still match; source sync independently fences the pin again.
 * At most eight recent compositions/three requests per peer, never retained history.
 * Conflict recording supplies its shared queue after checking the current policy;
 * observers never hydrate compose selections. */
export async function conflictPredecessor(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  notices: Pick<Doc<'projectHostedConflictNotices'>, 'peer' | 'peerHead' | 'paths' | 'flaggedAt'>[],
  queue: Doc<'projectHostedLandingQueues'> | null,
) {
  const peers = notices.filter(row => row.peer !== 'main').slice(0, 8);
  if (!peers.length) return;
  if (!queue?.train?.length) return;
  for (const notice of peers) {
    const peer = await ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', notice.peer))
      .unique();
    if (!peer?.open || peer.head !== notice.peerHead) continue;
    const { live } = await laneFinishes(
      ctx,
      { projectId, laneId: peer.laneId, headWrittenAt: '' },
      { queuedConflicts: true, head: peer.head },
    );
    if (!live || !['checking', 'ready'].includes(live.phase)) continue;
    const attempt = await loadLandingAttempt(ctx, { projectId, attemptId: live.state.attemptId });
    if (!attempt.check || !attempt.candidate.head) continue;
    const predecessor = await pipelinePredecessor(ctx, { projectId, channel: 'main' }, undefined, undefined, {
      queue,
      pins: [
        {
          submissionId: live.submissionId,
          head: attempt.candidate.head,
          receiptId: attempt.operations.accept,
        },
      ],
      requireSlot: false,
    });
    if (!predecessor) continue;
    return {
      peer: peer.laneId,
      advice: predecessorConflictAdvice({
        predecessor: { ...predecessor, groupId: live.state.batchId ?? live.state.id },
        laneId: peer.laneId,
        paths: notice.paths.map(item => item.path),
        more: 0,
        at: new Date(notice.flaggedAt).toISOString(),
        early: true,
      }),
    };
  }
}
