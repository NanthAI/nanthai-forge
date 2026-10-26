// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { subscribeWatcher, type WatchMessage } from './local-watcher-runtime.js';
export { watcherRuntime } from './local-watcher-runtime.js';

export type WatchHealth = { status: 'healthy' | 'probing' | 'degraded'; code?: string };
export type LocalWatcher = {
  readonly health: WatchHealth;
  probe(): Promise<WatchHealth>;
  close(): Promise<void>;
  unref(): void;
};
const active = new Set<LocalWatcher>();
export function localWatchingHealth(): WatchHealth {
  return [...active].find(w => w.health.status === 'degraded')?.health ?? { status: 'healthy' };
}
function privateDirectory(prefix: string) {
  return mkdtempSync(join(realpathSync(tmpdir()), prefix));
}
/** Local hints only. Recovery is requested by existing consumer ticks, never a
 * new poll. Every subscription shares one process with independently routed IPC. */
export function watchLocal(
  path: string,
  options: {
    recursive?: boolean;
    persistent?: boolean;
    onReady?: () => void;
    probeMs?: number;
    closeMs?: number;
  },
  listener: (event: string, name: string | null) => void,
): LocalWatcher {
  const probeMs = options.probeMs ?? 3000,
    closeMs = Math.min(options.closeMs ?? 250, 250);
  let health: WatchHealth = { status: 'probing' };
  let closed = false,
    opened = false,
    opening = false,
    persistent = options.persistent !== false;
  let timer: NodeJS.Timeout | undefined;
  let probing: Promise<WatchHealth> | undefined, resolveProbe: ((health: WatchHealth) => void) | undefined;
  let closing: Promise<void> | undefined, resolveClose: (() => void) | undefined;
  let generation = 0;
  // subscribeWatcher can report a synchronous startup failure before returning.
  let connection: ReturnType<typeof subscribeWatcher> | undefined = undefined;
  const cleanupProbe = () => {
    clearTimeout(timer);
    const done = resolveProbe;
    resolveProbe = undefined;
    probing = undefined;
    done?.(health);
  };
  const pendingProbe = () => {
    health = { status: 'probing' };
    probing ??= new Promise<WatchHealth>(resolve => {
      resolveProbe = resolve;
    });
    return probing;
  };
  const deadline = (code: string, ms = probeMs) => {
    clearTimeout(timer);
    timer = setTimeout(() => connection?.fail(code), ms);
    if (!persistent) timer.unref();
  };
  const beginProbe = () => {
    pendingProbe();
    try {
      deadline('WATCH_PROBE_OPEN_TIMEOUT');
      connection?.send({
        type: 'probe',
        recursive: options.recursive ?? false,
        probe: ++generation,
      });
    } catch (error) {
      degrade((error as NodeJS.ErrnoException).code ?? 'WATCH_PROBE_FAILED');
    }
  };
  const degrade = (code: string) => {
    health = { status: 'degraded', code };
    opened = opening = false;
    cleanupProbe();
    connection?.send({ type: 'close' });
    if (closed) resolveClose?.();
  };
  const message = (message: WatchMessage) => {
    if (message.type === 'closed') {
      if (closed) resolveClose?.();
      return;
    }
    if (message.type === 'degraded') {
      degrade(message.code!);
      return;
    }
    if (closed) return;
    if (message.type === 'draining') deadline('WATCH_WORKER_STOPPING', 250);
    else if (message.type === 'opening') {
      opening = true;
      pendingProbe();
      deadline('WATCH_OPEN_TIMEOUT');
    } else if (message.type === 'event') listener(message.event!, message.name ?? null);
    else if (message.type === 'opened') {
      opening = false;
      opened = true;
      beginProbe();
      options.onReady?.();
    } else if (message.probe === generation) {
      if (message.type === 'probe-ready' || message.type === 'probe-written') {
        deadline('WATCH_PROBE_TIMEOUT');
      } else if (message.type === 'probe-event') deadline('WATCH_PROBE_CLOSE_TIMEOUT', closeMs);
      else if (message.type === 'healthy') {
        health = { status: 'healthy' };
        cleanupProbe();
      }
    }
  };
  const handle: LocalWatcher = {
    get health() {
      return health;
    },
    probe() {
      if (closed) return Promise.resolve(health);
      if (probing) return probing;
      if (!connection?.retry()) return Promise.resolve(health);
      const result = pendingProbe();
      if (opened) beginProbe();
      else if (!opening) connection.reopen();
      return result;
    },
    unref() {
      persistent = false;
      connection?.unref();
      timer?.unref();
    },
    close() {
      if (closing) return closing;
      closed = true;
      active.delete(handle);
      cleanupProbe();
      closing = new Promise<void>(resolve => {
        const bound = setTimeout(() => connection?.fail('WATCH_CLOSE_TIMEOUT'), closeMs);
        resolveClose = () => {
          clearTimeout(bound);
          connection?.release();
          resolve();
        };
        if (!opened && !opening) resolveClose();
        else connection?.send({ type: 'close' });
      });
      return closing;
    },
  };
  active.add(handle);
  pendingProbe();
  connection = subscribeWatcher({ path, recursive: options.recursive ?? false, persistent, message });
  return handle;
}
/** Explicit doctor request, preserving the asynchronous contract. */
export async function probeLocalWatching() {
  const known = localWatchingHealth();
  if (known.status === 'degraded') return known;
  let directory: string;
  try {
    directory = privateDirectory('forge-watch-doctor-');
  } catch (error) {
    return {
      status: 'degraded' as const,
      code: (error as NodeJS.ErrnoException).code ?? 'WATCH_PROBE_FAILED',
    };
  }
  const watcher = watchLocal(directory, { recursive: true }, () => {});
  try {
    await watcher.probe();
  } finally {
    await watcher.close();
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      /* Diagnostics still return when temporary-file cleanup is unavailable. */
    }
  }
  return watcher.health;
}
