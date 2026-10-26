// SPDX-License-Identifier: Apache-2.0
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { sourceRealpath } from './files.js';
import { ForgeError, invariant } from './errors.js';

/** Atomic replacement changes the pathname and the old inode's link count, not
 * its bytes. Read one open descriptor instead of chasing a moving work.json.
 * Source capture's stricter pathname check remains separate. */
export function readWorkPointer(directory: string): Buffer | null {
  const path = join(directory, 'work.json');
  try {
    if (lstatSync(path).isSymbolicLink()) return null;
    const contained = relative(directory, sourceRealpath(path));
    invariant(
      contained !== '..' && !contained.startsWith(`..${sep}`) && !isAbsolute(contained),
      'UNSAFE_PATH',
      'Work pointer escapes its owner.',
    );
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink > 1) return null;
      const read = () => {
        const buffer = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const count = readSync(fd, buffer, length, buffer.length - length, length);
          if (!count) break;
          length += count;
        }
        return buffer.subarray(0, length);
      };
      const bytes = read(),
        after = fstatSync(fd);
      const stable = (a: typeof before, b: typeof before) =>
        a.size === b.size &&
        a.mode === b.mode &&
        b.nlink <= 1 &&
        a.dev === b.dev &&
        a.ino === b.ino &&
        a.mtimeMs === b.mtimeMs;
      invariant(
        stable(before, after) && bytes.length === after.size,
        'SOURCE_CHANGED',
        'Work pointer changed while being read.',
      );
      if (before.ctimeMs !== after.ctimeMs) {
        // Rename and subsequent unlink can each update ctime on Linux. Confirm
        // exact bytes and content metadata on the same descriptor; ctime alone
        // does not mean its content changed.
        const repeated = read(),
          final = fstatSync(fd);
        invariant(
          bytes.equals(repeated) && stable(after, final),
          'SOURCE_CHANGED',
          'Work pointer changed while being read.',
        );
      }
      return bytes;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw new ForgeError('SOURCE_READ_FAILED', 'A Work pointer could not be read safely.');
  }
}
