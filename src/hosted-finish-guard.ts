// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { pathsAgainstBase } from './hosted-changed-paths.js';
import { ForgeError } from './errors.js';
import { readLaneEntry } from './lane-registry.js';
import { readHostedLaneCheckout, type HostedLaneCheckoutMarker } from './hosted-lane-checkout-marker.js';
import { scanCheckout } from './hosted-agent-finish-identity.js';
import { shellQuote } from './shell-quote.js';

export function changedPathsAgainstBase(root: string, marker: HostedLaneCheckoutMarker): number | null {
  return pathsAgainstBase(root, marker)?.length ?? null;
}

/** land by Lane id from a folder that is not that Lane's checkout lands the server-recorded head and
 * never looks at the Lane's folder. When this machine's Lane registry knows that folder, report its
 * marker and unsaved-edit count from one local scan (no call; the scan reuses the checkout stat
 * index). Advisory: any read failure answers "unknown". */
export function inspectLaneCheckout(laneId: string) {
  try {
    const entry = readLaneEntry(laneId);
    if (!entry?.root) return null;
    const marker = readHostedLaneCheckout(entry.root);
    if (!marker || marker.selection.laneId !== laneId) return null;
    return { root: entry.root, marker, unsaved: scanCheckout(entry.root, marker).changed.length };
  } catch {
    return null;
  }
}

const plural = (count: number) => `${count} unsaved path${count === 1 ? '' : 's'}`;

/** Refusal for a land by Lane id that would skip the Lane folder's unsaved edits. */
export function unsavedEditsError(laneId: string, found: { root: string; count: number }) {
  return new ForgeError(
    'UNSAVED_LANE_EDITS',
    `Lane ${laneId} has ${plural(found.count)} in its checkout ${found.root}, and this command would land only its last saved head. Run \`cd ${shellQuote(found.root)} && nforge agent . land --save\` to save and land them, or \`save\` first.`,
  );
}

/** Refusal for a Lane whose saved head changes nothing against its base. */
export function nothingToLandError(laneId: string) {
  return new ForgeError(
    'NOTHING_TO_LAND',
    `Lane ${laneId} changes nothing against its base, so there is nothing to land. If you edited files, save them first with \`save\` or \`land --save\` from the Lane folder. To land it anyway (for example to close its Issue with no change), pass "allowEmpty":true.`,
  );
}

/** Local path estimate retained for pending finish replies. */
export const finishChangedPathsKey = 'finish-changed-paths';
