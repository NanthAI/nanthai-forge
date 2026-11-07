// SPDX-License-Identifier: Apache-2.0
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './hash.js';
import { ForgeError } from './errors.js';
import type { NativeFile } from './native-state-format.js';
import { durableReplace, syncDirectory } from './native-durability.js';
import { indexedBlob, type CheckoutStatIndex } from './checkout-stat-index.js';
import { keptApplyRoot, type KeptEntry } from './hosted-apply-kept.js';
import { retainedDeltaBackups } from './hosted-checkout-delta-settle.js';

/** Forge-owned names inside `.forge`; anything else there is kept like any other local file. */
const metadata = (markerName: string) => new Set([markerName, 'cache-use.json']);
const shaped = (stat: Stats, file: NativeFile) =>
  stat.isSymbolicLink()
    ? file.mode === 'symlink'
    : stat.isFile() && file.mode !== 'symlink' && Boolean(stat.mode & 0o111) === (file.mode === 'executable');

/** Retire the prior checkout directory after a whole-checkout publication.
 *
 * The cleanliness check before the rename owns nothing: until the rename lands, an editor can
 * recreate paths in the old root (even a layout that mimics a cache). So this never removes the
 * tree wholesale. It walks it once, as `rm -r` would. Each baseline path is first moved into a
 * private folder inside the old root and only then compared (an exact stat-index match counts,
 * like save), so a write through the old path after that lands in a new file that stays; exact
 * baseline bytes are unlinked, anything else goes back to its path. Forge's own metadata is
 * removed; the marker goes last, so an interrupted disposal can be finished from it. Anything else
 * stays, and the remainder moves whole into a held kept-apply folder in the outermost client
 * cache: listed by status, reported on every checkout result, never swept by expiry. A walk that
 * stops on a filesystem error (a read-only folder, say) holds the remainder the same way, so the
 * publication finishes and later checkouts are not refused.
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
  const asideName = `.forge-disposal-${randomUUID()}`,
    aside = join(previous, asideName);
  let asideMade = false,
    moves = 0;
  /** Put moved bytes that differ back at their path without replacing anything recreated there. */
  const restore = (moved: string, at: string, stat: Stats) => {
    try {
      if (stat.isSymbolicLink()) symlinkSync(readlinkSync(moved, { encoding: 'buffer' }), at);
      else linkSync(moved, at);
    } catch {
      return false; // Recreated meanwhile, or no hard links here: the bytes stay aside, held.
    }
    unlinkSync(moved);
    return true;
  };
  /** True when the path held exactly its baseline bytes and was removed. */
  const retire = (path: string, file: NativeFile, before: Stats) => {
    if (!shaped(before, file)) {
      kept.push({ path, kind: 'edited', digest: null });
      return false;
    }
    if (!asideMade) {
      mkdirSync(aside, { mode: 0o700 });
      asideMade = true;
    }
    const at = join(previous, path),
      moved = join(aside, String(moves++));
    renameSync(at, moved);
    const after = lstatSync(moved);
    const untouched =
      after.ino === before.ino &&
      after.size === before.size &&
      after.mtimeMs === before.mtimeMs &&
      after.mode === before.mode;
    const bytes = () =>
      after.isSymbolicLink() ? readlinkSync(moved, { encoding: 'buffer' }) : readFileSync(moved);
    if (
      shaped(after, file) &&
      ((untouched && index && indexedBlob(index, path, before, file.blob)) || digest(bytes()) === file.blob)
    ) {
      unlinkSync(moved);
      return true;
    }
    kept.push({ path, kind: 'edited', digest: null });
    if (!restore(moved, at, after))
      kept.push({ path: `${asideName}/${moves - 1}`, kind: 'extra', digest: null });
    return false;
  };
  /** Returns true when the directory is now empty and was removed. */
  const visit = (directory: string): boolean => {
    let empty = true;
    for (const name of readdirSync(join(previous, directory))) {
      if (!directory && name === asideName) continue;
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
      if (file && retire(path, file, stat)) continue;
      if (!file) kept.push({ path, kind: 'extra', digest: null });
      empty = false;
    }
    if (!directory) return empty;
    if (!empty) return false;
    rmdirSync(join(previous, directory));
    return true;
  };
  let stopped: NodeJS.ErrnoException | null = null;
  try {
    let empty = visit('');
    if (asideMade)
      try {
        rmdirSync(aside);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
        empty = false;
      }
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
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException)?.code !== 'string' || error instanceof ForgeError)
      throw error;
    stopped = error as NodeJS.ErrnoException;
  }
  // Something other than baseline bytes is here, or the walk could not finish. Hold it whole,
  // outside every disposable cache: a rename reads nothing inside it.
  const directory = join(keptApplyRoot(root), randomUUID()),
    destination = join(directory, 'prior-checkout');
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    durableReplace(
      join(directory, 'receipt.json'),
      JSON.stringify({
        held: true,
        preservedAt: destination,
        rounds: { 'prior-checkout': kept },
        ...(stopped ? { stopped: stopped.code, complete: false } : {}),
      }),
    );
    renameSync(previous, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code ?? 'unknown';
    const next = { action: 'retry' };
    // Typed, so a sync turns it into recover-apply, which replays this disposal.
    throw new ForgeError(
      'WORK_CONFLICT',
      `The new checkout is published, but its previous copy could not be removed or kept aside (${stopped?.code ?? code}, then ${code}). Nothing else was deleted: it is still at ${previous}. Fix the permission or space problem and rerun the same command, or move that folder out yourself and continue.`,
      undefined,
      {
        phase: 'dispose-previous',
        obstruction: { kind: 'prior-checkout', code, path: previous },
        preservedAt: previous,
        next,
        alternatives: [{ action: 'keep-backup', path: previous }],
      },
    );
  }
  syncDirectory(directory);
  syncDirectory(cacheRoot);
  retainedDeltaBackups(cacheRoot, destination);
  return destination;
}
