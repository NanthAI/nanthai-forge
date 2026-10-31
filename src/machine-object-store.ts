// SPDX-License-Identifier: Apache-2.0
import { constants, existsSync, mkdirSync } from 'node:fs';
import { copyFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inTestProcess } from './test-isolation.js';
import { neverIndex } from './forge-disk.js';

/** One content-addressed object directory per OS user, shared by every checkout root on
 * this machine. Disposable bytes only: readers verify each digest before use, and access
 * to a project is still checked by the server on every open. `FORGE_OBJECT_CACHE` moves
 * it, `off` disables it; tests use it only when they set it. */
export function machineObjectsDirectory(): string | null {
  const value = process.env.FORGE_OBJECT_CACHE;
  if (value === 'off') return null;
  if (value) return resolve(value);
  if (inTestProcess()) return null;
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'forge', 'objects');
}

/** APFS/Btrfs clone where available (shared blocks, separate inode), else a copy. The
 * clone keeps the source's owner-only mode; checkout caches still check mode on read. */
export async function cloneFile(source: string, target: string) {
  await copyFile(source, target, constants.COPYFILE_FICLONE);
}

/** Atomic, content-addressed write-through (temp + rename): concurrent processes need no
 * lock, and a duplicate writer just replaces identical bytes. Best effort: a full disk or
 * foreign volume never fails the caller's checkout. */
export async function rememberObject(machine: string | null, source: string, id: string) {
  if (!machine) return;
  const target = join(machine, id);
  if (existsSync(target)) return;
  const temporary = join(machine, `.tmp-${randomUUID()}`);
  try {
    if (!created.has(machine)) {
      mkdirSync(machine, { recursive: true, mode: 0o700 });
      neverIndex(machine);
      created.add(machine);
    }
    await cloneFile(source, temporary);
    await rename(temporary, target);
  } catch {
    await rm(temporary, { force: true });
  }
}
const created = new Set<string>();
