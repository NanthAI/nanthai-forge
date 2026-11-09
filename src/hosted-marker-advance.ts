// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { clientCacheRoot } from './root-paths.js';
import { durableReplace } from './native-durability.js';
import { workLocked } from './work-lock.js';
import { settlePendingCheckoutDelta } from './hosted-checkout-delta-pending.js';
import { hostedLaneCheckoutMarkerSchema, readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';

/** The Lane fields a metadata advance may copy from the server. */
export type LaneMetadata = {
  head: string;
  sourceVersion: number;
  version: number;
  lifecycleVersion: number;
  state: 'active' | 'completed' | 'abandoned';
};

/** Advance this checkout's marker to the Lane's current lifecycle metadata, and nothing else.
 * Same source (head and sourceVersion) with older Lane versions means only metadata moved (acceptance,
 * a pin, a reopen from another root), so the marker follows. A newer source or a later marker is never
 * rewound or overwritten, and dirty or newer local bytes and sparse materialization stay untouched.
 * Returns whether the marker moved. Local reads and one durable write; no call. */
export function advanceMarkerMetadata(root: string, laneId: string, lane: LaneMetadata): boolean {
  root = realpathSync(root);
  return workLocked(join(clientCacheRoot(root), 'lock'), () => {
    settlePendingCheckoutDelta(root);
    const marker = readHostedLaneCheckout(root);
    if (!marker || marker.selection.laneId !== laneId) return false;
    const selection = marker.selection;
    if (
      selection.head !== lane.head ||
      selection.sourceVersion !== lane.sourceVersion ||
      selection.version >= lane.version ||
      selection.lifecycleVersion >= lane.lifecycleVersion
    )
      return false;
    const next = hostedLaneCheckoutMarkerSchema.parse({
      ...marker,
      selection: {
        ...selection,
        head: lane.head,
        sourceVersion: lane.sourceVersion,
        version: lane.version,
        lifecycleVersion: lane.lifecycleVersion,
        state: lane.state,
      },
    });
    durableReplace(join(root, '.forge/hosted-lane.json'), JSON.stringify(next));
    return true;
  });
}
