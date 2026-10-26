// SPDX-License-Identifier: Apache-2.0
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, unlinkSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { childEnv } from '../scripts/child-env.mjs';
import { dirname, join } from 'node:path';
import { cloneNativePath, type NativeClone } from './native-clone.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { syncDirectory, syncFile } from './native-durability.js';
import type { NativeSource } from './native-source.js';

/** A snapshot is already a logical clone of its parent's manifest. Clone only
 * newly changed regular blobs, retaining unchanged objects and symlink bytes.
 * Verify after cloning: editors need not obey our Lane lock. */
export function snapshotBlob(
  source: NativeSource,
  path: string,
  bytes: Buffer,
  symlink: boolean,
): { blob: string; storage?: NativeClone } {
  const blob = digest(bytes),
    target = join(source.directory, blob);
  if (existsSync(target) || symlink) return { blob: source.put(bytes) };
  const temporary = join(source.directory, `${randomUUID()}.tmp`);
  try {
    const storage = cloneNativePath(path, temporary);
    if (!lstatSync(temporary).isFile() || digest(readFileSync(temporary)) !== blob) {
      // Source changed during clone. Retain the exact bytes captured earlier,
      // never an edit from a different instant or the symlink's target bytes.
      return { blob: source.put(bytes), storage: { method: 'copy', reason: 'source-changed-during-clone' } };
    }
    // cp -c cannot combine with -X. Clear metadata on the private clone only;
    // immutable/quarantine flags and ACLs from a live editor file never enter
    // native objects. Unavailable normalizers fall back to fresh captured bytes.
    if (process.platform === 'darwin') {
      try {
        const options = { env: childEnv(), stdio: 'pipe' as const };
        execFileSync('/usr/bin/chflags', ['0', temporary], options);
        execFileSync('/usr/bin/xattr', ['-c', temporary], options);
        execFileSync('/bin/chmod', ['-N', temporary], options);
      } catch {
        return {
          blob: source.put(bytes),
          storage: { method: 'copy', reason: 'clone-metadata-normalization-unavailable' },
        };
      }
    }
    chmodSync(temporary, 0o600);
    syncFile(temporary);
    if (existsSync(target)) {
      invariant(source.object(blob).equals(bytes), 'INVALID_NATIVE_SOURCE', 'Snapshot object changed.');
      unlinkSync(temporary);
    } else renameSync(temporary, target);
    syncDirectory(dirname(target));
    return { blob, storage };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
