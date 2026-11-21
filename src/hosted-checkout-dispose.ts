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
  rmSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EVENT_PROBE_PREFIX } from './forge-cache-paths.js';
import { ForgeError } from './errors.js';
import { digest } from './hash.js';
import type { NativeFile } from './state/format.js';
import { durableReplace, syncDirectory } from './state/durability.js';
import { indexedBlob, type CheckoutStatIndex } from './checkout-stat-index.js';
import { workingMatches, worktreeText } from './checkout-text.js';
import { pendingHeldCheckoutName, keptApplyRoot, type KeptEntry } from './hosted-apply-kept.js';
import { retainedDeltaBackups } from './hosted-checkout-delta-settle.js';
import { diskShapeMatches, writeSourceLink } from './source-links.js';
import { checkoutPathStat } from './hosted-checkout-files.js';

/** Forge-owned names inside `.forge`; anything else there is kept like any other local file. */
const metadata = (markerName: string) => new Set([markerName, 'cache-use.json']);
const shaped = (stat: Stats, file: NativeFile) => diskShapeMatches(stat, file.mode);

/** Retire the prior checkout directory after a whole-checkout publication.
 *
 * The cleanliness check before the rename owns nothing: until the rename lands, an editor can
 * recreate paths in the old root (even a layout that mimics a cache). Move the prior entry by
 * name into its private held folder before inspecting it, so a link swapped in at `previous`
 * can never redirect the walk. Walk it once, as `rm -r` would. Each baseline path is first moved into a
 * private folder inside the old root and only then compared (an exact stat-index match counts,
 * like save), so a write through the old path after that lands in a new file that stays; exact
 * baseline bytes are unlinked, anything else goes back to its path. Forge's own metadata is
 * removed; the marker goes last, so an interrupted disposal can be finished from it. Anything else
 * stays in the held kept-apply folder in the outermost client cache: listed by status, reported
 * on every checkout result, never swept by expiry. A walk that
 * stops on a filesystem error (a read-only folder, say) holds the remainder the same way, so the
 * publication finishes and later checkouts are not refused.
 *
 * Returns the kept folder, or null when nothing but baseline bytes was there. */
export function disposePriorCheckout(input: {
  root: string;
  cacheRoot: string;
  previous: string;
  operationId: string;
  replay?: boolean;
  files: (prior: string) => readonly NativeFile[];
  markerName: string;
  index?: CheckoutStatIndex;
}): string | null {
  const { root, cacheRoot, markerName, index } = input,
    original = input.previous;
  const unclaimed = checkoutPathStat(original);
  if (!unclaimed && !input.replay) return null;
  const hex = digest(`${cacheRoot}\0${input.operationId}`).slice(0, 32),
    id = hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'),
    cache = keptApplyRoot(root),
    directory = join(cache, id),
    previous = join(directory, 'prior-checkout'),
    receipt = join(directory, 'receipt.json'),
    awaiting = join(cache, pendingHeldCheckoutName(id));
  const kept: KeptEntry[] = [];
  const writeReceipt = (complete: boolean, stopped?: string) =>
    durableReplace(
      receipt,
      JSON.stringify({
        held: true,
        preservedAt: previous,
        rounds: { 'prior-checkout': kept },
        complete,
        ...(stopped ? { stopped } : {}),
      }),
    );
  const holder = checkoutPathStat(cache)?.isDirectory() ? checkoutPathStat(directory) : null;
  let prior = holder?.isDirectory() ? checkoutPathStat(previous) : null;
  if (!prior) {
    if (!unclaimed) return null;
    let reserved = false;
    try {
      mkdirSync(cache, { recursive: true, mode: 0o700 });
      if (!lstatSync(cache).isDirectory() || checkoutPathStat(directory)?.isDirectory() === false)
        throw Object.assign(new Error('The kept checkout directory must be real.'), { code: 'ENOTDIR' });
      durableReplace(awaiting, '');
      reserved = true;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeReceipt(false);
      syncDirectory(cache);
      syncDirectory(dirname(cache));
      // Readers ignore destinations that have not moved yet. Journal both references first
      // so a crash after the rename still reports the held path on replay.
      retainedDeltaBackups(cacheRoot, previous);
      renameSync(original, previous);
    } catch (error) {
      const moved = reserved && checkoutPathStat(previous);
      if (reserved && !moved)
        try {
          rmSync(directory, { recursive: true, force: true });
          rmSync(awaiting, { force: true });
        } catch {
          // Status ignores an unfinished receipt, and the same operation reuses its slot.
        }
      const code = (error as NodeJS.ErrnoException)?.code ?? 'unknown';
      const preservedAt = moved ? previous : original;
      throw new ForgeError(
        'WORK_CONFLICT',
        `The new checkout is published, but its previous copy could not be kept aside (${code}). It is still at ${preservedAt}. Fix the permission or space problem and rerun the same command, or move that folder out yourself and continue.`,
        undefined,
        {
          phase: 'dispose-previous',
          obstruction: { kind: 'prior-checkout', code, path: preservedAt },
          preservedAt,
          next: { action: 'retry' },
          alternatives: [{ action: 'keep-backup', path: preservedAt }],
        },
      );
    }
    syncDirectory(directory);
    syncDirectory(cacheRoot);
    prior = lstatSync(previous);
  } else {
    try {
      const stat = checkoutPathStat(receipt);
      if (!stat?.isFile() || stat.nlink !== 1) return previous;
      if (JSON.parse(readFileSync(receipt, 'utf8')).complete) return previous;
    } catch {
      return previous; // Unreadable metadata cannot authorize removing anything.
    }
  }
  // A replacement link or file is itself local content. Hold that entry without opening it.
  const files = prior.isDirectory() ? input.files(previous) : [];
  const baseline = new Map(files.map(file => [file.path, file]));
  // Files its `.gitattributes` convert hold their blob as CRLF (44ef42b9), not an edit.
  const text = prior.isDirectory() ? worktreeText(previous, files) : null;
  const owned = metadata(markerName);
  const asideName = `.forge-disposal-${randomUUID()}`,
    aside = join(previous, asideName);
  let asideMade = false,
    moves = 0;
  /** Put moved bytes that differ back at their path without replacing anything recreated there. */
  const restore = (moved: string, at: string, stat: Stats) => {
    try {
      if (stat.isSymbolicLink()) writeSourceLink(readlinkSync(moved, { encoding: 'buffer' }), at);
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
      ((untouched && index && indexedBlob(index, path, before, file.blob)) ||
        workingMatches(text, path, bytes(), file.blob, file.mode))
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
          // An older client's killed event probe: Forge-owned, removed like the other metadata (48835eea).
          else if (entry.startsWith(EVENT_PROBE_PREFIX))
            rmSync(join(at, entry), { recursive: true, force: true });
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
    let empty = prior.isDirectory() && visit('');
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
      unlinkSync(receipt);
      rmdirSync(directory);
      rmSync(awaiting, { force: true });
      syncDirectory(cache);
      return null;
    }
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException)?.code !== 'string' || error instanceof ForgeError)
      throw error;
    stopped = error as NodeJS.ErrnoException;
  }
  // A provisional receipt already points at these bytes if the final summary cannot be written.
  if (!checkoutPathStat(previous)) return null;
  writeReceipt(true, stopped?.code);
  rmSync(awaiting, { force: true });
  syncDirectory(cache);
  return previous;
}
