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
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { gitlinkCommit } from './gitlink.js';
import { gitlinkDirectoryPointer } from './gitlink-workspace.js';
import { digest } from './hash.js';
import { readSource } from './files.js';
import { scanSourcePaths } from './source-paths.js';
import { notSavedCollector, notSavedFile } from './save-not-saved.js';
import { durableReplace, syncFile } from './native-durability.js';
import { invariant } from './errors.js';
import type { NativeFile } from './native-state-format.js';
import type { SaveChange } from './hosted-save.js';
import {
  rememberOverlapSketch,
  readOverlapText,
  readOverlapBytes,
  overlapTextSketch,
  sketchCodePath,
  overlapTextEvidence,
  overlapBaseBlobs,
  rememberOverlapBases,
} from './hosted-overlap-text.js';
import { outputRoots, SymbolBudget } from './hosted-overlap-symbols.js';
import { packageFactFile, packageSymbolLinks } from './hosted-overlap-packages.js';
import { buildPackageGraph, type PackageGraph } from './package-graph.js';
import { workLocked } from './work-lock.js';
import { finishPendingCheckoutDelta, settlePendingCheckoutDelta } from './hosted-checkout-delta-pending.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { forgeCachePath } from './forge-cache-paths.js';
import { neverIndex } from './forge-disk.js';
import { machineObjectsDirectory, rememberObject } from './machine-object-store.js';
import {
  indexedBlob,
  readCheckoutStatIndex,
  statEntry,
  writeCheckoutStatIndex,
  type CheckoutStatIndex,
} from './checkout-stat-index.js';
import { diskMode } from './source-links.js';

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
    bytes: Buffer | null = null;
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
export async function captureHostedSave(
  root: string,
  directory: string,
  preserveConflicts = false,
  continuation?: ConflictContinuation,
) {
  root = realpathSync(root);
  // An interrupted sync leaves a half-applied tree under the old marker; capture only a whole one.
  finishPendingCheckoutDelta(root);
  const marker = readHostedLaneCheckout(root);
  invariant(marker, 'NOT_FOUND', 'Open a hosted Lane before preparing a save.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const since = Date.now(),
    index = readCheckoutStatIndex(root),
    observedStats = new Map<string, ReturnType<typeof statEntry>>(),
    cache = clientCacheRoot(root),
    bases = overlapBaseBlobs(cache, marker.selection.base.head);
  const baseline = new Map(marker.state.files.map(file => [file.path, file])),
    notSaved = notSavedCollector(),
    local = scanSourcePaths(root, { retained: [...baseline.keys()], onExcluded: notSaved.onExcluded });
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
  for (const path of local.sort()) {
    const old = baseline.get(path),
      observed = captureFile(root, path, directory, old, index);
    // A directory's stat does not move with its HEAD; submodules are never vouched for by it.
    if (!observed.stat.isDirectory()) observedStats.set(path, statEntry(observed.stat, observed.file.blob));
    if (observed.changed) {
      if (observed.markers) marked.push(path);
      const baseBlob = bases[path] ?? old?.blob ?? digest('');
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
      const evidence = overlapTextEvidence(
        baseBlob,
        base,
        observed.sketch ?? null,
        code,
        observed.text ? { ...links, path, text: observed.text.toString('utf8') } : undefined,
        packageLinks,
      );
      changes.push({
        ...(evidence ? { evidence } : {}),
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
  if (changes.length) rememberOverlapBases(cache, marker.selection.base.head, bases);
  const machine = machineObjectsDirectory();
  for (const file of files) await rememberObject(machine, join(directory, file.path), file.pin.sha256);
  const present = new Set(local);
  for (const path of marker.materialized)
    if (!forgeCachePath(path) && !present.has(path)) {
      const old = baseline.get(path)!;
      changes.push({ path, before: { blob: old.blob, mode: old.mode }, after: null });
    }
  // Capture is retry state, never a Work owner or a Lane publication.
  const excluded = notSaved.value();
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
    // Kept after the save settles (capture.json is dropped then), so a replayed receipt repeats it.
    if (excluded) durableReplace(join(directory, notSavedFile), JSON.stringify(excluded));
    durableReplace(path, JSON.stringify(result));
    return result;
  });
}
