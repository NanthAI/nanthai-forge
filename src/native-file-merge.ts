// SPDX-License-Identifier: Apache-2.0
import type { NativeFile } from './native-state-format.js';
type File = NativeFile | undefined;
const same = (a: File, b: File) => a === b || (!!a && !!b && a.blob === b.blob && a.mode === b.mode);
/** The native merge's metadata-only cases. Null needs content merging or conflict handling;
 * undefined is a proven deletion. Shared by the native worker and bounded V8 composition. */
export function mergeFileMetadata(base: File, left: File, right: File): File | null {
  if (same(left, right)) return left;
  if (same(left, base)) return right;
  if (same(right, base)) return left;
  if (!base || !left || !right) return null;
  if (left.mode !== right.mode && left.mode !== base.mode && right.mode !== base.mode) return null;
  const mode = left.mode === base.mode ? right.mode : left.mode;
  const blob =
    left.blob === base.blob
      ? right.blob
      : right.blob === base.blob || left.blob === right.blob
        ? left.blob
        : null;
  return blob ? { path: left.path, mode, blob } : null;
}
