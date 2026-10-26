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
  readdirSync,
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
import { digest } from './hash.js';
import { exclusion } from './files.js';
import { durableReplace, syncFile } from './native-durability.js';
import { invariant } from './errors.js';
import type { NativeFile } from './native-state-format.js';
import type { SaveChange } from './hosted-save.js';
import { workLocked } from './work-lock.js';
import { canonicalPayload } from './hosted-source-operation.js';

/** Private disk snapshot: bounded buffers, no link target traversal or repository execution. */
function captureFile(root: string, path: string, directory: string) {
  const absolute = join(root, path),
    stat = lstatSync(absolute),
    temporary = join(directory, randomUUID());
  const mode: NativeFile['mode'] = stat.isSymbolicLink()
    ? 'symlink'
    : stat.mode & 0o111
      ? 'executable'
      : 'file';
  let pin: { sha256: string; size: number };
  if (stat.isSymbolicLink()) {
    invariant(
      realpathSync(dirname(absolute)) === dirname(absolute),
      'SOURCE_CHANGED',
      'Source directory changed during capture.',
    );
    const bytes = readlinkSync(absolute, { encoding: 'buffer' });
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
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    pin = { sha256: digest(bytes), size: bytes.length };
  } else {
    invariant(stat.isFile(), 'SOURCE_READ_FAILED', 'Save source must be a regular file or symlink.');
    const source = new SourceFileReader(root, path, 'SOURCE_CHANGED'),
      target = openSync(temporary, 'wx', 0o600);
    try {
      pin = source.scan(bytes => {
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(target, bytes, offset, bytes.length - offset);
      });
      invariant(
        lstatSync(absolute).mode === stat.mode,
        'SOURCE_CHANGED',
        'Source mode changed during capture.',
      );
      fsyncSync(target);
    } finally {
      source.close();
      closeSync(target);
    }
  }
  const final = join(directory, pin.sha256);
  if (checkoutPathExists(final)) rmSync(temporary);
  else renameSync(temporary, final);
  syncFile(final);
  return { file: { blob: pin.sha256, mode }, pin };
}
export async function captureHostedSave(root: string, directory: string) {
  root = realpathSync(root);
  const marker = readHostedLaneCheckout(root);
  invariant(marker, 'NOT_FOUND', 'Open a hosted Lane before preparing a save.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const baseline = new Map(marker.state.files.map(file => [file.path, file])),
    local: string[] = [];
  const retainedDirectories = new Set<string>();
  for (const path of baseline.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) retainedDirectories.add(parts.slice(0, i).join('/'));
  }
  function visit(path: string) {
    for (const name of readdirSync(join(root, path))) {
      const relative = path ? `${path}/${name}` : name;
      if (
        relative
          .toLowerCase()
          .split('/')
          .some(part => part === '.forge' || part === '.git')
      )
        continue;
      const stat = lstatSync(join(root, relative));
      if (!baseline.has(relative) && !retainedDirectories.has(relative) && exclusion(relative)) continue;
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(relative);
      else local.push(relative);
    }
  }
  visit('');
  const changes: SaveChange[] = [],
    files: { pin: { sha256: string; size: number }; path: string }[] = [];
  for (const path of local.sort()) {
    const observed = captureFile(root, path, directory),
      old = baseline.get(path);
    if (!old || old.blob !== observed.file.blob || old.mode !== observed.file.mode) {
      changes.push({
        path,
        before: old ? { blob: old.blob, mode: old.mode } : null,
        after: { ...observed.file, content: { object: observed.pin, recipe: null } },
      });
      files.push({ pin: observed.pin, path: observed.pin.sha256 });
    }
  }
  const present = new Set(local);
  for (const path of marker.materialized)
    if (!present.has(path)) {
      const old = baseline.get(path)!;
      changes.push({ path, before: { blob: old.blob, mode: old.mode }, after: null });
    }
  // Capture is retry state, never a Work owner or a Lane publication.
  const result = { marker, changes, files };
  mkdirSync(`${root}.forge-client`, { recursive: true, mode: 0o700 });
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
