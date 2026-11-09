// SPDX-License-Identifier: Apache-2.0
import type { CockpitLane } from './model';

/**
 * The one rule for "this Lane needs the viewer": a conflict, a landing waiting for review or failed, or a
 * passed check with no landing record. The Needs you panel, the shell badge, the Intent board pill and
 * the Home count all call it, so they cannot disagree about which Lanes count.
 */
export function laneNeedsYou(lane: Pick<CockpitLane, 'open' | 'tone' | 'queue'>): boolean {
  return (
    lane.open &&
    (lane.tone === 'conflict' ||
      (lane.queue ? lane.queue.state === 'review' || lane.queue.state === 'failed' : lane.tone === 'passed'))
  );
}
