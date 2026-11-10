// SPDX-License-Identifier: Apache-2.0
import { clientCacheRoot } from './root-paths.js';
import { lstatSync, readFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { durableReplace } from './state/durability.js';

/** Local stat index of a hosted checkout, kept beside it in `<root>.forge-client` (never source,
 * never sent anywhere). An entry says "a file with exactly this lstat had this blob", so capture
 * and dirty checks skip reading unchanged files, like Git's index. Entries only skip work when the
 * blob also equals the checkout baseline; anything else is read and hashed as before. */
export const checkoutStatIndexName = 'checkout-stat.json';
/** Racy-clean margin: a file whose mtime or ctime falls within this window before the
 * observation began may have changed again inside one timestamp tick, so it is always read.
 * Sub-second timestamps tick at most every ~10 ms (Linux coarse clock); whole-second ones
 * (HFS+, some network file systems, FAT's 2 s) need the wide window. */
export function racyMarginMs(stat: Pick<Stats, 'mtimeMs' | 'ctimeMs'>) {
  return stat.mtimeMs % 1000 === 0 && stat.ctimeMs % 1000 === 0 ? 2000 : 100;
}
type Entry = [size: number, mtimeMs: number, ctimeMs: number, ino: number, mode: number, blob: string];
export type CheckoutStatIndex = { since: number; entries: Map<string, Entry> };

const path = (root: string) => join(clientCacheRoot(root), checkoutStatIndexName);

/** The index for this checkout, or an empty one when absent or unreadable (everything hashes).
 * `since` is the client clock when the observations began; it is also bounded by the index file's
 * own mtime, the file system's clock after every observation (Git's racy rule), so a client clock
 * ahead of a network file system's clock never makes a fresh timestamp look old. */
export function readCheckoutStatIndex(root: string): CheckoutStatIndex {
  try {
    const file = path(root);
    if (!checkoutPathExists(file)) return { since: 0, entries: new Map() };
    const written = lstatSync(file).mtimeMs;
    const value = JSON.parse(readFileSync(file, 'utf8')) as {
      schema: number;
      since: number;
      entries: Record<string, Entry>;
    };
    if (value.schema !== 1 || typeof value.since !== 'number') return { since: 0, entries: new Map() };
    return { since: Math.min(value.since, written), entries: new Map(Object.entries(value.entries)) };
  } catch {
    return { since: 0, entries: new Map() };
  }
}

/** The blob this index vouches for at `stat`, or undefined when the file must be read. */
export function indexedBlob(
  index: CheckoutStatIndex,
  file: string,
  stat: Pick<Stats, 'size' | 'mtimeMs' | 'ctimeMs' | 'ino' | 'mode'>,
  baseline: string,
) {
  const entry = index.entries.get(file);
  const margin = racyMarginMs(stat);
  if (
    !entry ||
    entry[5] !== baseline ||
    entry[0] !== stat.size ||
    entry[1] !== stat.mtimeMs ||
    entry[2] !== stat.ctimeMs ||
    entry[3] !== stat.ino ||
    entry[4] !== stat.mode ||
    stat.mtimeMs >= index.since - margin ||
    stat.ctimeMs >= index.since - margin
  )
    return undefined;
  return baseline;
}

export const statEntry = (
  stat: Pick<Stats, 'size' | 'mtimeMs' | 'ctimeMs' | 'ino' | 'mode'>,
  blob: string,
): Entry => [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, stat.mode, blob];

/** Replace the index. `since` is when the observations began; every entry was stat'ed after it.
 * Best effort: a failed write only means the next capture hashes more. */
export function writeCheckoutStatIndex(root: string, since: number, entries: Map<string, Entry>) {
  try {
    durableReplace(path(root), JSON.stringify({ schema: 1, since, entries: Object.fromEntries(entries) }));
  } catch {
    /* Speed only. */
  }
}

/** Git-style refresh of racily clean entries. A file changed shortly before it was indexed (an
 * install, a save) stays "racy" and is re-read by every check, because a second write inside the
 * same timestamp tick would leave its lstat unchanged. A complete check pass records the lstat of
 * every file it saw: entries the index already trusted as they are, and files it re-read and found
 * to hold their baseline blob. When the pass found no difference and at least one re-read file is
 * now safely older than the pass start, the index is rewritten with the pass start as `since`.
 * Every rewritten entry was observed after that `since`, so the racy rule still holds for each; a
 * file written inside the window stays racy and is read again, never trusted on its lstat alone.
 * Create it before the first lstat of the pass. */
export function statIndexRefresh(root: string) {
  const since = Date.now(),
    entries = new Map<string, Entry>();
  let refreshable = 0;
  return {
    /** A file the index already vouches for at this lstat. */
    kept(file: string, stat: Pick<Stats, 'size' | 'mtimeMs' | 'ctimeMs' | 'ino' | 'mode'>, blob: string) {
      entries.set(file, statEntry(stat, blob));
    },
    /** A file read in this pass (lstat taken before reading) that held `blob`. */
    read(file: string, stat: Pick<Stats, 'size' | 'mtimeMs' | 'ctimeMs' | 'ino' | 'mode'>, blob: string) {
      entries.set(file, statEntry(stat, blob));
      const margin = racyMarginMs(stat);
      if (stat.mtimeMs < since - margin && stat.ctimeMs < since - margin) refreshable++;
    },
    /** After a complete pass with no difference: persist the refresh when it trusts something new.
     * Returns how many re-read files the rewrite now vouches for (0 when nothing was written). */
    commit() {
      if (!refreshable) return 0;
      writeCheckoutStatIndex(root, since, entries);
      return refreshable;
    },
  };
}

/** Index freshly installed files (a private stage before it becomes the checkout). */
export function indexInstalledFiles(stage: string, files: { path: string; blob: string }[]) {
  const since = Date.now(),
    entries = new Map<string, Entry>();
  for (const file of files)
    try {
      entries.set(file.path, statEntry(lstatSync(join(stage, file.path)), file.blob));
    } catch {
      /* Not installed here (sparse); it is simply not indexed. */
    }
  return { since, entries };
}
