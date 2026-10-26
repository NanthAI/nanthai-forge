// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../scripts/child-env.mjs';
import { processAlive, processStartTime } from './local-process.js';
import type { WatchMessage } from './local-watcher-runtime.js';

export type WatchLease = { pid: number; startTime: string; socket: string };
/** One socket is one attached process. Closing it never kills another client's
 * healthy helper; failed native probes can still terminate a wedged helper. */
export function sharedWatcher(directory: string) {
  const events = new EventEmitter();
  let socket: Socket | undefined, candidate: ChildProcess | undefined, lease: WatchLease | undefined;
  let stopped = false,
    persistent = true;
  let retry: NodeJS.Timeout | undefined;
  const began = Date.now();
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
    candidate = fork(fileURLToPath(new URL('./local-watcher-worker.js', import.meta.url)), [directory], {
      detached: true,
      execArgv: [],
      env: childEnv(),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const current = candidate;
    let received = false;
    current.once('error', failed);
    current.once('exit', () => {
      if (!received) failed();
    });
    current.once('message', (value: WatchLease) => {
      received = true;
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
    // A starter may already serve peers before its IPC reply reaches us.
    // Detach; the helper's finite startup deadline owns orphan cleanup.
    if (candidate?.connected) candidate.disconnect();
    candidate?.unref();
    return Promise.resolve();
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
      if (lease && processStartTime(lease.pid) === lease.startTime) {
        try {
          process.kill(lease.pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
    },
    terminate,
  });
}
