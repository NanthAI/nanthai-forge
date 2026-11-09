// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { clientCacheRoot } from './root-paths.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { hostedLaneDirty } from './hosted-lane-dirty.js';

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
