// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientCacheRoot } from './root-paths.js';
import { neverIndex } from './forge-disk.js';

/** Private snapshot state of one checkout, beside it in `<root>.forge-client/snapshots`. */
export const snapshotDirectory = (root: string) => join(clientCacheRoot(root), 'snapshots');
const keptPath = (root: string) => join(snapshotDirectory(root), 'kept');
/** Whether this checkout last saw its project keep snapshots: only a hint, so a command may start
 * its walk beside the capability read and a turn end knows whether to look. The server's reply
 * and the policy check stay the authority. Light on purpose: the Stop hook reads it first. */
export function snapshotsKept(root: string) {
  try {
    return statSync(keptPath(root)).isFile();
  } catch {
    return false;
  }
}
export function rememberSnapshotsKept(root: string | null, kept: boolean) {
  if (!root || snapshotsKept(root) === kept) return;
  try {
    if (kept) {
      mkdirSync(snapshotDirectory(root), { recursive: true, mode: 0o700 });
      neverIndex(snapshotDirectory(root));
      writeFileSync(keptPath(root), '');
    } else rmSync(keptPath(root), { force: true });
  } catch {
    /* A hint only. */
  }
}

export const snapshotLockPath = (root: string) => join(snapshotDirectory(root), 'lock');
/** A snapshot of this checkout is running now: its lock is fresh and the process holding it lives. */
export function snapshotLockHeld(root: string) {
  const path = snapshotLockPath(root);
  try {
    if (Date.now() - statSync(path).mtimeMs > 120_000) return false;
    const pid = Number(readFileSync(path, 'utf8'));
    // Still being written: its holder just took it.
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as { code?: string }).code === 'EPERM';
    }
  } catch {
    return false;
  }
}
