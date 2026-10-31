// SPDX-License-Identifier: Apache-2.0
import { createConnection, createServer } from 'node:net';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PREFIX = 'nforge-wake-';
const STALE_MS = 2 * 3_600_000;
const SWEEP_LIMIT = 200;
const reachable = (endpoint: string) =>
  new Promise<boolean>(resolve => {
    const socket = createConnection(endpoint);
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => (socket.destroy(), resolve(true)));
  });
/** A killed driver never runs close(), so its channel directory stays behind. Remove ours that are
 * old and refuse connections; a live driver answers, and a wake is harmless to it. */
async function sweepStaleChannels(now = Date.now()) {
  try {
    let checked = 0;
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith(PREFIX)) continue;
      const directory = join(tmpdir(), name),
        stat = lstatSync(directory);
      if (
        !stat.isDirectory() ||
        (process.getuid && stat.uid !== process.getuid()) ||
        now - stat.mtimeMs < STALE_MS
      )
        continue;
      if (++checked > SWEEP_LIMIT) break;
      if (!(await reachable(join(directory, 'wake')))) rmSync(directory, { recursive: true, force: true });
    }
  } catch {
    /* Housekeeping never blocks the driver. */
  }
}
/** A private local wake channel exists only while pending. Unlike filesystem
 * notifications, lifecycle clients can explicitly wake a paused owner driver. */
export async function openWorkerNotifications() {
  if (process.platform !== 'win32') await sweepStaleChannels();
  const directory = process.platform === 'win32' ? undefined : mkdtempSync(join(tmpdir(), PREFIX));
  if (directory) chmodSync(directory, 0o700);
  const endpoint = directory ? join(directory, 'wake') : `\\\\.\\pipe\\nforge-worker-${randomUUID()}`;
  const listeners = new Set<() => void>();
  const server = createServer(socket => {
    socket.on('error', () => {});
    socket.destroy();
    for (const listener of listeners) listener();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    if (directory) chmodSync(endpoint, 0o600);
  } catch (error) {
    server.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    endpoint,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (directory) rmSync(directory, { recursive: true, force: true });
    },
  };
}
export function notifyWorker(endpoint: string) {
  const socket = createConnection(endpoint);
  socket.on('error', () => socket.destroy());
  socket.setTimeout(1000, () => socket.destroy());
  socket.on('connect', () => socket.end());
}
