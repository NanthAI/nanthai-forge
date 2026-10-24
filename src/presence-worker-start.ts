// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { WorkStore } from './work-store.js';
import { readLandingWorkerStatus } from './landing-worker-status.js';
import { wakeLandingWorker } from './landing-worker-wake.js';
const started = new Set<string>();
const owners = new Map<string, { users: number; stop: () => Promise<void> }>();
/** Worker ownership is reconciled across CLI/MCP processes by the existing process queue. */
export function startPresenceWorker(store: WorkStore) {
  if (!process.argv[1]?.endsWith('/cli.js') || !existsSync(join(store.directory, 'work.json'))) return;
  const key = store.root;
  if (started.has(key) || owners.has(key)) return;
  if (readLandingWorkerStatus(store).workers) {
    wakeLandingWorker(store);
    return;
  }
  store.revision();
  started.add(key);
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./presence-worker.js', import.meta.url)), store.root],
    { detached: true, stdio: 'ignore', env: process.env },
  );
  child.once('error', () => started.delete(key));
  child.once('exit', () => started.delete(key));
  child.unref();
}

/** Only the long-lived owner service owns this lifecycle; MCP clients wake it. */
export function startOwnerPresence(store: WorkStore) {
  let owner = owners.get(store.root);
  if (owner?.users) {
    owner.users++;
  } else {
    const prior = owner;
    const controller = new AbortController();
    const pending = (async () => {
      await prior?.stop();
      const { watchOwnerPresence } = await import('./presence-worker.js');
      const { watchLandingWorker } = await import('./landing-worker.js');
      // A managed owner service must keep driving even while a detached
      // process owns presence, including after that advisory process goes idle.
      // Each channel still has only S02's queue holder and fenced driver.
      await Promise.all([
        watchOwnerPresence(store, controller.signal),
        watchLandingWorker(store, controller.signal),
      ]);
    })().catch(() => undefined);
    owner = {
      users: 1,
      stop: async () => {
        controller.abort();
        await pending;
      },
    };
    owners.set(store.root, owner);
  }
  const lease = owner;
  let stopped: Promise<void> | undefined;
  return () =>
    (stopped ??= (async () => {
      if (--lease.users) return;
      await lease.stop();
      if (owners.get(store.root) === lease) owners.delete(store.root);
    })());
}
