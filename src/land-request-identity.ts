// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
import type { LandEntry } from './land-journal.js';
/** Called under the owner lock before publishing a new parent journal. This
 * covers pending compositions and ordinary non-batch checks as well as queues. */
export function requireNewLandSelection(
  store: WorkStore,
  operationId: string,
  channel: string,
  entries: LandEntry[],
) {
  const directory = join(store.directory, 'agent-land');
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    if (!/^[0-9a-f-]+\.json$/.test(name) || name === `${operationId}.json`) continue;
    const state = JSON.parse(readFileSync(join(directory, name), 'utf8')) as { entries: LandEntry[] };
    const prior = state.entries.find(
      entry =>
        // Only an unfinished request owns its Lane/head; finished ones (any outcome) may be resubmitted.
        entry.result === undefined &&
        !['accepted', 'conflict', 'failed', 'cancelled', 'interrupted'].includes(
          store.select('landingEntries', entry.command.operationId)?.status ?? '',
        ) &&
        entry.command.accept?.channel === channel &&
        entry.inputs.some(old =>
          entries.some(entry => entry.inputs.some(pin => pin.laneId === old.laneId && pin.head === old.head)),
        ),
    );
    invariant(
      !prior,
      'LANDING_ALREADY_SUBMITTED',
      `This Lane/head already belongs to land operation ${name.slice(0, -5)}. Replay that operation or wait for it to finish.`,
    );
  }
}
