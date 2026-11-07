// SPDX-License-Identifier: Apache-2.0
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './hash.js';
import type { NativeFile } from './native-state-format.js';
import { durableReplace, syncDirectory } from './native-durability.js';
import { indexedBlob, type CheckoutStatIndex } from './checkout-stat-index.js';
import { keptApplyRoot, type KeptEntry } from './hosted-apply-kept.js';
import { retainedDeltaBackups } from './hosted-checkout-delta-settle.js';

/** Forge-owned names inside `.forge`; anything else there is kept like any other local file. */
const metadata = (markerName: string) => new Set([markerName, 'cache-use.json']);

/** Retire the prior checkout directory after a whole-checkout publication.
 *
 * The cleanliness check before the rename owns nothing: until the rename lands, an editor can
 * recreate paths in the old root (even a layout that mimics a cache). So this never removes the
 * tree wholesale. It walks it once, as `rm -r` would, and unlinks only paths that still hold
 * exactly their baseline bytes (an exact stat-index match counts, like save) plus Forge's own
 * metadata. The marker goes last, so an interrupted disposal can be finished from it. Anything
 * else stays, and the remainder moves whole into a held kept-apply folder in the outermost client
 * cache: listed by status, reported on every checkout result, never swept by expiry.
 *
 * Returns the kept folder, or null when nothing but baseline bytes was there. */
export function disposePriorCheckout(input: {
  root: string;
  cacheRoot: string;
  previous: string;
  files: readonly NativeFile[];
  markerName: string;
  index?: CheckoutStatIndex;
}): string | null {
  const { root, cacheRoot, previous, markerName, index } = input;
  const baseline = new Map(input.files.map(file => [file.path, file]));
  const owned = metadata(markerName);
  const kept: KeptEntry[] = [];
  const matches = (path: string, file: NativeFile) => {
    const at = join(previous, path),
      stat = lstatSync(at);
    if (stat.isSymbolicLink())
      return file.mode === 'symlink' && digest(readlinkSync(at, { encoding: 'buffer' })) === file.blob;
    if (!stat.isFile() || file.mode === 'symlink') return false;
    if (Boolean(stat.mode & 0o111) !== (file.mode === 'executable')) return false;
    if (index && indexedBlob(index, path, stat, file.blob)) return true;
    return digest(readFileSync(at)) === file.blob;
  };
  /** Returns true when the directory is now empty and was removed. */
  const visit = (directory: string): boolean => {
    let empty = true;
    for (const name of readdirSync(join(previous, directory))) {
      const path = directory ? `${directory}/${name}` : name,
        at = join(previous, path),
        stat = lstatSync(at);
      if (path === '.forge' && stat.isDirectory() && !stat.isSymbolicLink()) {
        // The marker and `.forge` itself go after every other path (below).
        for (const entry of readdirSync(at)) {
          if (entry === markerName) continue;
          if (owned.has(entry)) unlinkSync(join(at, entry));
          else {
            kept.push({ path: `.forge/${entry}`, kind: 'extra', digest: null });
            empty = false;
          }
        }
        continue;
      }
      if (stat.isDirectory() && !stat.isSymbolicLink() && !baseline.has(path)) {
        if (visit(path)) continue;
        empty = false;
        continue;
      }
      const file = baseline.get(path);
      if (file && matches(path, file)) {
        unlinkSync(at);
        continue;
      }
      kept.push({ path, kind: file ? 'edited' : 'extra', digest: null });
      empty = false;
    }
    if (!directory) return empty;
    if (!empty) return false;
    rmdirSync(join(previous, directory));
    return true;
  };
  const empty = visit('');
  if (empty) {
    const marker = join(previous, '.forge', markerName);
    try {
      unlinkSync(marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      rmdirSync(join(previous, '.forge'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    rmdirSync(previous);
    syncDirectory(cacheRoot);
    return null;
  }
  // Something other than baseline bytes is here. Hold it whole, outside every disposable cache.
  const directory = join(keptApplyRoot(root), randomUUID()),
    destination = join(directory, 'prior-checkout');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  durableReplace(
    join(directory, 'receipt.json'),
    JSON.stringify({
      held: true,
      preservedAt: destination,
      rounds: { 'prior-checkout': kept },
    }),
  );
  renameSync(previous, destination);
  syncDirectory(directory);
  syncDirectory(cacheRoot);
  retainedDeltaBackups(cacheRoot, destination);
  return destination;
}
