// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientCacheRoot } from './root-paths.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { HostedAgentJournal } from './hosted-agent-journal.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { hostedLaneDirty } from './hosted-lane-dirty.js';
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
    const selection = readHostedLaneCheckout(root)?.selection;
    if (!selection || selection.laneId !== request.laneId) return false;
    if (selection.head !== request.expected.head || selection.version !== request.expected.version)
      return true;
    // Edits made since (an up-to-date sync moves neither pin): `save --sync` saves them first, so the
    // identical request is new work, never a replay that leaves them unsaved (48835eea).
    // A conflict this sync left to resolve keeps replaying its guidance: its files are the resolution.
    return (
      (command as { apply?: unknown } | null)?.apply !== false &&
      !pendingConflictPaths(root, selection.laneId).length &&
      hostedLaneDirty(root)
    );
  } catch {
    return false;
  }
}
