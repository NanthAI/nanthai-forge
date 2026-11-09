// SPDX-License-Identifier: Apache-2.0
// Peer landing phase and ETA for overlap advice (Issue 1eb42254, D2). Read only for the few peers an
// overlap read already names in its items: a Lane with no notices reads nothing here.
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { liveLaneFinish } from './projectHostedLaneFinish';
import { readQueueStatus } from './projectHostedQueueStatus';
import { PEER_PHASE_READS, type PeerLanding } from '../src/hosted-overlap-coordination';

/** Service time when the queue has no recent landing to learn from (same as the queue status). */
const INITIAL_SERVICE_MS = 3 * 60_000;
const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

/** The live landing of each named peer (at most PEER_PHASE_READS), with an approximate ETA from the
 * queue's recent service time. Cost per peer: the bounded compose-selection lookup `land --withdraw`
 * uses, plus the queue status reads for a queued entry; the queue row is read once. */
export async function peerLandings(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  laneIds: string[],
  now = Date.now(),
): Promise<Map<string, PeerLanding | null>> {
  const result = new Map<string, PeerLanding | null>();
  const selected = [...new Set(laneIds)].slice(0, PEER_PHASE_READS);
  if (!selected.length) return result;
  const queue = await ctx.db
    .query('projectHostedLandingQueues')
    .withIndex('by_project_and_channel', q => q.eq('projectId', projectId).eq('channel', 'main'))
    .unique();
  const serviceMs = queue?.status?.serviceMs ?? INITIAL_SERVICE_MS;
  for (const laneId of selected) {
    const live = await liveLaneFinish(ctx, { projectId, laneId, headWrittenAt: '' });
    if (!live) {
      result.set(laneId, null);
      continue;
    }
    const phase = live.phase as PeerLanding['phase'];
    let etaMinutes: number | null = null;
    if (phase === 'ready') etaMinutes = 1;
    else if (phase === 'checking') {
      const started = Date.parse(live.state.timing?.checkReservedAt ?? live.state.timing?.selectedAt ?? '');
      etaMinutes = minutes(serviceMs - (Number.isFinite(started) ? Math.max(0, now - started) : 0));
    } else if (phase === 'queued') {
      const status = await readQueueStatus(ctx, live.state, now);
      etaMinutes = status ? minutes(status.eta.milliseconds + serviceMs) : null;
    } else etaMinutes = minutes(serviceMs);
    result.set(laneId, { submissionId: live.submissionId, phase, etaMinutes });
  }
  return result;
}
