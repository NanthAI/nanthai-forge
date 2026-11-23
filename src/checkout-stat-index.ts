// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { clientCacheRoot } from './root-paths.js';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
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

/** Git's untracked cache for a hosted checkout (Issue 48835eea), kept beside it in
 * `<root>.forge-client` (never source, never sent anywhere). A full source walk records the lstat of
 * every directory it listed (taken before the listing) and of every file whose own bytes or links
 * decided an inclusion (ignore files, credential-name holds, dependency installs). While none of
 * those changed, the same walk returns the same paths: creating, deleting or renaming an entry
 * always changes its directory's mtime and ctime, and an edit changes the file's. So a check can
 * take the recorded paths and skip the walk; an edit to a listed file is still found by the
 * caller's own per-file lstat pass. Anything that differs, is missing or is racy (changed inside
 * the timestamp window before the walk began) means the caller walks again. File events are never
 * used: under load they arrive late with no error, exactly when saves must not trust them. As Git
 * gates its untracked cache, a record is kept only where a probe shows this file system moves a
 * directory's stat when an entry is created (some FUSE and network mounts do not): the probe runs in
 * the client cache beside the checkout, on the same device, never inside the checkout. */
export const checkoutTreeCacheName = 'checkout-tree.json';
// Older records may omit directories named "__proto__". They are safe to rebuild on demand.
const treeSchema = 2;
type Seen = [mtimeMs: number, ctimeMs: number, ino: number, size: number];
type Recorded = {
  schema: typeof treeSchema;
  since: number;
  /** The checkout's device: a record from another mount is never trusted. */
  dev: number;
  paths: string[];
  /** One character per `paths` entry: '1' when that path was in the walk's retained set. */
  retained: string;
  /** Retained paths the walk did not return (absent here, or excluded anyway). */
  retainedOnly: string[];
  directories: Record<string, Seen>;
  inputs: Record<string, Seen>;
};

const file = (root: string) => join(clientCacheRoot(root), checkoutTreeCacheName);
const seen = (stat: Stats): Seen => [stat.mtimeMs, stat.ctimeMs, stat.ino, stat.size];

/** True when the client cache sits on the checkout's device and a file created there moves its
 * directory's mtime (from a stamp set an hour back, so a coarse clock tick cannot hide the move). A
 * few local syscalls, once per recorded walk. */
function directoryStatsMove(root: string, dev: number) {
  let probe: string | undefined;
  try {
    const cache = clientCacheRoot(root);
    if (lstatSync(cache).dev !== dev) return false;
    probe = mkdtempSync(join(cache, 'tree-probe-'));
    const old = (Date.now() - 3_600_000) / 1000;
    utimesSync(probe, old, old);
    const before = lstatSync(probe).mtimeMs;
    writeFileSync(join(probe, 'entry'), '');
    return lstatSync(probe).mtimeMs !== before;
  } catch {
    return false;
  } finally {
    if (probe) rmSync(probe, { recursive: true, force: true });
  }
}

/** Records one full walk. Create it before the walk starts (its clock is the racy bound). Stats are
 * taken below the resolved root (a symlinked root's own lstat never moves). Recording never throws
 * into the walk: anything it cannot observe, or a folder on another device (a mount inside the
 * checkout, which the probe does not cover), leaves no record. */
