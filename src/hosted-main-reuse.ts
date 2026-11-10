// SPDX-License-Identifier: Apache-2.0
import {
  chmodSync,
  constants,
  copyFileSync,
  mkdtempSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { checkoutPathExists } from './hosted-checkout-files.js';
import type { NativeFile } from './state/format.js';
/** Verified checkout source is also a cache. Evicting objects must never force a
 * refresh to download unchanged source. Installation verifies these clones again.
 * Publish independent cache copies atomically, including concurrent/retried pulls. */
export function reuseMainSource(root: string, objects: string, before: NativeFile[], after: NativeFile[]) {
  const local = new Map(before.map(file => [file.blob, file]));
  const temporary = mkdtempSync(join(dirname(objects), 'reuse-'));
  try {
    for (const file of after) {
      const saved = local.get(file.blob),
        target = join(objects, file.blob);
      if (!saved || checkoutPathExists(target)) continue;
      const stage = join(temporary, file.blob);
      if (saved.mode === 'symlink')
        writeFileSync(stage, readlinkSync(join(root, saved.path), { encoding: 'buffer' }), {
          mode: 0o600,
          flag: 'wx',
        });
      else {
        copyFileSync(join(root, saved.path), stage, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
        chmodSync(stage, 0o600);
      }
      renameSync(stage, target);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
