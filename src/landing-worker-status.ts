// SPDX-License-Identifier: Apache-2.0
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { mkdirBelow } from './mkdir-below.js';
import { processAlive } from './local-process.js';
import type { WorkStore } from './work-store.js';
const schema = z.object({
  schema: z.literal(1),
  id: z.uuid(),
  worker: z.object({ pid: z.number().int().positive(), startTime: z.string() }),
  status: z.enum(['recovering', 'driving', 'idle', 'stopped', 'error']),
  observedAt: z.string(),
  endpoint: z.string(),
  code: z.string().optional(),
});
export type LandingWorkerState = z.infer<typeof schema>;
export function landingWorkerStates(store: WorkStore) {
  const directory = join(store.directory, 'landing-workers');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(name => /^[0-9a-f-]+\.json$/.test(name))
    .map(name => schema.parse(JSON.parse(readFileSync(join(directory, name), 'utf8'))));
}
export function saveLandingWorkerState(store: WorkStore, state: LandingWorkerState) {
  const directory = join(store.directory, 'landing-workers');
  mkdirBelow(store.directory, directory);
  const path = join(directory, `${state.id}.json`),
    temporary = `${path}.tmp`;
  const file = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(file, JSON.stringify(schema.parse(state)) + '\n');
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, path);
  const parent = openSync(directory, 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
/** A last event time plus current kernel identity, never a periodic heartbeat. */
export function readLandingWorkerStatus(store: WorkStore) {
  const states = landingWorkerStates(store).sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  const live = states.filter(state => state.status !== 'stopped' && processAlive(state.worker));
  const selected =
    live.find(state => state.status === 'driving' || state.status === 'recovering') ?? live[0] ?? states[0];
  return {
    status: live.length ? selected!.status : selected?.status === 'stopped' ? 'stopped' : 'unavailable',
    workers: live.length,
    observedAt: selected?.observedAt ?? null,
    code: selected?.code ?? null,
  };
}
export type LandingWorkerStatus = ReturnType<typeof readLandingWorkerStatus>;
