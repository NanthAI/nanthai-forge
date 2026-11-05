// SPDX-License-Identifier: Apache-2.0
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

// Small-tree qualification uses 2,942 and 28,881 files at N=10. Both dimensions
// must fit: a few large files must not bypass transaction-locality protection.
export const smallCheckoutFiles = 4096;
export const smallCheckoutBytes = 16 * 1024 * 1024;
/** Called under a worker permit after cache verification. Count logical bytes,
 * including repeated blobs; stop as soon as either conservative bound is crossed. */
export function smallCheckout(files: readonly { blob: string }[], objects: string) {
  if (files.length > smallCheckoutFiles) return false;
  let bytes = 0;
  for (const file of files) {
    bytes += lstatSync(join(objects, file.blob)).size;
    if (bytes > smallCheckoutBytes) return false;
  }
  return true;
}
