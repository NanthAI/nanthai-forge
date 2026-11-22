// SPDX-License-Identifier: Apache-2.0
// Guards that read repository files without importing them become consumers of the paths they read.
import { posix } from 'node:path';
import { treeReaders } from './test-tree-readers.mjs';
import { treeScanCache } from './test-import-cache.mjs';

const testFile = path => /^tests\/[^/]+\.test\.mjs$/.test(path);
export const treeScanners = files => treeReaders(files, testFile, undefined, treeScanCache(files));

/** A scan covers a path inside its folder (anywhere below it when recursive, directly in it when not);
 * an import walk (`code`) covers no Markdown document. */
export const scanCovers = ({ folder, recursive, code, suffix, file, entry, manifest, prefix }, path) => {
  if (file !== undefined) return file === path;
  if (entry)
    return (
      path === manifest ||
      ((!prefix || path.startsWith(prefix)) &&
        (path === entry ||
          path.startsWith(`${entry}/`) ||
          (/[?*{[(]/.test(entry) && posix.matchesGlob(path, entry))))
    );
  if (folder && !path.startsWith(`${folder}/`)) return false;
  if (code && /\.md$/.test(path)) return false;
  if (suffix && !path.endsWith(suffix)) return false;
  return recursive || !path.slice(folder ? folder.length + 1 : 0).includes('/');
};

/** Tests that scan a folder holding one of `paths`: test -> {path, folder}. The test is that path's
 * coverage, as a reader of a changed document is. */
export function scanReaders(files, paths) {
  const found = new Map();
  if (!paths.length) return found;
  for (const [test, scans] of treeScanners(files))
    for (const path of paths) {
      const scan = scans.find(item => scanCovers(item, path));
      if (scan) {
        const { entry, manifest, file } = scan;
        const folder = entry && path.startsWith(`${entry}/`) ? entry : scan.folder;
        found.set(test, { path, folder, ...(manifest ? { manifest } : {}), ...(file ? { file } : {}) });
        break;
      }
    }
  return found;
}

/** Why a scanner covers a path, for selection reasons. */
export const scanDetail = ({ path, folder, manifest, file }) =>
  manifest
    ? `Uses the file list in ${manifest}, which covers changed ${path}`
    : file
      ? `Reads changed ${path}`
      : `Scans ${folder ? `${folder}/` : 'the repository root'}, which holds changed ${path}`;
