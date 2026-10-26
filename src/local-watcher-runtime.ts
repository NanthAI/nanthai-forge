// SPDX-License-Identifier: Apache-2.0
import { childEnv } from '../scripts/child-env.mjs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirBelow } from './mkdir-below.js';
import { sharedWatcher } from './local-watcher-client.js';

export type WatchMessage = {
  id: number;
  type: string;
  event?: string;
  name?: string | null;
  code?: string;
  probe?: number;
  directory?: string;
};
/** Injectable process transport. Native filesystem work lives only in this child. */
export const watcherRuntime = {
  now: () => Date.now(),
  createWorker(directory?: string) {
    if (directory) return sharedWatcher(directory);
    const child = fork(fileURLToPath(new URL('./local-watcher-worker.js', import.meta.url)), [], {
      execArgv: [],
      env: childEnv(),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const unref = child.unref.bind(child);
    const ref = child.ref.bind(child);
    return Object.assign(child, {
      postMessage(message: object) {
        if (child.connected) child.send(message, () => {});
      },
      unref() {
        child.channel?.unref();
        unref();
      },
      ref() {
        child.channel?.ref();
        ref();
      },
      terminate() {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        child.kill('SIGKILL');
        if (child.connected) child.disconnect();
        return exited;
      },
    });
  },
};
type Subscription = {
  path: string;
  recursive: boolean;
  persistent: boolean;
  message: (message: WatchMessage) => void;
};
export const WATCH_RETRY_MS = 60_000;
/** Resolve native owners (including Lane paths) and ordinary Git owners without
 * running repository code. Unowned diagnostic paths retain a private helper. */
function ownerDirectory(path: string): string | undefined {
  try {
    let current = path;
    // Missing subscription targets still belong to their existing owner.
    while (!existsSync(current)) {
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
    current = realpathSync(current);
    for (;;) {
      if (existsSync(join(current, '.forge', 'work'))) return join(current, '.forge', 'work');
      if (existsSync(join(current, '.git'))) {
        const directory = join(current, '.forge', 'work');
        mkdirBelow(current, directory);
        return directory;
      }
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
  } catch {
    return;
  }
}
const owners = new Map<string, ReturnType<typeof createRuntime>>();
process.once('exit', () => {
  for (const runtime of owners.values()) runtime.shutdown();
});
export function subscribeWatcher(subscription: Subscription) {
  const directory = ownerDirectory(subscription.path);
  const key = directory ?? '';
  let runtime = owners.get(key);
  if (!runtime) {
    runtime = createRuntime(directory);
    owners.set(key, runtime);
  }
  return runtime.subscribe(subscription);
}
function createRuntime(directory?: string) {
  const subscriptions = new Map<number, Subscription>();
  let nextId = 0;
  let worker: ReturnType<typeof watcherRuntime.createWorker> | undefined;
  let stopping: Promise<unknown> | undefined;
  let ready = false;
  let restartRequested = false;
  let startup: NodeJS.Timeout | undefined;
  let retryAfter = 0;
  let failure = 'WATCH_WORKER_FAILED';
  const probeDirectories = new Set<string>();
  function cleanupDirectories() {
    for (const directory of probeDirectories) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        /* Private probe cleanup is best effort. */
      }
    }
    probeDirectories.clear();
  }

  function references() {
    if ([...subscriptions.values()].some(s => s.persistent)) {
      worker?.ref();
      startup?.ref();
    } else {
      worker?.unref();
      startup?.unref();
    }
  }
  function open(id: number, subscription: Subscription) {
    subscription.message({ id, type: 'opening' });
    worker?.postMessage({ id, type: 'open', path: subscription.path, recursive: subscription.recursive });
  }
  function drop() {
    const abandoned = worker;
    if (!abandoned || stopping) return;
    clearTimeout(startup);
    startup = undefined;
    ready = false;
    // Keep the process slot until exit: even unresolved native teardown cannot
    // create a succession of helpers. Nothing waits for this promise on close.
    stopping = abandoned.terminate().catch(() => undefined);
    abandoned.unref();
    cleanupDirectories();
    void stopping.finally(() => {
      if (worker !== abandoned) return;
      worker = undefined;
      stopping = undefined;
      if (restartRequested && subscriptions.size && watcherRuntime.now() >= retryAfter) ensureWorker();
    });
  }
  function failWatcherHelper(code: string) {
    restartRequested = false;
    failure = code;
    retryAfter = watcherRuntime.now() + WATCH_RETRY_MS;
    worker?.kill?.('SIGKILL');
    drop();
    for (const [id, subscription] of subscriptions) subscription.message({ id, type: 'degraded', code });
  }
  function ensureWorker() {
    if (worker || stopping || !subscriptions.size) return;
    if (watcherRuntime.now() < retryAfter) return;
    try {
      restartRequested = false;
      const current = watcherRuntime.createWorker(directory);
      worker = current;
      ready = false;
      startup = setTimeout(() => failWatcherHelper('WATCH_WORKER_START_TIMEOUT'), 3000);
      current.on('error', () => {
        if (worker === current && !stopping) failWatcherHelper('WATCH_WORKER_FAILED');
      });
      current.on('exit', () => {
        if (worker === current && !stopping) failWatcherHelper('WATCH_WORKER_EXITED');
      });
      current.on('message', (message: WatchMessage) => {
        if (worker !== current || stopping) return;
        if (message.type === 'probe-directory') probeDirectories.add(message.directory!);
        else if (message.type === 'probe-cleaned') probeDirectories.delete(message.directory!);
        else if (message.type === 'ready') {
          clearTimeout(startup);
          startup = undefined;
          ready = true;
          for (const [id, subscription] of subscriptions) open(id, subscription);
        } else subscriptions.get(message.id)?.message(message);
      });
      references();
    } catch {
      failWatcherHelper('WATCH_WORKER_FAILED');
    }
  }
  function subscribe(subscription: Subscription) {
    const id = ++nextId;
    subscriptions.set(id, subscription);
    if (ready && !stopping) open(id, subscription);
    else {
      ensureWorker();
      if (!worker || (stopping && watcherRuntime.now() < retryAfter))
        subscription.message({ id, type: 'degraded', code: failure });
      else if (stopping) {
        restartRequested = true;
        subscription.message({ id, type: 'draining' });
      }
    }
    references();
    return {
      fail: failWatcherHelper,
      send(message: object) {
        if (ready && !stopping) worker?.postMessage({ ...message, id });
      },
      retry() {
        if (stopping && watcherRuntime.now() >= retryAfter) restartRequested = true;
        ensureWorker();
        return !stopping && watcherRuntime.now() >= retryAfter;
      },
      reopen() {
        if (ready && !stopping) open(id, subscription);
      },
      unref() {
        subscription.persistent = false;
        references();
      },
      release() {
        if (ready && !stopping) worker?.postMessage({ id, type: 'release' });
        subscriptions.delete(id);
        if (!subscriptions.size) {
          restartRequested = false;
          drop();
        } else references();
      },
    };
  }

  return {
    subscribe,
    shutdown() {
      void worker?.terminate();
      cleanupDirectories();
    },
  };
}
