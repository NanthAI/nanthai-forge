// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { laneRegistryDirectory } from './lane-registry.js';

const LIMIT = 1_000_000;
export type LanePruneRecord = {
  laneId: string;
  root: string;
  /** Server state that allowed the removal. */
  state: string;
  reason: string;
  idleHours: number;
  bytes: number;
};
/** Durable record of every Lane root housekeeping removes: one JSON line per root, written before
 * the removal so an interrupted pass is still explained. Never throws; rotates past 1 MB. */
export const lanePruneLogFile = () => join(dirname(laneRegistryDirectory()), 'lane-prune.jsonl');
export function logLanePrune(record: LanePruneRecord, now = Date.now()) {
  try {
    const file = lanePruneLogFile();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (statSync(file).size > LIMIT) renameSync(file, `${file}.1`);
    } catch {
      /* No log yet. */
    }
    appendFileSync(file, `${JSON.stringify({ at: new Date(now).toISOString(), ...record })}\n`, {
      mode: 0o600,
    });
  } catch {
    /* The log is advisory; removal rules do not depend on it. */
  }
}
