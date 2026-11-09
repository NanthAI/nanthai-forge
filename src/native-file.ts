// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readSource, safeRelative } from './files.js';
import { invariant } from './errors.js';
import { gitlinkDirectory, gitlinkDirectoryPointer } from './gitlink-workspace.js';
import { regularFileMode } from './file-mode.js';
import type { NativeFile } from './native-state-format.js';
import { linkFallback } from './source-links.js';

/** Read the link itself, never its target; reject redirected parent directories. */
export function nativeFile(root: string, path: string, recorded?: NativeFile['mode']) {
  invariant(safeRelative(path), 'UNSAFE_PATH', 'Source paths must be relative.');
  let parent = root;
  for (const part of path.split('/').slice(0, -1)) {
    parent = join(parent, part);
    const stat = lstatSync(parent);
    invariant(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_PATH', 'Source parent is redirected.');
  }
  const full = join(root, path),
    stat = lstatSync(full);
  if (stat.isSymbolicLink())
    return { bytes: readlinkSync(full, { encoding: 'buffer' }), mode: 'symlink' as const };
  // Windows without link rights holds a recorded link as a file of its target (source-links.ts).
  if (linkFallback(stat, recorded)) {
    const target = readSource(root, path, Number.MAX_SAFE_INTEGER);
    invariant(target, 'SOURCE_CHANGED', 'Source disappeared while capturing.');
    return { bytes: target, mode: 'symlink' as const };
  }
  // A checked-out submodule stands for its pointer: the commit its HEAD names.
  if (stat.isDirectory() && gitlinkDirectory(root, path))
    return { bytes: gitlinkDirectoryPointer(root, path), mode: 'gitlink' as const };
  const bytes = readSource(root, path, Number.MAX_SAFE_INTEGER);
  invariant(bytes, 'SOURCE_CHANGED', 'Source disappeared while capturing.');
  return { bytes, mode: regularFileMode(stat.mode, recorded) };
}
