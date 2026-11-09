// SPDX-License-Identifier: Apache-2.0
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  chmodSync,
  constants,
  realpathSync,
  existsSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { chmod, copyFile, open, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { checkoutIo } from './checkout-io.js';
import { mapExchange } from './exchange-parallel.js';
import { digest } from './hash.js';
import { ForgeError, invariant } from './errors.js';
import { foldedCollisions, type NameFolding, type NativeFile } from './native-state-format.js';
import { fileFlushFlags, syncDirectory, syncFile } from './native-durability.js';
import { fingerprintPrivateFile, readSource } from './files.js';
import { writeSourceLink } from './source-links.js';

/** Unlike existsSync, a dangling symlink still occupies a checkout path. */
export function checkoutPathExists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}
export { cleanHostedCheckout } from './hosted-checkout-clean.js';
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
    writeSourceLink(bytes, target);
  } else {
    // A clone shares blocks until edited (APFS/Btrfs); other filesystems copy.
    copyFileSync(source, target, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    chmodSync(target, file.mode === 'executable' ? 0o755 : 0o644);
    syncFile(target);
  }
}
/** How the volume under `directory` folds names, observed with two probe files that are removed again. */
export function probeNameFolding(directory: string): NameFolding {
  const probe = (lower: string, upper: string) => {
    const path = join(directory, lower);
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
    try {
      return existsSync(join(directory, upper));
    } finally {
      unlinkSync(path);
    }
  };
  const tag = `.forge-fold-${process.pid}-${Date.now().toString(36)}`;
  return {
    caseInsensitive: probe(`${tag}-a`, `${tag}-A`),
    // "é" as one code point versus as "e" plus a combining accent.
    unicodeInsensitive: probe(`${tag}-\u00e9`, `${tag}-e\u0301`),
  };
}
/** Refuse a State whose paths would share a name on this volume, before anything is written. */
export function refuseFoldedCollisions(directory: string, files: readonly { path: string }[]) {
  const collisions = foldedCollisions(files, probeNameFolding(directory));
  invariant(
    collisions.length === 0,
    'INVALID_NATIVE_SOURCE',
    `Source paths share one name on this volume (case or Unicode folding): ${collisions.slice(0, 3).join(', ')}${collisions.length > 3 ? ', …' : ''}.`,
  );
}
/** Place a whole State into an empty directory: refuse folded name collisions, create every directory
 * and check it resolves inside the root, install regular files, and only then the links. A link is
 * never in place while a file is written, and nothing is ever written through one. */
export function installHostedCheckout(
  checkout: string,
  objects: string,
  files: readonly NativeFile[],
  interrupt?: () => void,
) {
  mkdirSync(checkout, { recursive: true });
  refuseFoldedCollisions(checkout, files);
  const root = realpathSync(checkout);
  const verified = new Set<string>();
  for (const file of [
    ...files.filter(file => file.mode !== 'symlink'),
    ...files.filter(file => file.mode === 'symlink'),
  ]) {
    interrupt?.();
    const directory = dirname(file.path);
    if (!verified.has(directory)) {
      const path = join(checkout, directory);
      mkdirSync(path, { recursive: true });
      invariant(
        realpathSync(path) === join(root, directory),
        'UNSAFE_PATH',
        'Checkout directories must be real.',
      );
      verified.add(directory);
    }
    installHostedFile(checkout, objects, file);
  }
}
/** Stage all copies before flushing them. Interleaving clone/chmod with fsync
 * repeatedly commits filesystem metadata; separate bounded passes let it coalesce.
 * Every regular file is still verified and durable before the caller installs. */
export async function installHostedFiles(stage: string, objects: string, files: NativeFile[]) {
  await stageHostedFiles(stage, objects, files);
  await flushHostedFiles(stage, files);
}

/** Build independent, verified files while the whole staging tree stays private.
 * With `damaged`, a source that is missing or fails its digest is collected for
 * repair instead of failing the open; nothing unverified stays in the stage. */
export async function stageHostedFiles(
  stage: string,
  objects: string,
  files: NativeFile[],
  damaged?: NativeFile[],
) {
  await checkoutIo(async () => {
    for (const directory of new Set(files.map(file => dirname(join(stage, file.path)))))
      mkdirSync(directory, { recursive: true });
    mkdirSync(stage, { recursive: true });
    refuseFoldedCollisions(stage, files);
  });
  await mapExchange(files, 16, async file => {
    const target = join(stage, file.path),
      source = join(objects, file.blob);
    try {
      if (file.mode === 'symlink')
        return await checkoutIo(async () => installHostedFile(stage, objects, file));
      await checkoutIo(() => copyFile(source, target, constants.COPYFILE_FICLONE));
      // The shared machine cache can change between discovery and this clone.
      // Authenticate the independent installed inode before exposing it writable.
      invariant(
        (await checkoutIo(() => fingerprintPrivateFile(target, 'INVALID_NATIVE_SOURCE'))).sha256 ===
          file.blob,
        'INVALID_NATIVE_SOURCE',
        'Cloned source differs from the selected content.',
      );
    } catch (error) {
      const code = error instanceof ForgeError ? error.code : (error as NodeJS.ErrnoException).code;
      if (!damaged || !['INVALID_NATIVE_SOURCE', 'ENOENT'].includes(code ?? '')) throw error;
      await checkoutIo(() => rm(target, { force: true }));
      damaged.push(file);
      return;
    }
    await checkoutIo(() => chmod(target, file.mode === 'executable' ? 0o755 : 0o644));
  });
}

/** Every selected regular file receives its own durability barrier. */
export async function flushHostedFiles(stage: string, files: NativeFile[]) {
  await mapExchange(
    files.filter(file => file.mode !== 'symlink'),
    16,
    async file => {
      const target = join(stage, file.path);
      const handle = await checkoutIo(() => open(target, fileFlushFlags()), 'durability');
      try {
        await checkoutIo(() => handle.sync(), 'durability');
      } finally {
        await checkoutIo(() => handle.close(), 'durability');
      }
    },
  );
}
/** Flush every directory. A private stage's manifest already names its complete
 * directory set, so it needs no second readdir/lstat walk of every source file. */
export async function flushHostedCheckoutFiles(directory: string, files?: readonly { path: string }[]) {
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
  if (process.platform === 'win32') return;
  await mapExchange(directories, 16, async path => {
    const handle = await checkoutIo(() => open(path, 'r'), 'durability');
    try {
      // oxlint-disable-next-line forge/no-readonly-fsync -- POSIX directory fsync; Windows returned above.
      await checkoutIo(() => handle.sync(), 'durability');
    } finally {
      await checkoutIo(() => handle.close(), 'durability');
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
