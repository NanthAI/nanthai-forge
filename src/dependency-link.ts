// SPDX-License-Identifier: Apache-2.0
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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

/** Where a symlink really points, even when the last parts do not exist: the cached install holds
 * workspace packages as manifest-only copies, so a bin target like `../lerna/cli.js` dangles there.
 * The longest existing prefix is real-pathed and the missing tail is appended. */
const resolveLoose = (link: string): string | null => {
  let current = resolve(dirname(link), readlinkSync(link)),
    tail = '';
  for (;;) {
    const found = real(current);
    if (found) return join(found, tail);
    const parent = dirname(current);
    if (parent === current) return null;
    tail = join(basename(current), tail);
    current = parent;
  }
};

/** The bins a workspace package declares, from its own (Lane) package.json: name -> file in the package.
 * Repository text is untrusted, so a name with a separator or a file outside the package is ignored. */
function declaredBins(folder: string): [string, string][] {
  let manifest: { name?: unknown; bin?: unknown };
  try {
    manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  const { name, bin } = manifest;
  const entries: [string, unknown][] =
    typeof bin === 'string' && typeof name === 'string'
      ? [[name.split('/').pop()!, bin]]
      : bin && typeof bin === 'object'
        ? Object.entries(bin)
        : [];
  return entries.filter((entry): entry is [string, string] => {
    const [binName, file] = entry;
    if (typeof file !== 'string' || !binName || /[\\/]/.test(binName) || binName.startsWith('.'))
      return false;
    const inside = relative(folder, resolve(folder, file));
    return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
  });
}

/** Link a Lane to the machine's install. Without workspaces that is one `node_modules` symlink.
 * With workspaces, links into a sibling workspace package must reach the Lane's own source, not
 * the cached manifest-only copy: the root `node_modules` (npm) and, for pnpm, Yarn and bun, each
 * package's own become real directories of per-entry symlinks, and workspace links are
 * re-pointed (relative) at the Lane. `.bin` is overlaid the same way, so a bin that the cache links
 * into a workspace package runs the Lane's file, while third-party bins stay shared (a pnpm shell
 * shim is copied, since it locates its package from its own path). The install
 * was made from manifests alone, so a manager may have written no bin for a workspace package
 * (its file was missing); each package linked into a `node_modules` gets the bins its Lane
 * manifest declares in that `node_modules/.bin`, where the manager would put them. Cost is
 * one readlink per entry plus one manifest read per linked workspace package. A `node_modules`
 * the Lane already has is left alone. */
export function linkInstall(entry: string, root: string, folders: string[]): void {
  const sources = folders
    .map(folder => [real(join(entry, folder)), join(root, folder)] as const)
    .filter((pair): pair is readonly [string, string] => pair[0] !== null)
    .sort((a, b) => b[0].length - a[0].length);
  const laneFolders = new Set(sources.map(([, lane]) => lane));
  /** The Lane's own path for something inside a cached workspace package, or null. */
  const laneSide = (resolved: string | null) => {
    if (!resolved) return null;
    for (const [cached, lane] of sources)
      if (resolved === cached || resolved.startsWith(cached + sep))
        return join(lane, relative(cached, resolved));
    return null;
  };
  const overlay = (from: string, to: string, linked: string[], bin = false) => {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      const source = join(from, name),
        target = join(to, name),
        stat = lstatSync(source);
      if ((name.startsWith('@') || name === '.bin') && stat.isDirectory())
        overlay(source, target, linked, name === '.bin');
      else if (bin && stat.isFile()) {
        // A shell shim finds its package from where it was started (`$0`); a link to the cached
        // file would start from the cache, so a Lane gets its own small copy.
        copyFileSync(source, target);
        chmodSync(target, (stat.mode & 0o777) | 0o200);
      } else if (stat.isSymbolicLink()) {
        const workspace = laneSide(resolveLoose(source));
        if (workspace && laneFolders.has(workspace)) linked.push(workspace);
        symlinkSync(workspace ? relative(dirname(target), workspace) : source, target);
      } else symlinkSync(source, target, stat.isDirectory() ? 'dir' : 'file');
    }
  };
  const addBins = (modules: string, linked: string[]) => {
    const bins = join(modules, '.bin');
    for (const folder of new Set(linked))
      for (const [name, file] of declaredBins(folder)) {
        if (exists(join(bins, name))) continue;
        mkdirSync(bins, { recursive: true });
        symlinkSync(relative(bins, join(folder, file)), join(bins, name));
      }
  };
  for (const folder of ['', ...folders]) {
    const from = join(entry, folder, 'node_modules'),
      to = join(root, folder, 'node_modules');
    if (!exists(from) || exists(to) || !exists(join(root, folder))) continue;
    if (!folders.length) symlinkSync(from, to, 'dir');
    else {
      const linked: string[] = [];
      overlay(from, to, linked);
      addBins(to, linked);
    }
  }
}
