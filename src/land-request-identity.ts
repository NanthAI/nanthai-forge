// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
import type { LandEntry } from './land-journal.js';

type StoreAccess = Pick<WorkStore, 'directory'>;

/** An alias retains its own request identity but observes the original controller.
 * Resolve atomic journal snapshots without joining any owner or driver lock. */
export function resolveLandEntry(store: StoreAccess, entry: LandEntry): LandEntry {
  if (!entry.sourceOperationId) return entry;
  const state = JSON.parse(
    readFileSync(join(store.directory, 'agent-land', `${entry.sourceOperationId}.json`), 'utf8'),
  ) as { entries: LandEntry[] };
  const original = state.entries.find(item => item.command.operationId === entry.command.operationId);
  invariant(
    original && !original.sourceOperationId,
    'INVALID_WORK_STORE',
    'Original landing entry is unavailable.',
  );
  return { ...original, inputs: entry.inputs, sourceOperationId: entry.sourceOperationId };
}