export function treeRecorder(checkout: string) {
  const since = Date.now(),
    directories: Record<string, Seen> = Object.create(null),
    inputs: Record<string, Seen> = Object.create(null);
  let root = checkout,
    dev = -1,
    trusted = true,
    written = 0;
  try {
    root = realpathSync(checkout);
    dev = lstatSync(root).dev;
  } catch {
    trusted = false;
  }
  const observe = (path: string, stat?: Stats) => {
    try {
      const value = stat ?? lstatSync(join(root, path));
      if (value.dev !== dev) trusted = false;
      return seen(value);
    } catch {
      trusted = false;
      return undefined;
    }
  };
  return {
    /** Call before listing `path` ('' is the root). */
    directory(path: string) {
      const value = observe(path);
      if (value) directories[path] = value;
    },
    /** A file whose own bytes or links decided whether it, or its directory's rules, apply. */
    input(path: string, stat?: Stats) {
      const value = observe(path, stat);
      if (value) inputs[path] = value;
    },
    /** Reuse across phases only when the observations pass the tree cache's filesystem and
     * timestamp checks. A racy or changed tree needs a new capture inventory. */
    stillCurrent() {
      const bound = Math.min(since, written);
      return (
        written !== 0 &&
        [directories, inputs].every(observations =>
          Object.entries(observations).every(([path, before]) => unchanged(root, path, before, bound)),
        )
      );
    },
    /** After a walk that returned `paths` for `retained`. Best effort: a failed write only means
     * the next check walks. */
    write(paths: readonly string[], retained: Iterable<string>) {
      const kept = new Set(retained),
        returned = new Set(paths);
      const value: Recorded = {
        schema: treeSchema,
        since,
        dev,
        paths: [...paths],
        retained: paths.map(path => (kept.has(path) ? '1' : '0')).join(''),
        retainedOnly: [...kept].filter(path => !returned.has(path)),
        directories,
        inputs,
      };
      try {
        // Nothing on this file system can vouch for a directory: no record, and none older kept.
        if (trusted && directoryStatsMove(root, dev)) {
          durableReplace(file(root), JSON.stringify(value));
          written = lstatSync(file(root)).mtimeMs;
        } else rmSync(file(root), { force: true });
      } catch {
        /* Speed only. */
      }
    },
  };
}
export type TreeRecorder = ReturnType<typeof treeRecorder>;

/** True while `stat` still equals what was recorded and was already old when the walk began. */
function unchanged(root: string, path: string, recorded: Seen, since: number) {
  let stat: Stats;
  try {
    stat = lstatSync(join(root, path));
  } catch {
    return false;
  }
  const margin = racyMarginMs(stat);
  return (
    stat.mtimeMs === recorded[0] &&
    stat.ctimeMs === recorded[1] &&
    stat.ino === recorded[2] &&
    stat.size === recorded[3] &&
    stat.mtimeMs < since - margin &&
    stat.ctimeMs < since - margin
  );
}

/** The paths a full source walk with this `retained` set would return now, from the last recorded
 * walk, or undefined when it must walk (nothing recorded, anything recorded changed or is racy, or
 * the retained set differs in a way that could change the result). Retention only ever adds
 * paths, so a path retained now but not then must already have been returned, and a path retained
 * then but not now must not have been. One lstat per listed directory and recorded input; no
 * listing, no file read. */
export function cachedSourcePaths(checkout: string, retained: Iterable<string>): string[] | undefined {
  try {
    const root = realpathSync(checkout),
      path = file(root);
    if (!checkoutPathExists(path)) return undefined;
    const written = lstatSync(path).mtimeMs;
    const value = JSON.parse(readFileSync(path, 'utf8')) as Recorded;
    if (
      value.schema !== treeSchema ||
      value.retained.length !== value.paths.length ||
      value.dev !== lstatSync(root).dev
    )
      return undefined;
    // The file system's clock after every observation bounds a client clock ahead of it (Git's rule).
    const since = Math.min(value.since, written);
    for (const [directory, recorded] of Object.entries(value.directories))
      if (!unchanged(root, directory, recorded, since)) return undefined;
    for (const [input, recorded] of Object.entries(value.inputs))
      if (!unchanged(root, input, recorded, since)) return undefined;
    const now = new Set(retained);
    const returned = new Set(value.paths),
      before = new Set(value.retainedOnly);
    for (let index = 0; index < value.paths.length; index++)
      if (value.retained[index] === '1') before.add(value.paths[index]!);
    for (const kept of now) if (!before.has(kept) && !returned.has(kept)) return undefined;
    for (const kept of before) if (!now.has(kept) && returned.has(kept)) return undefined;
    return value.paths;
  } catch {
    return undefined;
  }
}
