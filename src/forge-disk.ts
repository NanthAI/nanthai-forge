// SPDX-License-Identifier: Apache-2.0
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const minute = 60_000,
  hour = 60 * minute;
export const neverIndexName = '.metadata_never_index';
const stampName = '.swept';

/** Spotlight skips a directory holding this empty file. Forge roots hold millions of disposable
 * files (4.4 M on one Mac); indexing them costs disk and CPU. Advisory; never throws. */
export function neverIndex(directory: string) {
  try {
    writeFileSync(join(directory, neverIndexName), '', { flag: 'wx', mode: 0o600 });
  } catch {
    /* Present already, or the directory is not ours to mark. */
  }
}
const stat = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};
/** A private directory this user owns; never a link another user planted in a shared temp. */
function ownDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const value = lstatSync(path);
  return (
    value.isDirectory() && !value.isSymbolicLink() && (!process.getuid || value.uid === process.getuid())
  );
}

/** One sweepable root for Forge temp output: $TMPDIR/forge-tmp/<purpose>-<pid>-<random>. */
export function forgeTempRoot() {
  return join(tmpdir(), 'forge-tmp');
}
export function forgeTempDir(purpose: string) {
  const root = forgeTempRoot();
  try {
    if (ownDirectory(root)) {
      neverIndex(root);
      return mkdtempSync(join(root, `${purpose}-${process.pid}-`));
    }
  } catch {
    /* Fall back to plain TMPDIR below. */
  }
  return mkdtempSync(join(tmpdir(), `forge-${purpose}-`));
}
export function peersCacheRoot() {
  return join(tmpdir(), `forge-peers-${process.getuid?.() ?? 'user'}`);
}

/** Allocated bytes of a tree; links are never followed. */
export function treeBytes(path: string): number {
  let bytes = 0;
  const stack = [path];
  while (stack.length) {
    const next = stack.pop()!,
      value = stat(next);
    if (!value) continue;
    bytes += value.blocks * 512;
    if (value.isDirectory() && !value.isSymbolicLink())
      for (const name of readdirSync(next)) stack.push(join(next, name));
  }
  return bytes;
}

export type SweepPolicy = {
  /** Entries not written for this long are removed. */
  maxAgeMs: number;
  /** Entries written this recently are in use. */
  graceMs?: number;
  /** An entry a live process holds (lock, pid) is never removed. */
  inUse?: (name: string, path: string) => boolean;
};
export type SweepResult = { removed: number; bytes: number; kept: number; finished: boolean };

/** Age eviction of one directory's entries. Local only; never throws. */
export function sweepEntries(
  directory: string,
  policy: SweepPolicy,
  now = Date.now(),
  deadline = Date.now() + 10_000,
): SweepResult {
  const result: SweepResult = { removed: 0, bytes: 0, kept: 0, finished: true };
  let names: string[];
  try {
    names = readdirSync(directory).filter(name => name !== neverIndexName && name !== stampName);
  } catch {
    return result;
  }
  const grace = policy.graceMs ?? 10 * minute;
  const remove = (path: string, bytes: number) => {
    try {
      rmSync(path, { recursive: true, force: true });
      result.removed++;
      result.bytes += bytes;
      return true;
    } catch {
      return false;
    }
  };
  for (const name of names) {
    if (Date.now() > deadline) return { ...result, finished: false };
    const path = join(directory, name),
      value = stat(path);
    if (!value) continue;
    const held = now - value.mtimeMs < grace || Boolean(policy.inUse?.(name, path));
    if (held || now - value.mtimeMs < policy.maxAgeMs) result.kept++;
    else if (!remove(path, value.isDirectory() ? treeBytes(path) : value.blocks * 512)) result.kept++;
  }
  return result;
}

/** At most once per interval per directory: the stamp is written only after a finished pass. */
export function sweepHourly(
  directory: string,
  policy: SweepPolicy,
  now = Date.now(),
  every = hour,
): SweepResult | null {
  const stamp = join(directory, stampName),
    last = stat(stamp);
  if (!stat(directory) || (last && now - last.mtimeMs < every)) return null;
  const result = sweepEntries(directory, policy, now);
  if (result.finished)
    try {
      writeFileSync(stamp, '', { mode: 0o600 });
      utimesSync(stamp, now / 1000, now / 1000);
    } catch {
      /* A missing stamp only repeats the pass. */
    }
  return result;
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};
/** forge-tmp entries name their writer: `<purpose>-<pid>-<random>`. */
export function tempEntryInUse(name: string) {
  const pid = Number(/-(\d+)-[^-]*$/.exec(name)?.[1]);
  return Number.isSafeInteger(pid) && pid > 0 && pidAlive(pid);
}
export const tempMaxAgeMs = 2 * hour;
/** CLI start: a bounded local pass over forge-tmp, at most hourly. No daemon, no timers, no Convex
 * calls; a failure only repeats next time. The peers cache evicts its own entries
 * (agent-peers-cache.ts); here it only gets the Spotlight marker. */
export function sweepClientDisk(now = Date.now()) {
  const temp = sweepHourly(
    forgeTempRoot(),
    { maxAgeMs: tempMaxAgeMs, inUse: name => tempEntryInUse(name) },
    now,
  );
  if (stat(peersCacheRoot())?.isDirectory()) neverIndex(peersCacheRoot());
  return { temp };
}
