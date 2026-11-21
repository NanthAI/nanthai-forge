// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientCacheRoot } from './root-paths.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { HostedAgentJournal } from './hosted-agent-journal.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { laneChanges } from './hosted-lane-dirty.js';
import { deltaApplyPending } from './hosted-checkout-delta-pending.js';
import { saveInventory, type SaveInventory } from './hosted-save-capture.js';
import { pendingConflictPaths } from './hosted-conflict-precheck.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';

/** True when an identical auto-addressed sync would replay a retained request pinned to a Lane
 * head/version this checkout has since moved past (a later save, or that sync's own apply), or when
 * this checkout holds edits that a new `save --sync` would save first. That request is finished or
 * refused work, so the new call starts a fresh operation with current pins.
 * A sync still installing (its handoff names it) or whose pins still match keeps replaying, so a
 * lost reply resumes as before. Local reads only; no call. */
export function supersededSync(
  root: string,
  address: HostedAgentAddress,
  actor: string,
  command: unknown,
  remember?: (inventory: SaveInventory) => void,
): boolean {
  try {
    const previous = HostedAgentJournal.previous(root, address, actor, 'sync', command);
    const request = previous?.values[`sync:${previous.operationId}`] as
      | { kind?: string; laneId?: string; expected?: { head?: string; version?: number } }
      | undefined;
    if (!previous || request?.kind !== 'sync' || !request.expected) return false;
    const handoff = join(clientCacheRoot(root), 'sync-handoff.json');
    if (
      checkoutPathExists(handoff) &&
      JSON.parse(readFileSync(handoff, 'utf8')).operationId === previous.operationId
    )
      return false;
    const marker = readHostedLaneCheckout(root);
    if (!marker || marker.selection.laneId !== request.laneId) return false;
    const { selection } = marker;
    if (selection.head !== request.expected.head || selection.version !== request.expected.version)
      return true;
    // Edits made since (an up-to-date sync moves neither pin): `save --sync` saves them first, so the
    // identical request is new work, never a replay that leaves them unsaved (48835eea).
    // A conflict this sync left to resolve keeps replaying its guidance: its files are the resolution.
    if (
      (command as { apply?: unknown } | null)?.apply === false ||
      pendingConflictPaths(root, selection.laneId).length
    )
      return false;
    let inventory: SaveInventory | undefined;
    try {
      if (deltaApplyPending(root)) return true;
      const dirty =
        laneChanges(root, marker, {
          limit: 1,
          scan: () => (inventory = saveInventory(root, marker)).paths,
        }).length > 0;
      if (dirty && inventory) remember?.(inventory);
      return dirty;
    } catch {
      // A fresh save reports the original capture error, as it does for any unreadable checkout.
      return true;
    }
  } catch {
    return false;
  }
}
