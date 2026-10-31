// SPDX-License-Identifier: Apache-2.0
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  copyFileSync,
  chmodSync,
  symlinkSync,
  constants,
} from 'node:fs';
import { chmod, copyFile, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mapExchange } from './exchange-parallel.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import type { NativeFile } from './native-state-format.js';
import { syncDirectory, syncFile } from './native-durability.js';

/** Unlike existsSync, a dangling symlink still occupies a checkout path. */
export function checkoutPathExists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
/** Compare link bytes without ever following the target. Preserve every local difference. */
export function cleanHostedCheckout(root: string, files: NativeFile[], markerName: string, marked: boolean) {
  if (!checkoutPathExists(root)) return;
  const rootStat = lstatSync(root);
  invariant(
    rootStat.isDirectory() && !rootStat.isSymbolicLink(),
    'UNSAFE_PATH',
    'Checkout directory must be real.',
  );
  const allowed = new Map(files.map(file => [file.path, file]));
  function visit(directory: string) {
    for (const entry of readdirSync(join(root, directory))) {
      const path = directory ? `${directory}/${entry}` : entry;
      const stat = lstatSync(join(root, path));
      if (path === '.forge') {
        invariant(
          marked &&
            stat.isDirectory() &&
            !stat.isSymbolicLink() &&
            readdirSync(join(root, path)).every(name => name === markerName),
          'WORK_CONFLICT',
          'Existing Forge metadata is preserved.',
        );
        continue;
      }
      const file = allowed.get(path);
      if (!file && stat.isDirectory()) {
        visit(path);
        continue;
      }
      const bytes = stat.isSymbolicLink()
        ? readlinkSync(join(root, path), { encoding: 'buffer' })
        : stat.isFile() && stat.nlink === 1
          ? readFileSync(join(root, path))
          : null;
      invariant(
        file &&
          bytes &&
          digest(bytes) === file.blob &&
          (stat.isSymbolicLink()
            ? file.mode === 'symlink'
            : file.mode !== 'symlink' && Boolean(stat.mode & 0o111) === (file.mode === 'executable')),
        'WORK_CONFLICT',
        'Local checkout changes are preserved.',
      );
      allowed.delete(path);
    }
  }
  visit('');
  invariant(!allowed.size, 'WORK_CONFLICT', 'Local checkout deletions are preserved.');
}
export function installHostedFile(stage: string, objects: string, file: NativeFile) {
  const target = join(stage, file.path),
    source = join(objects, file.blob);
  mkdirSync(dirname(target), { recursive: true });
  if (file.mode === 'symlink') {
    const bytes = readFileSync(source);
    invariant(
      bytes.length > 0 && !bytes.includes(0),
      'INVALID_NATIVE_SOURCE',
      'Source link target is invalid.',
    );
    symlinkSync(bytes, target);
  } else {
    // A clone shares blocks until edited (APFS/Btrfs); other filesystems copy.
    copyFileSync(source, target, constants.COPYFILE_FICLONE);
    chmodSync(target, file.mode === 'executable' ? 0o755 : 0o644);
    syncFile(target);
  }
}
/** Same result as installHostedFile per file, with bounded concurrent clone/chmod/fsync:
 * per-file latency, not bandwidth, dominates trees of tens of thousands of files. */
export async function installHostedFiles(stage: string, objects: string, files: NativeFile[]) {
  for (const directory of new Set(files.map(file => dirname(join(stage, file.path)))))
    mkdirSync(directory, { recursive: true });
  await mapExchange(files, 16, async file => {
    const target = join(stage, file.path),
      source = join(objects, file.blob);
    if (file.mode === 'symlink') return installHostedFile(stage, objects, file);
    await copyFile(source, target, constants.COPYFILE_FICLONE);
    await chmod(target, file.mode === 'executable' ? 0o755 : 0o644);
    const handle = await open(target, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}
/** flushHostedCheckout with concurrent directory fsyncs. */
export async function flushHostedCheckoutFiles(directory: string) {
  const directories: string[] = [];
  const walk = (path: string) => {
    directories.push(path);
    for (const name of readdirSync(path)) {
      const child = join(path, name),
        stat = lstatSync(child);
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(child);
    }
  };
  walk(directory);
  if (process.platform === 'win32') return;
  await mapExchange(directories, 16, async path => {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}
export function flushHostedCheckout(directory: string) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name),
      stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) flushHostedCheckout(path);
  }
  syncDirectory(directory);
}
