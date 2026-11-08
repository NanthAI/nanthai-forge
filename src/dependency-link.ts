// SPDX-License-Identifier: Apache-2.0
import { lstatSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};
const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Link a Lane to the machine's install. Without workspaces that is one `node_modules` symlink.
 * With workspaces, links into a sibling workspace package must reach the Lane's own source, not
 * the cached manifest-only copy: the root `node_modules` (npm) and, for pnpm, Yarn and bun, each
 * package's own become real directories of per-entry symlinks, and workspace links are
 * re-pointed (relative) at the Lane. A `node_modules` the Lane already has is left alone. */
export function linkInstall(entry: string, root: string, folders: string[]): void {
  const sources = new Map(folders.map(folder => [real(join(entry, folder)), join(root, folder)]));
  const overlay = (from: string, to: string) => {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      const source = join(from, name),
        target = join(to, name),
        stat = lstatSync(source);
      if (name.startsWith('@') && stat.isDirectory()) overlay(source, target);
      else if (stat.isSymbolicLink()) {
        const resolved = real(source),
          workspace = resolved ? sources.get(resolved) : undefined;
        symlinkSync(workspace ? relative(dirname(target), workspace) : source, target);
      } else symlinkSync(source, target, stat.isDirectory() ? 'dir' : 'file');
    }
  };
  for (const folder of ['', ...folders]) {
    const from = join(entry, folder, 'node_modules'),
      to = join(root, folder, 'node_modules');
    if (!exists(from) || exists(to) || !exists(join(root, folder))) continue;
    if (!folders.length) symlinkSync(from, to, 'dir');
    else overlay(from, to);
  }
}
