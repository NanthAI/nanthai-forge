// SPDX-License-Identifier: Apache-2.0
import { COORDINATION_STALE_MS } from '../../../src/coordination-types';
import { age } from '../ui/status';
import type { DecisionItem } from './attention';
import type { CockpitLane } from './model';
import type { UnansweredNotice } from './overlap-model';

/** Live agents answer their own overlaps. Only an ended or stale session needs the person. */
export function overlapDecisions(
  lanes: readonly CockpitLane[],
  unanswered: ReadonlyMap<string, readonly UnansweredNotice[]>,
  now: number,
): DecisionItem[] {
  const byId = new Map(lanes.map(lane => [lane.id, lane]));
  const name = (lane: CockpitLane) => lane.session?.name ?? lane.startedBy?.name ?? (lane.owner || 'Agent');
  return lanes.flatMap(lane => {
    const notices = unanswered.get(lane.id);
    if (
      !lane.open ||
      !notices?.length ||
      (lane.session &&
        lane.session.status !== 'completed' &&
        now - lane.session.lastSeen <= COORDINATION_STALE_MS)
    )
      return [];
    const agent = name(lane);
    const at = notices
      .flatMap(notice => (notice.at ? [notice.at] : []))
      .sort()
      .at(-1);
    const files = new Map<string, Set<string>>();
    for (const notice of notices) {
      const peers = files.get(notice.file) ?? new Set<string>();
      for (const id of notice.lanes) {
        const peer = byId.get(id);
        if (id !== lane.id && peer) peers.add(`${peer.name} (${name(peer)})`);
      }
      files.set(notice.file, peers);
    }
    return [
      {
        id: `overlap:${lane.id}`,
        kind: 'overlap' as const,
        laneId: lane.id,
        title: lane.name,
        ...(lane.session
          ? {
              subtitle: `${agent} ${lane.session.status === 'completed' ? 'ended' : 'last seen'} ${age(lane.session.lastSeen, now)} ago`,
            }
          : {}),
        sender: { name: agent, agent: !lane.session?.person },
        ...(at ? { at } : {}),
        files: [...files].map(([path, peers]) => ({ path, with: [...peers].join(', ') })),
        noticeIds: [...new Set(notices.flatMap(notice => notice.noticeIds))],
        overlapCount: notices.length,
      },
    ];
  });
}
