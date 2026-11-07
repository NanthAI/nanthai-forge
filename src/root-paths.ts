// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Canonicalize the existing prefix, including a symlinked checkout, before deriving paths. */
export function canonicalRoot(root: string): string {
  const absolute = resolve(root);
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      try {
        return realpathSync(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return canonicalRoot(resolve(dirname(absolute), readlinkSync(absolute)));
      }
    }
    return realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(canonicalRoot(parent), basename(absolute));
  }
}
export const rootSibling = (root: string, suffix: string) => canonicalRoot(root) + suffix;
export const clientCacheRoot = (root: string) => rootSibling(root, '.forge-client');
/** The checkout path itself with its parent canonicalized, never following a link at the last
 * component, and its client cache beside it. Recovery uses these to find a journal even after the
 * root was replaced by a link. */
export const unfollowedRoot = (root: string) => {
  const absolute = resolve(root);
  return join(canonicalRoot(dirname(absolute)), basename(absolute));
};
export const unfollowedClientCacheRoot = (root: string) => unfollowedRoot(root) + '.forge-client';

/** Preservation must outlive eviction of every containing nested checkout cache. */
export function retainedRootSibling(root: string, suffix: string) {
  let retained = canonicalRoot(root);
  for (let parent = dirname(retained); parent !== dirname(parent); parent = dirname(parent))
    if (basename(parent).endsWith('.forge-client')) retained = parent.slice(0, -'.forge-client'.length);
  return rootSibling(retained, suffix);
}
