// SPDX-License-Identifier: Apache-2.0
import { conflictMarkerScan, scanConflictMarkers, conflictMarkersFound } from './conflict-markers.js';
import {
  assertNoConflictMarkers,
  pendingConflictPaths,
  type ConflictContinuation,
} from './hosted-conflict-precheck.js';
import { clientCacheRoot } from './root-paths.js';
import {
  openSync,
  writeSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { SourceFileReader } from './source-file-reader.js';
import { readHostedLaneCheckout, type HostedLaneCheckoutMarker } from './hosted-lane-checkout-marker.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { gitlinkCommit } from './gitlink.js';
import { gitlinkDirectoryPointer } from './gitlink-workspace.js';
import { digest } from './hash.js';
import { readSource } from './files.js';
import { scanSourcePaths } from './source-paths.js';
import { notSavedCollector, notSavedFile } from './save-not-saved.js';
import { durableReplace, syncFile } from './state/durability.js';
import { invariant } from './errors.js';
import type { NativeFile } from './state/format.js';
import type { SaveChange } from './hosted-save.js';
import {
  rememberOverlapSketch,
  readOverlapText,
  readOverlapBytes,
  overlapTextSketch,
  sketchCodePath,
  overlapTextEvidence,
  sketchEdits,
  overlapLineCounts,
  deletedLineCounts,
  overlapBaseBlobs,
  rememberOverlapBases,
} from './hosted-overlap-text.js';
import { outputRoots, SymbolBudget } from './hosted-overlap-symbols.js';
import { packageFactFile, packageSymbolLinks } from './hosted-overlap-packages.js';
import { buildPackageGraph, type PackageGraph } from './package-graph.js';
import { workLocked } from './work-lock.js';
import {
  deltaApplyPending,
  finishPendingCheckoutDelta,
  settlePendingCheckoutDelta,
} from './hosted-checkout-delta-pending.js';
import { laneChanges } from './hosted-lane-dirty.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { forgeCachePath } from './forge-cache-paths.js';
import { neverIndex } from './forge-disk.js';
import { localObjects, machineObjectsDirectory, rememberObject } from './machine-object-store.js';
import {
  indexedBlob,
  readCheckoutStatIndex,
  statEntry,
  treeRecorder,
  writeCheckoutStatIndex,
  type CheckoutStatIndex,
} from './checkout-stat-index.js';
import { diskMode } from './source-links.js';
import type { TextAttributes } from './git-attributes.js';
import { storedBytes, worktreeText } from './checkout-text.js';

/** Bytes of retained base files a save reads to count deleted lines (c2388099); later deletions show no count. */
const DELETED_COUNT_BYTES = 8 * 1024 * 1024;
/** Small files hash in memory; only changed bytes ever reach the save staging. */
const memoryLimit = 1024 * 1024;
/** Private disk snapshot: bounded buffers, no link target traversal or repository execution.
 * An unchanged file writes nothing; a changed one is staged under its digest, so a save costs
 * only its changed bytes. Changed blobs also go to the machine object store, so a later open of
 * this head on this machine downloads none of them. */
function captureFile(
  root: string,
  path: string,
  directory: string,
  previous: NativeFile | undefined,
  index: CheckoutStatIndex,
  text: TextAttributes | null,
  cache: string,
) {
  const absolute = join(root, path),
    stat = lstatSync(absolute),
    temporary = join(directory, randomUUID());
  // A submodule checkout (the scanner returns a directory only for one) saves its HEAD commit.
  const submodule = stat.isDirectory();
  const mode: NativeFile['mode'] = stat.isSymbolicLink()
    ? 'symlink'
    : submodule || previous?.mode === 'gitlink'
      ? 'gitlink'
      : diskMode(stat, previous?.mode);
  // An unchanged file (same lstat as when its baseline blob was last read) is not read again.
  if (!submodule && previous && previous.mode === mode && indexedBlob(index, path, stat, previous.blob))
    return {
      file: { blob: previous.blob, mode },
      pin: { sha256: previous.blob, size: stat.size },
      changed: false,
      sketch: null,
      text: null,
      markers: false,
      stat,
    };
  let pin: { sha256: string; size: number },
    bytes: Buffer | null = null,
    carriage = false;
  const markerScan = conflictMarkerScan();
  if (submodule) {
    bytes = gitlinkDirectoryPointer(root, path);
    pin = { sha256: digest(bytes), size: bytes.length };
  } else if (stat.isSymbolicLink()) {
    invariant(
      realpathSync(dirname(absolute)) === dirname(absolute),
      'SOURCE_CHANGED',
      'Source directory changed during capture.',
    );
    bytes = readlinkSync(absolute, { encoding: 'buffer' });
    const after = lstatSync(absolute);
    invariant(
      after.isSymbolicLink() &&
        stat.ino === after.ino &&
        stat.dev === after.dev &&
        stat.ctimeMs === after.ctimeMs &&
        stat.mtimeMs === after.mtimeMs,
      'SOURCE_CHANGED',
      'Source link changed while preparing the save.',
    );
    invariant(
      realpathSync(dirname(absolute)) === dirname(absolute),
      'SOURCE_CHANGED',
      'Source directory changed during capture.',
    );
    pin = { sha256: digest(bytes), size: bytes.length };
  } else {
    invariant(stat.isFile(), 'SOURCE_READ_FAILED', 'Save source must be a regular file or symlink.');
    const source = new SourceFileReader(root, path, 'SOURCE_CHANGED'),
      chunks: Buffer[] = [],
      target = source.size > memoryLimit ? openSync(temporary, 'wx', 0o600) : null;
    try {
      pin = source.scan(chunk => {
        scanConflictMarkers(markerScan, chunk);
        if (!carriage && chunk.includes(13)) carriage = true;
        if (target === null) chunks.push(Buffer.from(chunk));
        else {
          let offset = 0;
          while (offset < chunk.length) offset += writeSync(target, chunk, offset, chunk.length - offset);
        }
      });
      invariant(
        lstatSync(absolute).mode === stat.mode,
        'SOURCE_CHANGED',
        'Source mode changed during capture.',
      );
      if (target !== null) fsyncSync(target);
    } finally {
      source.close();
      if (target !== null) closeSync(target);
    }
    if (target === null) bytes = Buffer.concat(chunks);
    // Git's `add` stores CRLF as LF for `.gitattributes` text files (44ef42b9); only bytes with a CR
    // can change, so every other file is stored exactly as read.
    if (carriage && text && text.action(path) !== 'binary') {
      const working = bytes ?? readFileSync(temporary),
        stored = storedBytes(
          text,
          path,
          mode,
          working,
          previous && { blob: previous.blob, read: () => readOverlapBytes(cache, previous.blob) },
        );
      if (stored !== working) {
        if (!bytes) rmSync(temporary, { force: true });
        bytes = stored;
        pin = { sha256: digest(stored), size: stored.length };
      }
    }
  }
  if (mode === 'gitlink') {
    invariant(
      pin.size <= 65,
      'INVALID_GITLINK',
      'A submodule pointer must contain its full pinned commit SHA.',
    );
    gitlinkCommit(bytes ?? readFileSync(temporary));
  }
  const observed = { file: { blob: pin.sha256, mode }, pin, markers: conflictMarkersFound(markerScan) };
  if (previous && previous.blob === pin.sha256 && previous.mode === mode) {
    if (!bytes) rmSync(temporary, { force: true });
    return { ...observed, changed: false, stat, sketch: null, text: null };
  }
  if (bytes) writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  const final = join(directory, pin.sha256);
  if (checkoutPathExists(final)) rmSync(temporary);
  else renameSync(temporary, final);
  syncFile(final);
  const sketch = bytes ? overlapTextSketch(bytes, sketchCodePath(path)) : null;
  // Cross-file symbol facts read the changed lines of a parsed regular file; never a link target.
  return { ...observed, changed: true, stat, sketch, text: sketch && mode !== 'symlink' ? bytes : null };
}
/** Each path's first baseline as the Lane's server row keeps it (c2388099): counts and evidence are
 * measured against it. The record survives syncs and resolution rebinds (overlapBaseBlobs). A Lane on its
 * own base has an empty row, so it starts over. A path the record lacks (the Lane continued in a second
 * folder or on another machine, or saved there since) is guessed from the base State in this machine's
 * caches, read once per save and only then (~10 ms at 6,000 files), never a server call: right unless main
 * changed that path since the Lane first saved it, and then the row's tag check drops the count rather than
 * show a wrong one. A path this Lane never saved has the base's bytes, so the guess equals its baseline. A
 * guess is kept in the record once a save uses it. */
function laneFirstBaselines(root: string, cache: string, marker: HostedLaneCheckoutMarker) {
  const { laneId, head, base } = marker.selection;
  const own = head === base.head;
  const bases: Record<string, string> =
    (own ? null : overlapBaseBlobs(cache, laneId, base.head)) ?? Object.create(null);
  let files: Map<string, string> | null | undefined = own ? null : undefined;
  const guess = (path: string) => {
    if (files === undefined) {
      // Digest-verified bytes, plain JSON: ~10 ms for 6,000 files; a malformed entry only costs its count (tag check).
      const bytes = localObjects(root)(base.head);
      try {
        const listed: { path?: unknown; blob?: unknown }[] = bytes
          ? JSON.parse(bytes.toString('utf8')).files
          : [];
        files = bytes ? new Map() : null;
        for (const file of listed)
          if (typeof file.path === 'string' && typeof file.blob === 'string')
            files!.set(file.path, file.blob);
      } catch {
        files = null;
      }
    }
    return files ? (files.get(path) ?? digest('')) : undefined;
  };
  return { bases, guess };
}
/** A source inventory belongs to one capture attempt. Files are read and checked again during
 * capture, and the caller's final check catches later changes to the set of paths. */
export function saveInventory(root: string, marker: HostedLaneCheckoutMarker) {
  root = realpathSync(root);
  const notSaved = notSavedCollector();
  const tree = treeRecorder(root);
  const paths = scanSourcePaths(root, {
    retained: marker.state.files.map(file => file.path),
    onExcluded: notSaved.onExcluded,
    tree,
  });
  return { root, marker, paths, excluded: notSaved.value(), stillCurrent: tree.stillCurrent };
}
export type SaveInventory = ReturnType<typeof saveInventory>;

export async function captureHostedSave(
  root: string,
  directory: string,
  preserveConflicts = false,
  continuation?: ConflictContinuation,
  sync?: { inventory?: SaveInventory | undefined },
) {
  root = realpathSync(root);
  // An interrupted sync leaves a half-applied tree under the old marker; capture only a whole one.
  const interrupted = sync && deltaApplyPending(root);
  finishPendingCheckoutDelta(root);
  const marker = readHostedLaneCheckout(root);
  invariant(marker, 'NOT_FOUND', 'Open a hosted Lane before preparing a save.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const since = Date.now();
  let checked: SaveInventory | undefined;
  if (sync && !interrupted) {
    const previous = sync.inventory;
    if (
      previous?.root === root &&
      canonicalPayload(previous.marker) === canonicalPayload(marker) &&
      previous.stillCurrent()
    )
      checked = previous;
    else if (
      !laneChanges(root, marker, {
        refresh: true,
        limit: 1,
        // This is the capture attempt's own walk. A dirty checkout takes these paths straight
        // into capture; a warm clean check can avoid enumerating them altogether.
        scan: () => (checked = saveInventory(root, marker)).paths,
      }).length
    )
      return { marker, changes: [], files: [] };
  }
  const index = readCheckoutStatIndex(root),
    text = worktreeText(root, marker.state.files),
    observedStats = new Map<string, ReturnType<typeof statEntry>>(),
    cache = clientCacheRoot(root),
    { bases, guess } = laneFirstBaselines(root, cache, marker);
  const baseline = new Map(marker.state.files.map(file => [file.path, file]));
  checked ??= saveInventory(root, marker);
  const local = checked.paths;
  const marked: string[] = [];
  const resolving = pendingConflictPaths(root, marker.selection.laneId).length > 0;
  const changes: SaveChange[] = [],
    files: { pin: { sha256: string; size: number }; path: string }[] = [];
  const existing = new Set(local),
    links = {
      exists: (path: string) => existing.has(path),
      roots: outputRoots(root),
      budget: new SymbolBudget(),
    };
  // Package facts for code without import-level facts: the checkout's manifest graph, built at most once.
  let graph: PackageGraph | undefined;
  const packageContext = {
    budget: links.budget,
    graph: () =>
      (graph ??= buildPackageGraph(existing, path => {
        try {
          return readSource(root, path, 1024 * 1024)?.toString('utf8');
        } catch {
          return undefined;
        }
      })),
  };
  for (const path of local) {
    const old = baseline.get(path),
      observed = captureFile(root, path, directory, old, index, text, cache);
    // A directory's stat does not move with its HEAD; submodules are never vouched for by it.
    if (!observed.stat.isDirectory()) observedStats.set(path, statEntry(observed.stat, observed.file.blob));
    if (observed.changed) {
      if (observed.markers) marked.push(path);
      const baseBlob = bases[path] ?? guess(path) ?? old?.blob ?? digest('');
      bases[path] = baseBlob;
      const code = sketchCodePath(path);
      let base =
        baseBlob === digest('')
          ? overlapTextSketch(Buffer.alloc(0), code)
          : readOverlapText(cache, baseBlob, false, code);
      // A base sketch cached by an older client lacks export facts: derive it again within the budget.
      if (code && observed.text && base && !base.exports)
        base = links.budget.run(() => readOverlapText(cache, baseBlob, true)) ?? base;
      // Go, Python, Rust, Java, C# and the rest: matched by package, with changed names where facts exist.
      const packageLinks =
        !code && observed.text && packageFactFile(path)
          ? packageSymbolLinks(
              path,
              baseBlob === digest('')
                ? null
                : { text: readOverlapBytes(cache, baseBlob)?.toString('utf8'), key: baseBlob },
              { text: observed.text.toString('utf8'), key: observed.pin.sha256 },
              packageContext,
            )
          : undefined;
      // One alignment serves the evidence and the file's +/- counts (c2388099); a submodule pointer has no lines.
      const edits = sketchEdits(base, observed.sketch ?? null);
      const evidence = overlapTextEvidence(
        baseBlob,
        base,
        observed.sketch ?? null,
        code,
        observed.text ? { ...links, path, text: observed.text.toString('utf8') } : undefined,
        packageLinks,
        edits,
      );
      const lines =
        observed.file.mode === 'gitlink' || old?.mode === 'gitlink'
          ? undefined
          : overlapLineCounts(baseBlob, edits);
      changes.push({
        ...(evidence ? { evidence } : {}),
        ...(lines ? { lines } : {}),
        path,
        before: old ? { blob: old.blob, mode: old.mode } : null,
        after: { ...observed.file, content: { object: observed.pin, recipe: null } },
      });
      files.push({ pin: observed.pin, path: observed.pin.sha256 });
      // The bytes were already read by captureFile. Store its compact sketch, never reread them.
      if (observed.sketch) rememberOverlapSketch(cache, observed.pin.sha256, observed.sketch);
    }
  }
  if (!preserveConflicts)
    assertNoConflictMarkers(root, marker.selection.laneId, marked, resolving, continuation);
  if (changes.length) rememberOverlapBases(cache, marker.selection.laneId, marker.selection.base.head, bases);
  const machine = machineObjectsDirectory();
  for (const file of files) await rememberObject(machine, join(directory, file.path), file.pin.sha256);
  const present = new Set(local);
  // A deleted file's count reads its retained base bytes once; past this many bytes a save counts no more deletions.
  let deletedBytes = 0;
  for (const path of marker.materialized)
    if (!forgeCachePath(path) && !present.has(path)) {
      const old = baseline.get(path)!;
      const baseBlob = bases[path] ?? guess(path) ?? old.blob;
      const counted =
        old.mode !== 'gitlink' && baseBlob !== digest('') && deletedBytes < DELETED_COUNT_BYTES
          ? deletedLineCounts(cache, baseBlob)
          : null;
      if (counted) deletedBytes += counted.bytes;
      changes.push({
        ...(counted ? { lines: counted.lines } : {}),
        path,
        before: { blob: old.blob, mode: old.mode },
        after: null,
      });
    }
  // Capture is retry state, never a Work owner or a Lane publication.
  const excluded = checked.excluded;
  const result = { marker, changes, files, ...(excluded ? { notSaved: excluded } : {}) };
  mkdirSync(clientCacheRoot(root), { recursive: true, mode: 0o700 });
  neverIndex(clientCacheRoot(root));
  writeCheckoutStatIndex(root, since, observedStats);
  return workLocked(join(clientCacheRoot(root), 'lock'), () => {
    const path = join(directory, 'capture.json');
    if (checkoutPathExists(path)) return JSON.parse(readFileSync(path, 'utf8')) as typeof result;
    settlePendingCheckoutDelta(root);
    invariant(
      canonicalPayload(readHostedLaneCheckout(root)) === canonicalPayload(marker),
      'WORK_STALE',
      'Checkout baseline changed during save preparation.',
    );
    if (sync && !changes.length) return result;
    // Kept after the save settles (capture.json is dropped then), so a replayed receipt repeats it.
    if (excluded) durableReplace(join(directory, notSavedFile), JSON.stringify(excluded));
    durableReplace(path, JSON.stringify(result));
    return result;
  });
}
