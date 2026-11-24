// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { sweepKeptApplyCache } from './hosted-apply-kept.js';
import { markerIdentity } from './hosted-lane-directory.js';
import type { UnsavedLaneReport } from './hosted-lane-dirty.js';
import { canonicalRoot, clientCacheRoot } from './root-paths.js';
import type { LaneRegistryEntry } from './lane-registry.js';

export type PruneFolder = {
  root: string;
  reason: string;
  laneId?: string;
  registered?: boolean;
  bytes?: number;
  scratchBytes?: number;
  largeScratch?: true;
  unsaved?: Omit<Extract<UnsavedLaneReport, { dirty: true }>, 'dirty'>;
  staleMarkerHead?: { checkoutHead: string; savedHead: string };
  staleMarkerVersion?: { checkoutVersion: number; serverVersion: number };
};

const cacheSuffix = '.forge-client';
const children = (path: string) => readdirSync(path, { withFileTypes: true });
const present = (path: string) => lstatSync(path, { throwIfNoEntry: false });

/** Inventory physical directories separately from the machine registry. A stale
 * path for an identity must not hide its surviving checkout. */
export function scanLaneDirectory(
  directory: string,
  registered: LaneRegistryEntry[],
  now: number,
  sweepRecovery: boolean,
) {
  const index = new Map(registered.map(entry => [entry.laneId, entry]));
  const links = new Map<string, string[]>();
  const byRoot = new Map<string, PruneFolder>();
  const found: LaneRegistryEntry[] = [];
  const candidates = new Map<string, LaneRegistryEntry[]>();
  const visit = (root: string) => {
    const identity = markerIdentity(root);
    if (!identity) {
      byRoot.set(root, { root, reason: 'no readable hosted Lane marker' });
      return;
    }
    const { laneId, url, projectId } = identity;
    const entry = index.get(laneId);
    const matches = entry && entry.url === url && entry.projectId === projectId;
    const folder = { root, laneId, registered: false, reason: 'Lane state unavailable' };
    byRoot.set(root, folder);
    let registeredPathExists = false;
    try {
      if (entry) {
        registeredPathExists = Boolean(present(entry.root));
        folder.registered = Boolean(matches && canonicalRoot(entry.root) === root);
      }
    } catch {
      folder.reason = 'registered path could not be inspected';
      return;
    }
    const registeredHere = folder.registered;
    if (registeredHere) return;
    if (entry && (!matches || registeredPathExists)) {
      folder.reason = !matches
        ? 'marker conflicts with registered project identity'
        : 'Lane registered at another existing root';
      return;
    }
    const markerTime = present(join(root, '.forge', 'hosted-lane.json'))?.mtimeMs ?? now;
    const lastActionAt = Math.min(now, Math.max(markerTime, entry?.lastActionAt ?? 0));
    const copies = candidates.get(laneId) ?? [];
    copies.push({ ...entry, ...identity, root, openedAt: entry?.openedAt ?? now, lastActionAt });
    candidates.set(laneId, copies);
  };
  const visitCache = (cachePath: string) => {
    const folder = { root: cachePath, reason: 'client cache companion' };
    byRoot.set(cachePath, folder);
    try {
      if (sweepRecovery) sweepKeptApplyCache(cachePath);
      const lanes = join(cachePath, 'lanes');
      const lanesStat = present(lanes);
      if (!lanesStat?.isDirectory() || lanesStat.isSymbolicLink()) return;
      for (const lane of children(lanes))
        if (lane.isDirectory()) {
          const nested = join(lanes, lane.name);
          if (!lane.name.endsWith(cacheSuffix) || markerIdentity(nested)) visit(nested);
          else byRoot.set(nested, { root: nested, reason: 'client cache companion' });
        }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        folder.reason = 'client cache companion could not be fully inspected';
    }
  };
  directory = canonicalRoot(directory);
  // Passing a project's .forge-client folder directly inspects its lanes/ cache instead of
  // marking lanes/ as a markerless folder (friction d8012963).
  if (basename(directory).endsWith(cacheSuffix) && !markerIdentity(directory)) {
    visitCache(directory);
  } else {
    // Passing a project checkout root also inspects its sibling ROOT.forge-client/lanes cache.
    const siblingCache = clientCacheRoot(directory);
    const siblingStat = present(siblingCache);
    if (
      siblingStat?.isDirectory() &&
      !siblingStat.isSymbolicLink() &&
      !markerIdentity(siblingCache) &&
      present(join(siblingCache, 'lanes'))?.isDirectory()
    )
      visitCache(siblingCache);
    for (const item of children(directory)) {
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) {
        try {
          const target = canonicalRoot(resolve(directory, readlinkSync(path)));
          const targetLinks = links.get(target) ?? [];
          targetLinks.push(path);
          links.set(target, targetLinks);
        } catch {
          // A broken or unreadable link cannot authorize removal of a checkout.
        }
      } else if (item.isDirectory() && item.name.endsWith(cacheSuffix) && !markerIdentity(path)) {
        visitCache(path);
      } else if (item.isDirectory()) visit(path);
    }
  }
  for (const copies of candidates.values()) {
    if (copies.length === 1) found.push(copies[0]!);
    else
      for (const copy of copies)
        byRoot.get(copy.root)!.reason = 'multiple unregistered roots claim the same Lane';
  }
  return { found, links, byRoot, folders: [...byRoot.values()] };
}
