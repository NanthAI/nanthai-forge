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
  realpathSync,
} from 'node:fs';
import { chmod, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { checkoutIo } from './checkout-io.js';
import { flushCheckoutPaths } from './checkout-durability.js';
import { visitCheckoutFiles, withCheckoutFileBatch } from './checkout-file-batch.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import type { NativeFile } from './native-state-format.js';
import { syncDirectory, syncFile } from './native-durability.js';
import { fingerprintPrivateFile, readSource } from './files.js';
import { preserveLegacyCacheUse } from './client-cache-use.js';

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
          marked && stat.isDirectory() && !stat.isSymbolicLink(),
          'WORK_CONFLICT',
          'Existing Forge metadata at ".forge" is preserved.',
        );
        for (const name of readdirSync(join(root, path)))
          invariant(
            name === markerName || (name === 'cache-use.json' && preserveLegacyCacheUse(root)),
            'WORK_CONFLICT',
            `Existing Forge metadata at ${JSON.stringify(`${path}/${name}`)} is preserved.`,
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
        `Local checkout changes at ${JSON.stringify(path)} are preserved.`,
      );
      allowed.delete(path);
    }
  }
  visit('');
  invariant(
    !allowed.size,
    'WORK_CONFLICT',
    `Local checkout deletion at ${JSON.stringify(allowed.keys().next().value)} is preserved.`,
  );
}
export function installHostedFile(stage: string, objects: string, file: NativeFile) {
  const target = join(stage, file.path),
    source = join(objects, file.blob);
  mkdirSync(dirname(target), { recursive: true });
  if (file.mode === 'symlink') {
    const bytes = readSource(realpathSync(objects), file.blob, Number.MAX_SAFE_INTEGER, file.blob);
    invariant(
      bytes && digest(bytes) === file.blob && bytes.length > 0 && !bytes.includes(0),
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
/** Stage all copies before flushing them. Interleaving clone/chmod with fsync
 * repeatedly commits filesystem metadata; separate bounded passes let it coalesce.
 * Every regular file is still verified and durable before the caller installs. */
export async function installHostedFiles(stage: string, objects: string, files: NativeFile[]) {
  await withCheckoutFileBatch(
    stage,
    async () => {
      await stageHostedFiles(stage, objects, files);
      await flushHostedFiles(stage, files);
    },
    files.length,
  );
}

/** Build independent, verified files while the whole staging tree stays private. */
export async function stageHostedFiles(stage: string, objects: string, files: NativeFile[]) {
  await checkoutIo(async () => {
    for (const directory of new Set(files.map(file => dirname(join(stage, file.path)))))
      mkdirSync(directory, { recursive: true });
  });
  await visitCheckoutFiles(stage, 'copy', files, async (file, io) => {
    const target = join(stage, file.path),
      source = join(objects, file.blob);
    if (file.mode === 'symlink') return io(async () => installHostedFile(stage, objects, file));
    // Pipeline the existing bounded file window, without per-file phase changes.
    await io(() => copyFile(source, target, constants.COPYFILE_FICLONE));
    invariant(
      (await io(() => fingerprintPrivateFile(target, 'INVALID_NATIVE_SOURCE'))).sha256 === file.blob,
      'INVALID_NATIVE_SOURCE',
      'Cloned source differs from the selected content.',
    );
    await io(() => chmod(target, file.mode === 'executable' ? 0o755 : 0o644));
  });
}

/** Batch the durability pass after all clones/chmods. Every file continuation
 * closes its descriptor before a finite FIFO turn can yield.
 * File fsync is required even after cloning durable cache bytes: directory
 * fsync alone cannot guarantee new inode contents on all supported filesystems. */
function* regularPaths(stage: string, files: NativeFile[], extra: Iterable<string> = []) {
  for (const file of files) if (file.mode !== 'symlink') yield join(stage, file.path);
  yield* extra;
}
export async function flushHostedFiles(stage: string, files: NativeFile[]) {
  await flushCheckoutPaths(stage, regularPaths(stage, files));
}
/** One traversal owns the regular files, private marker and deduplicated
 * directories. Parallel local passes must not queue against their own batch. */
export async function flushHostedStage(stage: string, files: NativeFile[], extra: Iterable<string> = []) {
  const directories = process.platform === 'win32' ? [] : checkoutDirectories(stage, files);
  await flushCheckoutPaths(
    stage,
    (function* () {
      yield* regularPaths(stage, files, extra);
      yield* directories;
    })(),
  );
}
/** Flush every directory. A private stage's manifest already names its complete
 * directory set, so it needs no second readdir/lstat walk of every source file. */
function checkoutDirectories(directory: string, files?: readonly { path: string }[]) {
  directory = resolve(directory);
  const directories: string[] = [];
  const walk = (path: string) => {
    directories.push(path);
    for (const name of readdirSync(path)) {
      const child = join(path, name),
        stat = lstatSync(child);
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(child);
    }
  };
  if (files) {
    const known = new Set([directory, join(directory, '.forge')]);
    for (const file of files) {
      let path = dirname(join(directory, file.path));
      while (path !== directory) {
        const parent = dirname(path);
        invariant(parent !== path, 'UNSAFE_PATH', 'Stage directories must stay inside the checkout.');
        known.add(path);
        path = parent;
      }
    }
    directories.push(...known);
  } else walk(directory);
  return directories;
}
export async function flushHostedCheckoutFiles(directory: string, files?: readonly { path: string }[]) {
  if (process.platform !== 'win32')
    await flushCheckoutPaths(directory, checkoutDirectories(directory, files));
}
export function flushHostedCheckout(directory: string) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name),
      stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) flushHostedCheckout(path);
  }
  syncDirectory(directory);
}
