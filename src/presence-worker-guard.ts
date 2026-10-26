// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { readHostState } from './host-binding.js';
import type { WorkStore } from './work-store.js';

/** Idle limit for the detached worker. It outlasts the fold window (a session stops counting as seen at
 * PRESENCE.foldMs), so a worker never exits while anyone could still be shown as seen. The next Lane
 * command respawns it, so exiting early costs one process start, while leaking costs a process forever. */
export const WORKER_IDLE_MS = 2 * 60 * 60_000;
export const WORKER_GUARD_MS = 5_000;
const positive = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
/** Linux filesystems often hand a recreated directory the same inode, so creation time is part of identity. */
const identity = (path: string) => {
  try {
    const { dev, ino, birthtimeMs } = statSync(path);
    return `${dev}:${ino}:${birthtimeMs}`;
  } catch {
    return undefined;
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
};
const modified = (path: string) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/** Ends a detached worker when its owner is gone or replaced, its runtime was deleted, or it is idle.
 * Returns a function to record activity (Lane edits) and one to stop the guard. */
export function guardOwnerWorker(
  store: WorkStore,
  stop: (reason: 'owner-gone' | 'owner-replaced' | 'runtime-gone' | 'idle') => void,
  options: { runtime?: string | undefined } = {},
) {
  const idleMs = positive('FORGE_PRESENCE_IDLE_MS', WORKER_IDLE_MS);
  const runtime = options.runtime;
  const rootId = identity(store.root),
    directoryId = identity(store.directory);
  // A marker only this owner instance carries: a replacement at the same path lacks it even when the
  // filesystem reuses inodes and reports no creation time (some container sandboxes).
  // Per process, so a second worker for the same owner (which exits on the single-worker slot) never
  // disturbs the first; markers of dead processes are swept here.
  const marker = join(store.directory, `presence-worker-${process.pid}.marker`),
    nonce = randomUUID();
  try {
    for (const name of readdirSync(store.directory)) {
      const pid = Number(/^presence-worker-(\d+)\.marker$/.exec(name)?.[1]);
      if (pid && pid !== process.pid && !alive(pid)) rmSync(join(store.directory, name), { force: true });
    }
    writeFileSync(marker, nonce, { mode: 0o600 });
  } catch {
    /* Unwritable owner: fall back to identity alone. */
  }
  const marked = () => {
    try {
      return readFileSync(marker, 'utf8') === nonce;
    } catch {
      return false;
    }
  };
  const wasMarked = marked();
  let activity = Date.now();
  const timer = setInterval(
    () => {
      const debug = process.env.FORGE_PRESENCE_DEBUG_FILE;
      if (debug)
        try {
          appendFileSync(
            debug,
            `${JSON.stringify({ rootId, directoryId, root: identity(store.root), directory: identity(store.directory), wasMarked, marked: marked() })}\n`,
          );
        } catch {
          /* Diagnostics only. */
        }
      const reason = (() => {
        if (!existsSync(store.directory)) return 'owner-gone';
        if (
          identity(store.root) !== rootId ||
          identity(store.directory) !== directoryId ||
          (wasMarked && !marked())
        )
          return 'owner-replaced';
        if (runtime && !existsSync(runtime)) return 'runtime-gone';
        let latest = Math.max(
          activity,
          modified(store.directory),
          modified(join(store.directory, 'work.json')),
          modified(join(store.directory, 'hosted-binding.json')),
        );
        try {
          for (const session of Object.values(readHostState(store).presence ?? {}))
            latest = Math.max(latest, session.lastSeen ?? 0, session.lastActivity ?? 0);
        } catch {
          /* Advisory; unreadable state does not count as activity. */
        }
        return Date.now() - latest >= idleMs ? 'idle' : undefined;
      })();
      if (reason) {
        clearInterval(timer);
        // A gone or replaced owner is left exactly as found.
        if ((reason === 'idle' || reason === 'runtime-gone') && marked()) rmSync(marker, { force: true });
        stop(reason);
      }
    },
    positive('FORGE_PRESENCE_GUARD_MS', WORKER_GUARD_MS),
  );
  timer.unref();
  return {
    touch: () => (activity = Date.now()),
    close: () => {
      clearInterval(timer);
      if (marked()) rmSync(marker, { force: true });
    },
  };
}
