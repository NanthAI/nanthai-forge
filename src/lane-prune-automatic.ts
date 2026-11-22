// SPDX-License-Identifier: Apache-2.0
import { lstatSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readClientSettings } from './client-settings.js';
import { tryHeavySlot } from './heavy-slots.js';
import { laneHousekeeping } from './lane-prune.js';
import { laneRegistryDirectory } from './lane-registry.js';

const intervalMs = 60 * 60_000;

/** Reuses the start sweep. A landed reply may run the same sweep for finished Lanes only.
 * Reserve the machine's window before a query, including on failure or concurrent triggers. */
export async function automaticLaneHousekeeping(
  input: Pick<
    Parameters<typeof laneHousekeeping>[0],
    'readStates' | 'exclude' | 'run' | 'now' | 'processes'
  > & {
    address: NonNullable<Parameters<typeof laneHousekeeping>[0]['address']>;
    trigger: 'start' | 'landed';
    budgetMs: number;
    settings?: ReturnType<typeof readClientSettings>;
  },
) {
  const { address, trigger, settings = readClientSettings(), now = Date.now(), ...options } = input;
  const apply = settings.autoPruneHours > 0;
  if (!apply && trigger === 'landed') return;
  const directory = dirname(laneRegistryDirectory());
  const stamp = join(directory, 'lane-prune-automatic.stamp');
  const recent = () => {
    const last = lstatSync(stamp, { throwIfNoEntry: false });
    return last !== undefined && now - last.mtimeMs < intervalMs;
  };
  if (recent()) return;
  return laneHousekeeping({
    ...options,
    settings,
    now,
    apply,
    finishedOnly: trigger === 'landed',
    automatic: {
      url: address.url,
      idleProjectId: address.projectId,
      claim: () => {
        const slot = tryHeavySlot(join(directory, 'lane-prune-automatic.lock'), 1);
        if (!slot) return false;
        try {
          if (recent()) return false;
          writeFileSync(stamp, '', { mode: 0o600 });
          utimesSync(stamp, now / 1000, now / 1000);
          return true;
        } finally {
          rmSync(slot, { recursive: true, force: true });
        }
      },
    },
  });
}
