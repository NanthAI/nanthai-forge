// SPDX-License-Identifier: Apache-2.0
import { open } from 'node:fs/promises';
import { visitCheckoutFiles, withCheckoutFileBatch } from './checkout-file-batch.js';

/** Every inode still receives fsync. Admission is amortized over a finite,
 * directory-local traversal rather than repeated for each inode. The existing
 * sixteen-file window pipelines syscalls under the unchanged worker ceiling. */
export function flushCheckoutPaths(stage: string, paths: Iterable<string>) {
  return visitCheckoutFiles(stage, 'durability', paths, async (path, io) => {
    const handle = await io(() => open(path, 'r'));
    try {
      await io(() => handle.sync());
    } finally {
      await io(() => handle.close());
    }
  });
}

/** Serialize metadata publication with file traversals, without holding an I/O
 * worker while waiting for the batch. Every mutation still uses its own worker. */
export function withCheckoutDurabilityBatch<T>(stage: string, run: () => Promise<T>) {
  return withCheckoutFileBatch(stage, run);
}
