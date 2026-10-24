// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readSource, safeRelative } from './files.js';
import { invariant } from './errors.js';

/** Read the link itself, never its target; reject redirected parent directories. */
export function nativeFile(root: string, path: string) {
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
  const bytes = readSource(root, path, Number.MAX_SAFE_INTEGER);
  invariant(bytes, 'SOURCE_CHANGED', 'Source disappeared while capturing.');
  return { bytes, mode: stat.mode & 0o111 ? ('executable' as const) : ('file' as const) };
}
