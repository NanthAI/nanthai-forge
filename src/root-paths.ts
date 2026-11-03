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

/** Preservation must outlive eviction of every containing nested checkout cache. */
export function retainedRootSibling(root: string, suffix: string) {
  let retained = canonicalRoot(root);
  for (let parent = dirname(retained); parent !== dirname(parent); parent = dirname(parent))
    if (basename(parent).endsWith('.forge-client')) retained = parent.slice(0, -'.forge-client'.length);
  return rootSibling(retained, suffix);
}
