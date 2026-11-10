// SPDX-License-Identifier: Apache-2.0
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Every fsync of a directory, or of a file opened only to flush it, goes through these helpers
// (lint rule forge/no-readonly-fsync). Windows has no directory fsync (NTFS journals entries)
// and FlushFileBuffers refuses a read-only handle with EPERM.

/** Flush directory entries on platforms that expose directory fsync. */
export function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try {
    // oxlint-disable-next-line forge/no-readonly-fsync -- POSIX directory fsync; Windows returned above.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export async function syncDirectoryAsync(path: string) {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    // oxlint-disable-next-line forge/no-readonly-fsync -- POSIX directory fsync; Windows returned above.
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Open flags for flushing an existing file: Windows flushes only through a writable handle. */
export const fileFlushFlags = () => (process.platform === 'win32' ? 'r+' : 'r');
export function syncFile(path: string) {
  const fd = openSync(path, fileFlushFlags());
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export async function syncFileAsync(path: string) {
  const handle = await open(path, fileFlushFlags());
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Flush through a descriptor opened read-only to verify it first. On Windows the bytes rely on
 * the writer's own flush: a read-only handle cannot flush there. */
export function syncReadOnlyDescriptor(fd: number) {
  if (process.platform !== 'win32') fsyncSync(fd);
}
/** Temporary bytes are never published until complete and durable. */
export function durableReplace(path: string, bytes: Buffer | string, mode = 0o600) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}
/** Move a finished directory to a new name without replacing anything already there. POSIX
 * claims the name with an empty directory and renames over it; Windows cannot rename onto a
 * directory, and its rename never replaces one, so it renames straight to the absent name.
 * Throws RESTORE_TARGET_EXISTS-style errors from the caller's own claim check unchanged. */
export function publishDirectory(from: string, to: string) {
  if (process.platform === 'win32') {
    renameSync(from, to);
    return;
  }
  mkdirSync(to, { mode: 0o700 });
  try {
    // oxlint-disable-next-line forge/rename-over-directory -- the POSIX branch; Windows returned above.
    renameSync(from, to);
  } catch (error) {
    try {
      rmdirSync(to);
    } catch {
      /* Preserve concurrent files. */
    }
    throw error;
  }
}
