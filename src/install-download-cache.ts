// SPDX-License-Identifier: Apache-2.0
import { lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkCacheScope } from './check-ecosystem-env.js';
import type { PackageManager } from './package-manager.js';

/**
 * A download cache shared by the installs of one project, so the first install of a new lockfile
 * fetches only the packages the project's earlier installs did not.
 *
 * Only managers whose cache is addressed by content are shared: pnpm's store (files by hash, indexes
 * by the lockfile's integrity, files re-verified before linking) and Yarn Berry's cache (archives
 * named by the lockfile checksum, verified on use). Bun's cache is addressed by name and version, so
 * a tarball a different lockfile accepted would be served to every later one unchecked: not shared.
 * Yarn classic keeps its private cache too.
 *
 * Only script-less installs use it. An install that runs package scripts runs code that could write
 * the shared directory, so it keeps a private cache. The cache is per project (a fork never shares)
 * and per manager, private to the user (mode 0700, never a link), and holds downloads only: the
 * installed `node_modules` stays sealed in its own entry.
 */
export const sharesDownloads = (pm: PackageManager) => pm.name === 'pnpm' || (pm.name === 'yarn' && pm.berry);

/** The shared download directory for this manager and project, created if needed; null when it
 * cannot be used safely (not a plain directory owned by this user), so the install stays private. */
export function sharedDownloadCache(
  cache: string,
  pm: PackageManager,
  project: string | null,
): string | null {
  if (!sharesDownloads(pm)) return null;
  const parent = join(cache, 'downloads', pm.name),
    directory = join(parent, checkCacheScope(project ?? 'local'));
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const owner = process.getuid?.();
    // Every level is a plain directory of this user: a link planted anywhere in the path is refused.
    for (const level of [join(cache, 'downloads'), parent, directory]) {
      const stat = lstatSync(level);
      if (!stat.isDirectory() || (owner !== undefined && stat.uid !== owner)) return null;
    }
    return directory;
  } catch {
    return null;
  }
}

/** The settings that point an install at DIRECTORY. pnpm takes command-line flags: they beat every
 * settings file and work in every version (pnpm 11 reads `pnpm_config_*` where older ones read
 * `npm_config_*`), and `clone-or-copy` makes the sealed install share no file with the store. Yarn
 * Berry takes its `YARN_*` variables, which win over the repository's `.yarnrc.yml`. */
export function downloadCacheSettings(
  pm: PackageManager,
  directory: string,
): { args: string[]; env: Record<string, string> } {
  if (pm.name === 'pnpm')
    return { args: ['--store-dir', directory, '--package-import-method=clone-or-copy'], env: {} };
  return { args: [], env: { YARN_ENABLE_GLOBAL_CACHE: 'true', YARN_GLOBAL_FOLDER: directory } };
}
