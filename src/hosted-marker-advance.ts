// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { clientCacheRoot } from './root-paths.js';
import { durableReplace } from './state/durability.js';
import { workLocked } from './work-lock.js';
import { settlePendingCheckoutDelta } from './hosted-checkout-delta-pending.js';
import { hostedLaneCheckoutMarkerSchema, readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { pendingSavePath } from './hosted-save-pending.js';
import { checkoutPathExists } from './hosted-checkout-files.js';

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

/** A Lane record write by this checkout that moved only the Lane's version (a park, Item e1633718): the marker
 * follows when it sits on exactly the version that write read (`from`), so the next save is not refused as stale.
 * A marker on any other version (a newer save, a sync) or another Lane is left alone. Local reads and one durable
 * write; no call. */
export function advanceMarkerVersion(root: string, laneId: string, from: number, to: number): boolean {
  root = realpathSync(root);
  return workLocked(join(clientCacheRoot(root), 'lock'), () => {
    settlePendingCheckoutDelta(root);
    const marker = readHostedLaneCheckout(root);
    // A save still pending against this marker is keyed by it: moving the version would hide that save from its own
    // reconcile, so the marker stays and the next save rebases as before.
    if (
      !marker ||
      marker.selection.laneId !== laneId ||
      marker.selection.version !== from ||
      to <= from ||
      checkoutPathExists(pendingSavePath(root, marker))
    )
      return false;
    const next = hostedLaneCheckoutMarkerSchema.parse({
      ...marker,
      selection: { ...marker.selection, version: to },
    });
    durableReplace(join(root, '.forge/hosted-lane.json'), JSON.stringify(next));
    return true;
  });
}
