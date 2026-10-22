// SPDX-License-Identifier: Apache-2.0
import { createConnection, createServer } from 'node:net';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** A private local wake channel exists only while pending. Unlike filesystem
 * notifications, lifecycle clients can explicitly wake a paused owner driver. */
export async function openAutoExchangeNotifications() {
  const directory = process.platform === 'win32' ? undefined : mkdtempSync(join(tmpdir(), 'nforge-wake-'));
  if (directory) chmodSync(directory, 0o700);
  const endpoint = directory ? join(directory, 'wake') : `\\\\.\\pipe\\nforge-auto-${randomUUID()}`;
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
export function notifyAutoExchange(endpoint: string) {
  const socket = createConnection(endpoint);
  socket.on('error', () => socket.destroy());
  socket.setTimeout(1000, () => socket.destroy());
  socket.on('connect', () => socket.end());
}
