// SPDX-License-Identifier: Apache-2.0
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
import { digest } from './hash.js';
import { nativePaths } from './source-paths.js';
import { durableReplace, syncFile } from './native-durability.js';
import { invariant } from './errors.js';
import type { NativeFile } from './native-state-format.js';
import type { SaveChange } from './hosted-save.js';
import { workLocked } from './work-lock.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { forgeCachePath } from './forge-cache-paths.js';
import { neverIndex } from './forge-disk.js';
import { machineObjectsDirectory, rememberObject } from './machine-object-store.js';

/** Small files hash in memory; only changed bytes ever reach the save staging. */
const memoryLimit = 1024 * 1024;
/** Private disk snapshot: bounded buffers, no link target traversal or repository execution.
 * An unchanged file writes nothing; a changed one is staged under its digest, so a save costs
 * only its changed bytes. Changed blobs also go to the machine object store, so a later open of
 * this head on this machine downloads none of them. */
function captureFile(root: string, path: string, directory: string, previous?: NativeFile) {
  const absolute = join(root, path),
    stat = lstatSync(absolute),
    temporary = join(directory, randomUUID());
  const mode: NativeFile['mode'] = stat.isSymbolicLink()
    ? 'symlink'
    : previous?.mode === 'gitlink'
      ? 'gitlink'
      : stat.mode & 0o111
        ? 'executable'
        : 'file';
  let pin: { sha256: string; size: number },
    bytes: Buffer | null = null;
  if (stat.isSymbolicLink()) {
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
  const observed = { file: { blob: pin.sha256, mode }, pin };
  if (previous && previous.blob === pin.sha256 && previous.mode === mode) {
    if (!bytes) rmSync(temporary, { force: true });
    return { ...observed, changed: false };
  }
  if (bytes) writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  const final = join(directory, pin.sha256);
  if (checkoutPathExists(final)) rmSync(temporary);
  else renameSync(temporary, final);
  syncFile(final);
  return { ...observed, changed: true };
}
export async function captureHostedSave(root: string, directory: string) {
  root = realpathSync(root);
  const marker = readHostedLaneCheckout(root);
  invariant(marker, 'NOT_FOUND', 'Open a hosted Lane before preparing a save.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const baseline = new Map(marker.state.files.map(file => [file.path, file])),
    local = nativePaths(root, [...baseline.keys()]);
  const changes: SaveChange[] = [],
    files: { pin: { sha256: string; size: number }; path: string }[] = [];
  for (const path of local.sort()) {
    const old = baseline.get(path),
      observed = captureFile(root, path, directory, old);
    if (observed.changed) {
      changes.push({
        path,
        before: old ? { blob: old.blob, mode: old.mode } : null,
        after: { ...observed.file, content: { object: observed.pin, recipe: null } },
      });
      files.push({ pin: observed.pin, path: observed.pin.sha256 });
    }
  }
  const machine = machineObjectsDirectory();
  for (const file of files) await rememberObject(machine, join(directory, file.path), file.pin.sha256);
  const present = new Set(local);
  for (const path of marker.materialized)
    if (!forgeCachePath(path) && !present.has(path)) {
      const old = baseline.get(path)!;
      changes.push({ path, before: { blob: old.blob, mode: old.mode }, after: null });
    }
  // Capture is retry state, never a Work owner or a Lane publication.
  const result = { marker, changes, files };
  mkdirSync(`${root}.forge-client`, { recursive: true, mode: 0o700 });
  neverIndex(`${root}.forge-client`);
  return workLocked(join(`${root}.forge-client`, 'lock'), () => {
    const path = join(directory, 'capture.json');
    if (checkoutPathExists(path)) return JSON.parse(readFileSync(path, 'utf8')) as typeof result;
    invariant(
      canonicalPayload(readHostedLaneCheckout(root)) === canonicalPayload(marker),
      'WORK_STALE',
      'Checkout baseline changed during save preparation.',
    );
    durableReplace(path, JSON.stringify(result));
    return result;
  });
}
