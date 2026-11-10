// SPDX-License-Identifier: Apache-2.0
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';
import { snapshotDirectory } from './lane-snapshot-hint.js';
import { scanSourcePaths } from './source-paths.js';
import { notSavedCollector } from './save-not-saved.js';
import { SourceFileReader } from './source-file-reader.js';
import { gitlinkDirectoryPointer } from './gitlink-workspace.js';
import { forgeCachePath } from './forge-cache-paths.js';
import { diskMode } from './source-links.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
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
import { scanSecretText, SECRET_SCAN_MAX_FILE_BYTES } from './secret-scan.js';

type Entry = ReturnType<typeof statEntry>;
const statPath = (root: string) => join(snapshotDirectory(root), 'stat.json');
/** Secret-scan verdicts by blob digest: true = holds a credential. Each changed blob is scanned once. */
type Verdicts = Map<string, boolean>;
function readStat(root: string): CheckoutStatIndex & { verdicts: Verdicts } {
  try {
    const value = JSON.parse(readFileSync(statPath(root), 'utf8')) as {
      since: number;
      entries: Record<string, Entry>;
      verdicts?: Record<string, boolean>;
    };
    return {
      since: Math.min(value.since, lstatSync(statPath(root)).mtimeMs),
      entries: new Map(Object.entries(value.entries)),
      verdicts: new Map(Object.entries(value.verdicts ?? {})),
    };
  } catch {
    return { since: 0, entries: new Map(), verdicts: new Map() };
  }
}
/** Every observed file matches the index and no verdict is new: rewriting it would change nothing. */
function sameObservations(
  before: { entries: Map<string, Entry>; verdicts: Verdicts },
  entries: Map<string, Entry>,
  verdicts: Verdicts,
) {
  if (before.entries.size !== entries.size || before.verdicts.size !== verdicts.size) return false;
  for (const [path, entry] of entries) {
    const old = before.entries.get(path);
    if (!old || entry.some((value, index) => value !== old[index])) return false;
  }
  for (const [blob, secret] of verdicts) if (before.verdicts.get(blob) !== secret) return false;
  return true;
}
/** Speed only: a lost or torn write makes the next snapshot hash more, so it is replaced
 * atomically without the flush a source record needs. */
function writeStat(root: string, since: number, entries: Map<string, Entry>, verdicts: Verdicts) {
  const path = statPath(root),
    temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(
      temporary,
      JSON.stringify({ since, entries: Object.fromEntries(entries), verdicts: Object.fromEntries(verdicts) }),
      { mode: 0o600 },
    );
    renameSync(temporary, path);
  } catch {
    rmSync(temporary, { force: true });
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
  /** Files left out: the save's built-in exclusions (credentials, installs), the new-file cap
   * (`capped`) and changed files whose content the secret scan flags (`held`). */
  notSaved: { count: number; capped: string[]; held: string[] };
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
 * new file over LANE_SNAPSHOT.newFileBytes, and a changed file the landing secret scan flags,
 * are left out and counted. Runs no repository code.
 */
export function captureSnapshot(root: string, marker: HostedLaneCheckoutMarker): SnapshotCapture {
  root = realpathSync(root);
  const since = Date.now(),
    checkout = readCheckoutStatIndex(root),
    own = readStat(root),
    observed = new Map<string, Entry>(),
    verdicts: Verdicts = new Map(),
    held: string[] = [];
  let hashed = false;
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
      // A file read here is racy or new: only a rewritten index moves `since` past it.
      hashed = true;
      read = readBytes(root, path, stat);
      blob = digest(read);
    }
    if (!submodule) observed.set(path, statEntry(stat, blob));
    if (old && old.blob === blob && old.mode === mode) continue;
    // Content the landing secret scan calls a credential stays out: a snapshot never lands, so
    // nothing would scan it later. One scan per changed blob; the verdict is kept by digest.
    if (mode !== 'symlink' && mode !== 'gitlink') {
      let secret = own.verdicts.get(blob);
      if (secret === undefined) {
        if (!read && stat.size <= SECRET_SCAN_MAX_FILE_BYTES) {
          const value = readBytes(root, path, stat);
          if (digest(value) === blob) read = value;
        }
        secret =
          !!read &&
          read.length <= SECRET_SCAN_MAX_FILE_BYTES &&
          !read.subarray(0, 8192).includes(0) &&
          scanSecretText(path, read.toString('utf8')).length > 0;
        if (read || stat.size > SECRET_SCAN_MAX_FILE_BYTES) verdicts.set(blob, secret);
      } else verdicts.set(blob, secret);
      if (secret) {
        held.push(path);
        continue;
      }
    }
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
  if (hashed || !sameObservations(own, observed, verdicts)) writeStat(root, since, observed, verdicts);
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
    notSaved: {
      count: (notSaved.value()?.count ?? 0) + capped.length + held.length,
      capped: capped.slice(0, 20),
      held: held.slice(0, 20),
    },
  };
}
