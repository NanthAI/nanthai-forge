// SPDX-License-Identifier: Apache-2.0
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cloneNativePath } from './native-clone.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { mkdirBelow } from './mkdir-below.js';
import { nativeFile } from './native-file.js';
import { syncDirectory, syncFile } from './native-durability.js';
import { workLocked, workLockWaitMs } from './work-lock.js';
import { writeRecoveryState } from './recovery-state.js';
import type { NativeSource, NativeFile } from './native-source.js';

/** Check the entire cloned tree, including unexpected/ignored entries. Cache
 * permissions and timestamps are never proof: a clone cannot inherit an edit. */
function verifyTree(root: string, files: NativeFile[]) {
  const expected = new Map(files.map(file => [file.path, file]));
  const directories = new Set<string>();
  for (const file of files)
    for (let index = file.path.indexOf('/'); index !== -1; index = file.path.indexOf('/', index + 1))
      directories.add(file.path.slice(0, index));
  function walk(directory: string) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        invariant(
          directories.has(path),
          'INVALID_NATIVE_SOURCE',
          'Cached source contains an unexpected directory.',
        );
        walk(path);
      } else {
        const file = expected.get(path);
        invariant(file, 'INVALID_NATIVE_SOURCE', 'Cached source contains an unexpected path.');
        const actual = nativeFile(root, path);
        invariant(
          actual.mode === file.mode && digest(actual.bytes) === file.blob,
          'INVALID_NATIVE_SOURCE',
          'Cached source differs from its pinned State.',
        );
        if (file.mode !== 'symlink') chmodSync(join(root, path), file.mode === 'executable' ? 0o700 : 0o600);
        expected.delete(path);
      }
    }
  }
  invariant(
    lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(),
    'UNSAFE_PATH',
    'Cache tree is redirected.',
  );
  walk('');
  invariant(!expected.size, 'INVALID_NATIVE_SOURCE', 'Cached source is incomplete.');
}

/** One disposable tree per owner, not one full tree per historical State. Only
 * this cache's lock is held while copying; the owner writer lock is never used. */
export function cloneLaneTree(source: NativeSource, head: string, destination: string) {
  const files = source.state(head).files,
    tree = source.tree(files),
    directory = join(source.owner, '.forge/work/lane-source-cache');
  mkdirBelow(source.owner, directory);
  invariant(!lstatSync(directory).isSymbolicLink(), 'UNSAFE_PATH', 'Source cache is redirected.');
  return workLocked(
    join(directory, 'lock'),
    () => {
      const path = join(directory, 'tree'),
        pointer = join(directory, 'tree.json');
      let cached: { tree?: string } | undefined;
      try {
        cached = JSON.parse(readFileSync(pointer, 'utf8')) as { tree?: string };
      } catch {
        /* Rebuild disposable cache. */
      }
      const rebuild = () => {
        rmSync(path, { recursive: true, force: true });
        // This non-Lane destination uses ordinary, digest-verified materialization.
        // It creates byte-only templates, never copying metadata from stored blobs.
        source.materialize(head, path, false);
        const flush = (directory: string) => {
          for (const name of readdirSync(directory)) {
            const entry = join(directory, name),
              stat = lstatSync(entry);
            if (stat.isDirectory()) flush(entry);
            else if (!stat.isSymbolicLink()) syncFile(entry);
          }
          syncDirectory(directory);
        };
        flush(path);
        writeRecoveryState(pointer, { tree });
      };
      if (
        cached?.tree !== tree ||
        !existsSync(path) ||
        !lstatSync(path).isDirectory() ||
        lstatSync(path).isSymbolicLink()
      )
        rebuild();
      try {
        const result = cloneNativePath(path, destination, true);
        verifyTree(destination, files);
        return result;
      } catch (error) {
        rmSync(destination, { recursive: true, force: true });
        // An edited/missing cache is disposable. Rebuild from the same exact pin;
        // IO failures retain their original error instead of hiding them as misses.
        if (
          !['INVALID_NATIVE_SOURCE', 'SOURCE_CHANGED', 'UNSAFE_PATH', 'ENOENT'].includes(
            (error as { code?: string }).code ?? '',
          )
        )
          throw error;
        rebuild();
        const result = cloneNativePath(path, destination, true);
        verifyTree(destination, files);
        return result;
      }
    },
    { operation: 'Lane source cache', waitMs: workLockWaitMs() },
  );
}
