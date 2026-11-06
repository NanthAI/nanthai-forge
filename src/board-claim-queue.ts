// SPDX-License-Identifier: Apache-2.0
// Automatic file claims, client side (Issue 9c8490a4, board Lane 4). Light on purpose: the
// first-write hook loads it, so only Node builtins and root paths. The hook appends the path to a
// per-Lane spool and starts one detached sender when none holds the lock; the sender waits a short
// window, so first writes that arrive together go up in one mutation. The hook never waits on it.
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientCacheRoot } from './root-paths.js';
import { childEnv } from '../scripts/child-env.mjs';

export type ClaimTarget = { root: string; laneId: string; project: string; url: string; path: string };
/** A sender lock older than this is from a process that died; the next first write replaces it. */
export const CLAIM_LOCK_STALE_MS = 30_000;

const boardDir = (root: string) => join(clientCacheRoot(root), 'board');
const spoolFile = (root: string, laneId: string) => join(boardDir(root), `${laneId}.claims.jsonl`);
const lockFile = (root: string, laneId: string) => join(boardDir(root), `${laneId}.claims.lock`);

/** Take the per-Lane sender lock. False when a live sender holds it. */
export function acquireClaimLock(root: string, laneId: string, now = Date.now()): boolean {
  const file = lockFile(root, laneId);
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, at: now }), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      try {
        if (now - statSync(file).mtimeMs < CLAIM_LOCK_STALE_MS) return false;
        unlinkSync(file);
      } catch {
        /* Another process replaced it first: try once more. */
      }
    }
  }
  return false;
}
export function releaseClaimLock(root: string, laneId: string) {
  try {
    unlinkSync(lockFile(root, laneId));
  } catch {
    /* Already gone. */
  }
}

/** Paths waiting to be claimed, removed from the spool (rename first, so appends during the read
 * land in a fresh spool for the next round). */
export function drainClaimSpool(root: string, laneId: string): string[] {
  const file = spoolFile(root, laneId),
    taken = `${file}.${process.pid}.taking`;
  try {
    renameSync(file, taken);
  } catch {
    return [];
  }
  let text = '';
  try {
    text = readFileSync(taken, 'utf8');
  } finally {
    try {
      unlinkSync(taken);
    } catch {
      /* Best effort. */
    }
  }
  const paths = new Set<string>();
  for (const line of text.split('\n'))
    try {
      const value = JSON.parse(line) as { path?: unknown };
      if (typeof value.path === 'string') paths.add(value.path);
    } catch {
      /* Torn or empty line. */
    }
  return [...paths];
}
export const claimSpoolPending = (root: string, laneId: string) => {
  try {
    return statSync(spoolFile(root, laneId)).size > 0;
  } catch {
    return false;
  }
};

export type SpawnSender = (target: Omit<ClaimTarget, 'path'>) => void;
const senderScript = () => join(dirname(fileURLToPath(import.meta.url)), 'board-claim-sender.js');
const spawnSender: SpawnSender = target => {
  const child = spawn(
    process.execPath,
    [senderScript(), target.root, target.laneId, target.project, target.url],
    {
      detached: true,
      stdio: 'ignore',
      env: childEnv({ allow: ['FORGE_AUTH_TOKEN', 'XDG_CONFIG_HOME', 'FORGE_CLIENT_SETTINGS'] }),
    },
  );
  child.on('error', () => {
    /* Advisory: an unsent claim only means peers do not see this unsaved edit. */
  });
  child.unref();
};

/** Queue one first-write path. Starts a sender only when none is running for this Lane.
 * Cost on the hook's path: one append, one exclusive create, at most one detached spawn. */
export function queueBoardClaim(target: ClaimTarget, start: SpawnSender = spawnSender) {
  try {
    const file = spoolFile(target.root, target.laneId);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ path: target.path }) + '\n', { mode: 0o600 });
    if (!acquireClaimLock(target.root, target.laneId)) return 'queued' as const;
    const lane = { root: target.root, laneId: target.laneId, project: target.project, url: target.url };
    try {
      start(lane);
    } catch {
      releaseClaimLock(target.root, target.laneId);
      return 'failed' as const;
    }
    return 'started' as const;
  } catch {
    return 'failed' as const;
  }
}
