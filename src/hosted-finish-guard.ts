// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './hash.js';
import { ForgeError } from './errors.js';
import { clientCacheRoot } from './root-paths.js';
import { machineObjectsDirectory } from './machine-object-store.js';
import { parseNativeState } from './state/format.js';
import { reviewPaths } from './source-review-format.js';
import { readLaneEntry } from './lane-registry.js';
import { readHostedLaneCheckout, type HostedLaneCheckoutMarker } from './hosted-lane-checkout-marker.js';
import { scanCheckout } from './hosted-agent-finish-identity.js';
import { shellQuote } from './shell-quote.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { hostedAgentDirectory, readAgentJson } from './hosted-agent-journal.js';

/** Paths the Lane's saved head changes against its base, from the base State manifest already on this
 * machine (the checkout's own cache or the machine object store). No server call. `null` when that
 * manifest is not cached: a missing observation never becomes "no changes" or a count. */
export function changedPathsAgainstBase(root: string, marker: HostedLaneCheckoutMarker): number | null {
  const base = marker.selection.base.head;
  for (const directory of [join(clientCacheRoot(root), 'objects'), machineObjectsDirectory()]) {
    if (!directory) continue;
    try {
      const bytes = readFileSync(join(directory, base));
      if (digest(bytes) !== base) continue;
      return reviewPaths(parseNativeState(bytes).files, marker.state.files).filter(
        item => item.status !== 'unchanged',
      ).length;
    } catch {
      /* Not cached here: try the next place. */
    }
  }
  return null;
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

/** Changed-path count a finish reported, kept in the finish journal beside its other retained values. */
export const finishChangedPathsKey = 'finish-changed-paths';

/** The changed-path count this checkout's finish operation retained (a wait prints it with LANDED). */
export function retainedChangedPaths(root: string, operationId: string): number | null | undefined {
  try {
    const path = join(hostedAgentDirectory(root), `${operationId}.json`);
    if (!checkoutPathExists(path)) return undefined;
    const value = (readAgentJson(path) as { values?: Record<string, unknown> }).values?.[
      finishChangedPathsKey
    ];
    return typeof value === 'number' || value === null ? value : undefined;
  } catch {
    return undefined;
  }
}
