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
} from 'node:fs';
import { dirname, join } from 'node:path';
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
    copyFileSync(source, target);
    chmodSync(target, file.mode === 'executable' ? 0o755 : 0o644);
    syncFile(target);
  }
}
export function flushHostedCheckout(directory: string) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name),
      stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) flushHostedCheckout(path);
  }
  syncDirectory(directory);
}
