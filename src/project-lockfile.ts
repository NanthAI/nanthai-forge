// SPDX-License-Identifier: Apache-2.0
import { digest } from './hash.js';
import { pinLockfiles } from './ecosystems.js';

/** Dependency lockfile names Forge recognises, from the ecosystem registry (src/ecosystems.ts), npm
 * first. */
export const PROJECT_LOCKFILES: readonly string[] = pinLockfiles();
const NAMES: ReadonlySet<string> = new Set(PROJECT_LOCKFILES);

/** Whether this State path is a registry lockfile, at the root or in any folder. */
export const isProjectLockfile = (path: string) => NAMES.has(path.slice(path.lastIndexOf('/') + 1));

/** The lockfile digest a check plan pins (Issue 721cd45c). Every registry lockfile in the State feeds
 * it, whatever its depth, so a change to any of them changes the plan and its cache key; paths
 * come from the State, which already bounds their length and count. No lockfile is the empty-input
 * digest. A repository whose only lockfile is one root file keeps the digest of that file's bytes
 * (`blob` is the SHA-256 of the file's bytes, as the State records it); anything else is the
 * digest of the sorted `path NUL blob LF` lines, so moving a lockfile changes it too. In memory
 * only: the blobs are never read. */
export function lockfileDigest(files: Iterable<{ path: string; blob: string }>): string {
  const found = [...files].filter(file => isProjectLockfile(file.path));
  if (!found.length) return digest('');
  if (found.length === 1 && !found[0]!.path.includes('/')) return found[0]!.blob;
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return digest(found.map(file => `${file.path}\0${file.blob}\n`).join(''));
}
