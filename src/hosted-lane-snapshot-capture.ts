// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readFileSync, readlinkSync, realpathSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { clientCacheRoot } from './root-paths.js';
import { scanSourcePaths } from './source-paths.js';
import { notSavedCollector } from './save-not-saved.js';
import { SourceFileReader } from './source-file-reader.js';
import { gitlinkDirectoryPointer } from './gitlink-workspace.js';
import { forgeCachePath } from './forge-cache-paths.js';
import { diskMode } from './source-links.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { durableReplace } from './native-durability.js';
import {
  indexedBlob,
  readCheckoutStatIndex,
  statEntry,
  type CheckoutStatIndex,
} from './checkout-stat-index.js';
import { buildSavePages, type SaveChange } from './hosted-save.js';
import type { HostedLaneCheckoutMarker } from './hosted-lane-checkout-marker.js';
import type { NativeFile } from './native-state-format.js';
import { LANE_SNAPSHOT, snapshotTree } from './lane-snapshot-contract.js';

/** Private snapshot state of one checkout, beside it in `<root>.forge-client/snapshots`. */
export const snapshotDirectory = (root: string) => join(clientCacheRoot(root), 'snapshots');
type Entry = ReturnType<typeof statEntry>;
const statPath = (root: string) => join(snapshotDirectory(root), 'stat.json');
function readStat(root: string): CheckoutStatIndex {
  try {
    const value = JSON.parse(readFileSync(statPath(root), 'utf8')) as {
      since: number;
      entries: Record<string, Entry>;
    };
    return {
      since: Math.min(value.since, lstatSync(statPath(root)).mtimeMs),
      entries: new Map(Object.entries(value.entries)),
    };
  } catch {
    return { since: 0, entries: new Map() };
  }
}
function writeStat(root: string, since: number, entries: Map<string, Entry>) {
  try {
    durableReplace(statPath(root), JSON.stringify({ since, entries: Object.fromEntries(entries) }));
  } catch {
    /* Speed only: the next snapshot hashes more. */
  }
}

export type SnapshotCapture = {
  head: string;
  tree: string;
  changes: SaveChange[];
  pages: ReturnType<typeof buildSavePages>['pages'];
  root: { sha256: string; size: number } | null;
  /** Changed file bytes by digest: read during capture, or on demand (digest-checked). */
  read: (sha256: string) => Buffer;
  /** Files left out: the save's built-in exclusions (credentials, installs) and the new-file cap. */
  notSaved: { count: number; capped: string[] };
};

/** Read a changed file, link or submodule pointer, with the save capture's safe readers. */
function readBytes(root: string, path: string, stat: Stats) {
  if (stat.isDirectory()) return gitlinkDirectoryPointer(root, path);
  if (stat.isSymbolicLink()) return readlinkSync(join(root, path), { encoding: 'buffer' });
  const reader = new SourceFileReader(root, path, 'SOURCE_CHANGED'),
    chunks: Buffer[] = [];
  try {
    reader.scan(chunk => chunks.push(Buffer.from(chunk)));
  } finally {
    reader.close();
  }
  return Buffer.concat(chunks);
}

/**
 * The working files of a hosted Lane checkout as a delta against its saved head, in the save's
 * page format. Same walk as a save (ignore rules, credential and install exclusions); unchanged
 * files are vouched for by the checkout's stat index or this snapshot index and never read. A
 * new file over LANE_SNAPSHOT.newFileBytes is left out and counted. Runs no repository code.
 */
export function captureSnapshot(root: string, marker: HostedLaneCheckoutMarker): SnapshotCapture {
  root = realpathSync(root);
  const since = Date.now(),
    checkout = readCheckoutStatIndex(root),
    own = readStat(root),
    observed = new Map<string, Entry>();
  const baseline = new Map<string, NativeFile>(marker.state.files.map(file => [file.path, file])),
    notSaved = notSavedCollector(),
    capped: string[] = [];
  const local = scanSourcePaths(root, { retained: [...baseline.keys()], onExcluded: notSaved.onExcluded });
  const changes: SaveChange[] = [],
    bytes = new Map<string, Buffer>(),
    sources = new Map<string, string>();
  for (const path of local) {
    const stat = lstatSync(join(root, path)),
      old = baseline.get(path),
      submodule = stat.isDirectory();
    const mode: NativeFile['mode'] = stat.isSymbolicLink()
      ? 'symlink'
      : submodule || old?.mode === 'gitlink'
        ? 'gitlink'
        : diskMode(stat, old?.mode);
    let blob: string | undefined;
    if (!submodule) {
      if (old && old.mode === mode) blob = indexedBlob(checkout, path, stat, old.blob);
      const known = own.entries.get(path)?.[5];
      if (!blob && known) blob = indexedBlob(own, path, stat, known);
    }
    if (!old && !submodule && stat.size > LANE_SNAPSHOT.newFileBytes) {
      capped.push(path);
      continue;
    }
    let read: Buffer | undefined;
    if (!blob) {
      read = readBytes(root, path, stat);
      blob = digest(read);
    }
    if (!submodule) observed.set(path, statEntry(stat, blob));
    if (old && old.blob === blob && old.mode === mode) continue;
    if (read) bytes.set(blob, read);
    else sources.set(blob, path);
    changes.push({
      path,
      before: old ? { blob: old.blob, mode: old.mode } : null,
      after: {
        blob,
        mode,
        content: { object: { sha256: blob, size: read?.length ?? stat.size }, recipe: null },
      },
    });
  }
  const present = new Set(local);
  for (const path of marker.materialized)
    if (!forgeCachePath(path) && !present.has(path) && baseline.has(path)) {
      const old = baseline.get(path)!;
      changes.push({ path, before: { blob: old.blob, mode: old.mode }, after: null });
    }
  writeStat(root, since, observed);
  const built = changes.length ? buildSavePages(changes) : { pages: [], root: null };
  const head = marker.selection.head;
  return {
    head,
    tree: snapshotTree(head, built.root),
    changes,
    pages: built.pages,
    root: built.root,
    read(sha256) {
      const known = bytes.get(sha256);
      if (known) return known;
      const path = sources.get(sha256);
      const value = path === undefined ? undefined : readBytes(root, path, lstatSync(join(root, path)));
      invariant(
        value && digest(value) === sha256,
        'SOURCE_CHANGED',
        'A file changed while it was snapshotted; the next command snapshots it again.',
      );
      return value;
    },
    notSaved: { count: (notSaved.value()?.count ?? 0) + capped.length, capped: capped.slice(0, 20) },
  };
}
