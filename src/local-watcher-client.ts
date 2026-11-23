// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { workerPath } from './worker-install.js';
import { readFileSync } from 'node:fs';
import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { childEnv } from '../scripts/child-env.mjs';
import { processAlive, processLiveness } from './local-process.js';
import type { WatchMessage } from './local-watcher-runtime.js';

export type WatchLease = { pid: number; startTime: string; socket: string; cleanupKey?: string };
export const WATCH_OWNER_PREFIX = 'forge-watch-owner-';
export const WATCH_OWNER_MARKER = 'owner';
export async function removeWatchSocket(lease: WatchLease) {
  const directory = dirname(lease.socket);
  try {
    if (lease.cleanupKey === undefined) {
      const { isSocketDirectory } = await import('./socket-directory.js');
      if (!isSocketDirectory(directory, WATCH_OWNER_PREFIX)) return;
    } else {
      // Peers may have different TMPDIRs. Only remove the original, real
      // directory whose ownership marker matches the published lease.
      if (
        typeof lease.cleanupKey !== 'string' ||
        lease.cleanupKey.length !== 36 ||
        basename(lease.socket) !== 'socket' ||
        !basename(directory).startsWith(WATCH_OWNER_PREFIX)
      )
        return;
      if ((await realpath(directory)) !== directory) return;
      const marker = join(directory, WATCH_OWNER_MARKER);
      const stat = await lstat(marker);
      if (!stat.isFile() || stat.size !== lease.cleanupKey.length) return;
      if ((await readFile(marker, 'utf8')) !== lease.cleanupKey) return;
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Normal exit or a concurrent reaper may already have removed it. */
  }
}
/** One socket is one attached process. Closing it never kills another client's
 * healthy helper; failed native probes can still terminate a wedged helper. */
export function sharedWatcher(directory: string) {
  const events = new EventEmitter();
  let socket: Socket | undefined, candidate: ChildProcess | undefined, lease: WatchLease | undefined;
  let stopped = false,
    persistent = true;
  let retry: NodeJS.Timeout | undefined;
  const began = Date.now();
  let startupDone = Promise.resolve();
  const failed = () => {
    if (stopped) return;
    if (Date.now() - began >= 2500) events.emit('error', new Error('WATCH_CONNECT_FAILED'));
    else if (!retry) {
      retry = setTimeout(connect, 25);
      if (!persistent) retry.unref();
    }
  };
  function connect() {
    retry = undefined;
    if (stopped) return;
    try {
      const previous = JSON.parse(readFileSync(join(directory, 'local-watcher.json'), 'utf8')) as WatchLease;
      if (
        Number.isInteger(previous.pid) &&
        previous.pid > 0 &&
        typeof previous.startTime === 'string' &&
        typeof previous.socket === 'string' &&
        processAlive(previous)
      ) {
        attach(previous);
        return;
      }
    } catch {
      /* Elect a helper when no live lease can be read. */
    }
    candidate = fork(workerPath(new URL('./local-watcher-worker.js', import.meta.url)), [directory], {
      detached: true,
      execArgv: [],
      env: childEnv(),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const current = candidate;
    let started!: () => void;
    startupDone = new Promise<void>(resolve => {
      started = resolve;
    });
    current.once('error', () => started());
    current.once('exit', () => started());
    let received = false;
    current.once('error', failed);
    current.once('exit', () => {
      if (!received) failed();
    });
    current.once('message', (value: WatchLease) => {
      received = true;
      if (value.pid === current.pid) {
        if (current.exitCode !== null || current.signalCode !== null) {
          if (current.exitCode !== 0) void removeWatchSocket(value);
        } else
          current.once('exit', code => {
            if (code !== 0) void removeWatchSocket(value);
          });
      }
      if (stopped && value.pid === current.pid && current.connected) {
        // This client elected the owner and left before attaching. Release it now, not
        // after its startup window; startup completes when it has exited (removing its
        // socket directory) or stayed for a peer that attached meanwhile. Its reply says which:
        // an exiting helper closes its channel before its process is gone, so only 'exit' (wired
        // above) proves it left; a staying one is done once it disconnects.
        let staying = false;
        current.on('message', (reply: { type?: string; exiting?: boolean }) => {
          if (reply?.type === 'abandoned') staying = !reply.exiting;
        });
        current.once('disconnect', () => staying && started());
        current.send({ type: 'abandon' }, error => error && started());
        return;
      }
      started();
      if (current.connected) current.disconnect();
      current.unref();
      if (stopped) return;
      attach(value);
    });
    if (!persistent) {
      current.channel?.unref();
      current.unref();
    }
  }
  function attach(value: WatchLease) {
    lease = value;
    const connection = createConnection(value.socket);
    socket = connection;
    if (!persistent) connection.unref();
    let connected = false,
      buffer = '';
    connection.once('connect', () => {
      connected = true;
      events.emit('message', { type: 'ready' });
    });
    connection.on('data', chunk => {
      buffer += chunk.toString();
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          events.emit('message', JSON.parse(line) as WatchMessage);
        } catch {
          connection.destroy();
        }
      }
    });
    connection.on('error', () => {});
    connection.once('close', () => {
      if (stopped) return;
      if (connected) events.emit('exit');
      else failed();
    });
  }
  // Let callers install error/message listeners before starting.
  queueMicrotask(connect);
  const terminate = () => {
    stopped = true;
    clearTimeout(retry);
    socket?.destroy();
    // Election can still write the owner's lease after subscriptions close.
    // Join its publication/exit before allowing owner teardown, while leaving
    // a helper already serving peers alive. Native watcher teardown is separate.
    candidate?.ref();
    candidate?.channel?.ref();
    return startupDone.then(() => {
      if (candidate?.connected) candidate.disconnect();
      candidate?.unref();
    });
  };
  return Object.assign(events, {
    postMessage(message: object) {
      if (!stopped && socket?.writable) socket.write(JSON.stringify(message) + '\n');
    },
    ref() {
      persistent = true;
      socket?.ref();
      candidate?.ref();
      candidate?.channel?.ref();
      retry?.ref();
    },
    unref() {
      persistent = false;
      socket?.unref();
      candidate?.unref();
      candidate?.channel?.unref();
      retry?.unref();
    },
    kill() {
      if (!lease) return;
      const liveness = processLiveness(lease);
      if (liveness === 'unknown') return;
      if (liveness === 'alive') {
        try {
          process.kill(lease.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
        }
      }
      // The electing process reaps after the child's exit event. Peers can
      // remove the same lease directory after aborting its published identity.
      if (candidate?.pid !== lease.pid) void removeWatchSocket(lease);
    },
    drainStartup: () => {
      candidate?.ref();
      candidate?.channel?.ref();
      return startupDone.finally(() => candidate?.unref());
    },
    terminate,
  });
}
