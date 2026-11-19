// SPDX-License-Identifier: Apache-2.0
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { clientCacheRoot } from './root-paths.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { hostedLaneDirty } from './hosted-lane-dirty.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';

/** True when this checkout already settled the save with this operation id: its receipt replays
 * and the call captures nothing new. Local read only. */
export function saveSettledHere(root: string, operationId: string) {
  try {
    return checkoutPathExists(
      join(clientCacheRoot(realpathSync(root)), 'saves', operationId, 'terminal.json'),
    );
  } catch {
    return false;
  }
}

/** An earlier invocation of this save started here (its capture folder exists): this call is a replay. */
export function saveStartedHere(root: string, operationId: string) {
  try {
    return checkoutPathExists(join(clientCacheRoot(realpathSync(root)), 'saves', operationId));
  } catch {
    return false;
  }
}

/** The step split a save receipt keeps (Issue 15fd0037 F4). The first invocation that sees the outcome
 * retains its split; when an earlier call of the same save returned IN_PROGRESS, that split is a
 * replay's (no capture or upload) and says so with `replay: true`. A settled replay returns the kept one. */
export async function keptSaveTiming<T extends { stepsMs: Record<string, number> }>(
  journal: { get<V>(key: string): V | undefined; retain<V>(key: string, prepare: () => V): Promise<V> },
  input: { outcome: boolean; split: T; replay: boolean },
): Promise<(T & { replay?: true }) | undefined> {
  if (!input.outcome || !Object.keys(input.split.stepsMs).length) return journal.get('save-timing');
  return journal.retain('save-timing', () =>
    input.replay ? { ...input.split, replay: true as const } : input.split,
  );
}

/** A save never reports success for edits it did not capture (Issue ca49dc6c). Once its outcome
 * completed, the Lane binding names the head it saved; files that differ from it (edited after the
 * capture, or present when an earlier save's receipt was replayed) are reported as unsaved with the
 * next step. A local digest pass that reads only files the stat index cannot vouch for; no call. */
export function unsavedAfterSave(root: string, outcome: object) {
  if ((outcome as { outcome?: { status?: unknown } }).outcome?.status !== 'completed') return null;
  return hostedLaneDirty(root)
    ? {
        saved: false,
        note: 'Files in this checkout differ from the head this save reports: those edits are not in it. Run save again (without operationId) to save them.',
      }
    : null;
}

/** A bare save whose settled receipt would replay while this checkout matches its saved head: there is
 * nothing to save. The answer names the head this checkout is on now (a sync since that save moved it)
 * and the earlier save, so no older receipt, head or failure is replayed as this call's result (ad80e037).
 * Null when edits differ from the head (a new save runs) or the checkout cannot be read. Local reads only. */
export function nothingToSave(root: string, operationId: string) {
  try {
    if (hostedLaneDirty(root)) return null;
    const marker = readHostedLaneCheckout(root);
    if (!marker) return null;
    const { laneId, head, version } = marker.selection;
    let lastHead: string | undefined;
    try {
      const settled = JSON.parse(
        readFileSync(
          join(clientCacheRoot(realpathSync(root)), 'saves', operationId, 'terminal.json'),
          'utf8',
        ),
      ) as { outcome?: { result?: { head?: unknown } } };
      const saved = settled.outcome?.result?.head;
      if (typeof saved === 'string') lastHead = saved;
    } catch {
      /* The note then names the earlier save without its head. */
    }
    const moved = lastHead !== undefined && lastHead !== head ? lastHead : undefined;
    return {
      status: 'nothing-to-save' as const,
      laneId,
      head,
      version,
      note: `Nothing to save: this checkout matches this checkout's saved head ${head.slice(0, 12)}, so no save ran.${
        moved
          ? ` The last save here (${operationId}) saved ${moved.slice(0, 12)}; this checkout moved on since (a sync).`
          : ''
      }`,
    };
  } catch {
    return null;
  }
}
