// SPDX-License-Identifier: Apache-2.0
import { digest } from './portable-hash.js';
import { canonicalPayload } from './hosted-source-operation.js';
import type { NativeFile } from './native-state-format.js';

/** Source identity excludes State ancestry, message and time, and includes paths, modes and blobs.
 * Compute while publishing local checkout metadata; landing only compares the cached field. */
export function sourceTree(files: NativeFile[]): string {
  return digest(
    canonicalPayload([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))),
  );
}
