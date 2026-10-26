import { assertLandingWorkerActive } from './landing-worker-context.js';
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { WorkStore } from './work-store.js';

type Retained = { identity: string; value: unknown };
const caches = new WeakMap<WorkStore, Map<string, Map<string, Retained>>>();
/** Journals are atomically replaced. Check file identity on every scan, but do
 * not reread or revalidate unchanged terminal histories. Readers never write. */
function* journalRows<T, R>(
  store: WorkStore,
  folder: string,
  parse: (text: string) => T,
  select: (value: T, name: string) => R | undefined,
) {
  const directory = join(store.directory, folder);
  if (!existsSync(directory)) return [] as R[];
  let owner = caches.get(store);
  if (!owner) caches.set(store, (owner = new Map()));
  const previous = owner.get(folder) ?? new Map<string, Retained>();
  const current = new Map<string, Retained>(),
    rows: R[] = [];
  for (const name of readdirSync(directory).filter(name => /^[0-9a-f-]+\.json$/.test(name))) {
    const path = join(directory, name);
    let stat;
    try {
      stat = statSync(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const retained = previous.get(name);
    const value = retained?.identity === identity ? (retained.value as T) : parse(readFileSync(path, 'utf8'));
    current.set(name, { identity, value });
    const selected = select(value, name);
    if (selected !== undefined) rows.push(structuredClone(selected));
    yield;
  }
  owner.set(folder, current);
  return rows;
}
export function readLandingJournals<T, R>(...args: Parameters<typeof journalRows<T, R>>) {
  const scan = journalRows(...args);
  let next = scan.next();
  while (!next.done) next = scan.next();
  return next.value;
}
export async function observeLandingJournals<T, R>(...args: Parameters<typeof journalRows<T, R>>) {
  const scan = journalRows(...args);
  let turn = performance.now(),
    next = scan.next();
  while (!next.done) {
    if (performance.now() - turn >= 8) {
      await yieldTurn();
      assertLandingWorkerActive();
      turn = performance.now();
    }
    next = scan.next();
  }
  return next.value;
}
