// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readdirSync, type Stats } from 'node:fs';
import { join } from 'node:path';

const stat = (path: string) => lstatSync(path, { throwIfNoEntry: false });

function checkDirectory(path: string, original: Stats) {
  const current = stat(path);
  if (!current?.isDirectory() || current.dev !== original.dev || current.ino !== original.ino)
    throw new Error('A dependency cache directory moved during measurement.');
}

/** Allocated space like du: no symlink traversal and one charge per hard-linked inode. */
export function dependencyCacheDiskUsage(cache: string, sweepSlot: string) {
  const links = new Set<string>();
  let downloadBytes = 0;
  function walk(path: string): number {
    if (path === sweepSlot) return 0;
    const info = stat(path);
    if (path === cache && !info?.isDirectory())
      throw new Error('The dependency cache root moved during measurement.');
    if (!info) return 0;
    if (!info.isDirectory() && info.nlink > 1) {
      const exact =
        Number.isSafeInteger(info.dev) && Number.isSafeInteger(info.ino)
          ? info
          : lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (!exact) return 0;
      const key = `${exact.dev}:${exact.ino}`;
      if (links.has(key)) return 0;
      links.add(key);
    }
    let bytes = info.blocks * 512;
    if (!info.isDirectory()) return bytes;

    const names = readdirSync(path);
    // A concurrent store writer can replace a directory between lstat and readdir.
    // Check before visiting the returned names and again after visiting them.
    checkDirectory(path, info);
    if (path === cache && names.includes('downloads')) {
      // Charge links shared with an installed tree to downloads before walking other entries.
      downloadBytes = walk(join(cache, 'downloads'));
      bytes += downloadBytes;
    }
    for (const name of names) if (path !== cache || name !== 'downloads') bytes += walk(join(path, name));
    checkDirectory(path, info);
    return bytes;
  }

  const bytes = walk(cache);
  return { bytes, downloadBytes };
}
