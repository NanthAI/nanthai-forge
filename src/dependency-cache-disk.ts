// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { lstatSync, readdirSync, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';

const stat = (path: string) => lstatSync(path, { throwIfNoEntry: false });
type DiskEntry = { bytes: number; newest: number; exclusive: number; shared: Set<SharedInode> };
type SharedInode = { bytes: number; entries: Set<DiskEntry | undefined> };

function checkDirectory(path: string, original: Stats) {
  const current = stat(path);
  if (!current?.isDirectory() || current.dev !== original.dev || current.ino !== original.ino)
    throw new Error('A dependency cache directory moved during measurement.');
}

/** Allocated space like du: no symlink traversal and one charge per hard-linked inode. */
export function dependencyCacheDiskUsage(cache: string, sweepSlot: string) {
  const links = new Map<string, SharedInode>();
  const entries = new Map<string, DiskEntry>();
  const downloads = join(cache, 'downloads');
  let downloadBytes = 0;
  function walk(path: string, entry?: DiskEntry): number {
    if (path === sweepSlot) return 0;
    const info = stat(path);
    if (path === cache && !info?.isDirectory())
      throw new Error('The dependency cache root moved during measurement.');
    if (!info) return 0;
    const record =
      info.isDirectory() &&
      (dirname(path) === cache ||
        /^downloads[\\/](?:pnpm|yarn)[\\/][0-9a-f]{16}$/.test(path.slice(cache.length + 1)))
        ? { bytes: 0, newest: 0, exclusive: 0, shared: new Set<SharedInode>() }
        : entry;
    if (record) record.newest = Math.max(record.newest, info.mtimeMs);
    let bytes = info.blocks * 512;
    if (!info.isDirectory() && info.nlink > 1) {
      const exact =
        Number.isSafeInteger(info.dev) && Number.isSafeInteger(info.ino)
          ? info
          : lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (!exact) return 0;
      const key = `${exact.dev}:${exact.ino}`;
      let inode = links.get(key);
      if (inode) bytes = 0;
      else links.set(key, (inode = { bytes, entries: new Set() }));
      inode.entries.add(record);
      record?.shared.add(inode);
      return bytes;
    }
    if (record) record.exclusive += bytes;
    if (!info.isDirectory()) return bytes;

    const names = readdirSync(path);
    // A concurrent store writer can replace a directory between lstat and readdir.
    // Check before visiting the returned names and again after visiting them.
    checkDirectory(path, info);
    if (path === cache && names.includes('downloads')) {
      // Charge links shared with an installed tree to downloads before walking other entries.
      downloadBytes = walk(downloads);
      bytes += downloadBytes;
    }
    for (const name of names)
      if (path !== cache || name !== 'downloads') bytes += walk(join(path, name), record);
    checkDirectory(path, info);
    if (record && record !== entry) {
      record.bytes = bytes;
      entries.set(path, record);
    }
    return bytes;
  }

  const bytes = walk(cache);
  const reclaim = (path: string) => {
    const entry = entries.get(path);
    if (!entry) return 0;
    let bytes = entry.exclusive;
    for (const inode of entry.shared) {
      if (inode.entries.delete(entry) && !inode.entries.size) bytes += inode.bytes;
    }
    return bytes;
  };
  return { bytes, downloadBytes, entries, reclaim };
}
