// SPDX-License-Identifier: Apache-2.0
import { dependencyDirs, regenerableDirs } from './ecosystems.js';

/** Other ecosystems' regenerable folders (src/ecosystems.ts). Lane cleanup reclaims them only when
 * ignored by .gitignore/.forgeignore: a folder that is not ignored is source or tracked and stays. */
export const ECOSYSTEM_DIRS: ReadonlySet<string> = regenerableDirs();

/** Folders that hold installed dependencies or tool caches, wherever they sit. Package managers
 * hard-link their files from a shared store (uv, pip, pnpm), so an untracked hard-linked file
 * below one of them is an install, not source. */
const DEPENDENCY_DIRS: ReadonlySet<string> = dependencyDirs();

/** True when a path sits below a dependency-install or tool-cache folder. O(path). */
export function inDependencyDirectory(path: string) {
  return path
    .split('/')
    .slice(0, -1)
    .some(part => DEPENDENCY_DIRS.has(part.toLowerCase()));
}
