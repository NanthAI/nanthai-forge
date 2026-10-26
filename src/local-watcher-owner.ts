// SPDX-License-Identifier: Apache-2.0
import { createServer, type Socket } from 'node:net';
import { statSync, mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, chmodSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { workLocked } from './work-lock.js';
import { processAlive, processIdentity } from './local-process.js';
import { startLocalWatcher, type Command } from './local-watcher-worker.js';
import type { WatchLease } from './local-watcher-client.js';

/** The owner lease is elected under an existing recoverable local lock. Kernel
 * start identities fence PID reuse; only a dead lease permits socket takeover. */
export function startSharedWatcher(directory: string) {
  // The owner can disappear while helper startup is queued. Never recreate it.
  if (!statSync(directory).isDirectory()) throw new Error('WATCH_OWNER_UNAVAILABLE');
  const path = join(directory, 'local-watcher.json');
  const identity = processIdentity();
  const lease = workLocked(
    join(directory, 'local-watcher-start.lock'),
    () => {
      let previous: WatchLease | undefined;
      try {
        previous = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        /* First startup. */
      }
      if (
        previous &&
        Number.isInteger(previous.pid) &&
        previous.pid > 0 &&
        typeof previous.startTime === 'string' &&
        typeof previous.socket === 'string'
      ) {
        if (processAlive(previous)) return previous;
        const oldDirectory = dirname(previous.socket);
        if (
          dirname(oldDirectory) === realpathSync(tmpdir()) &&
          basename(oldDirectory).startsWith('forge-watch-owner-')
        )
          rmSync(oldDirectory, { recursive: true, force: true });
      }
      const socket = join(mkdtempSync(join(realpathSync(tmpdir()), 'forge-watch-owner-')), 'socket');
      const next = { ...identity, socket };
      writeFileSync(path, JSON.stringify(next), { mode: 0o600 });
      return next;
    },
    { waitMs: 2500 },
  );
  if (lease.pid !== process.pid || lease.startTime !== identity.startTime) {
    if (process.connected) process.send?.(lease, () => process.exit(0));
    else process.exit(0);
    return;
  }
  const clients = new Set<Socket>();
  const routes = new Map<number, { socket: Socket; id: number }>();
  let nextId = 0;
  const receive = startLocalWatcher((value, done) => {
    const message = value as { id?: number; type: string };
    const route = message.id === undefined ? undefined : routes.get(message.id);
    if (route && !route.socket.destroyed)
      route.socket.write(JSON.stringify({ ...message, id: route.id }) + '\n');
    done();
  });
  const server = createServer(socket => {
    clearTimeout(startup);
    clients.add(socket);
    const ids = new Map<number, number>();
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line) as Command;
          let id = ids.get(message.id);
          // Close acknowledgements may arrive after an immediate reopen. Keep
          // routing until the client explicitly releases its subscription.
          if (message.type === 'release') {
            if (id !== undefined) {
              routes.delete(id);
              ids.delete(message.id);
              receive({ id, type: 'close' } as Command);
            }
            continue;
          }
          if (id === undefined) {
            id = ++nextId;
            ids.set(message.id, id);
            routes.set(id, { socket, id: message.id });
          }
          receive({ ...message, id });
        } catch {
          socket.destroy();
        }
      }
    });
    socket.on('error', () => {});
    socket.once('close', () => {
      clients.delete(socket);
      // Last disconnect must not wait on a potentially wedged native close.
      if (!clients.size) process.exit(0);
      for (const id of ids.values()) {
        routes.delete(id);
        receive({ id, type: 'close' } as Command);
      }
    });
  });
  const startup = setTimeout(() => process.exit(0), 3000);
  process.once('exit', () => {
    rmSync(dirname(lease.socket), { recursive: true, force: true });
    // Retain the dead identity for safe takeover; no exiting process can delete
    // a successor's lease.
  });
  server.on('error', () => process.exit(1));
  server.listen(lease.socket, () => {
    chmodSync(lease.socket, 0o600);
    if (process.connected) process.send?.(lease, () => {});
  });
}
