// SPDX-License-Identifier: Apache-2.0
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { hostedLaneMarkerName } from './forge-cache-paths.js';
import { canonicalRoot, unfollowedClientCacheRoot } from './root-paths.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const readable = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/;

/** Only legacy folder names carry an exact id. Named copies get it from their marker. */
export const legacyLaneDirectoryId = (name: string) => (uuid.test(name) ? name : null);
export const isLaneDirectoryName = (name: string) => uuid.test(name) || readable.test(name);

export function nestedLaneParent(parent: string) {
  return basename(parent) === 'lanes' && basename(dirname(parent)).endsWith('.forge-client');
}

export function isNestedLaneCopy(copy: string) {
  copy = canonicalRoot(copy);
  return nestedLaneParent(dirname(copy)) && isLaneDirectoryName(basename(copy));
}

/** Reads the Lane identity without validating or rehashing the checkout's source baseline. */
export function markerIdentity(
  root: string,
): { laneId: string; url: string; projectId: string; head?: string } | null {
  let descriptor: number | undefined;
  try {
    const forge = join(root, '.forge');
    if (!lstatSync(forge).isDirectory()) return null;
    descriptor = openSync(
      join(forge, hostedLaneMarkerName),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    if (!fstatSync(descriptor).isFile()) return null;
    const marker = JSON.parse(readFileSync(descriptor, 'utf8')) as {
      url?: unknown;
      selection?: { laneId?: unknown; projectId?: unknown; head?: unknown };
    };
    const laneId = marker.selection?.laneId,
      projectId = marker.selection?.projectId;
    return typeof laneId === 'string' && uuid.test(laneId) && typeof projectId === 'string'
      ? {
          laneId,
          projectId,
          url: typeof marker.url === 'string' ? marker.url : '',
          ...(typeof marker.selection?.head === 'string' ? { head: marker.selection.head } : {}),
        }
      : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Pick a portable component, leaving room for the checkout's adjacent client and staging paths. */
export function namedLanePath(parent: string, title: string, laneId: string, reserve: boolean) {
  const slug =
    title
      .normalize('NFKD')
      .replace(/\p{Mark}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-/, '')
      .slice(0, 60)
      .replace(/-$/, '') || 'lane';
  const path = join(parent, `${slug}-${laneId.slice(0, 8)}`);
  // A shortened id may collide. Leave an occupied path and any retained checkout pins alone.
  const occupied = (candidate: string) => {
    try {
      lstatSync(candidate);
      return true;
    } catch {
      // Checkout reports unusable paths with the retained start receipt.
      return false;
    }
  };
  const fallback = join(parent, laneId);
  if (occupied(unfollowedClientCacheRoot(path))) return fallback;
  if (!reserve) return occupied(path) ? fallback : path;
  // Claim the empty checkout itself before returning a name. Independent starts
  // can share the eight-character prefix but cannot both create the directory.
  try {
    mkdirSync(parent, { recursive: true });
    mkdirSync(path);
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fallback;
    return path;
  }
}
