// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { RETENTION_MS } from './clean-retention.js';
import {
  autoSnapshotDirectory,
  readAutoSnapshot,
  withAutoSnapshotLock,
  type AutoSnapshot,
} from './lane-auto-snapshot.js';
import { NativeSource } from './native-source.js';
import type { WorkStore } from './work-store.js';

/** Reopening restores protection immediately; a later closure starts a fresh
 * window. Legacy closed Lanes without lifecycle history use the snapshot time.
 * Inconsistent history or invalid timestamps retain protection. */
function expired(store: WorkStore, snapshot: AutoSnapshot, now: number) {
  const lane = store.select('lanes', snapshot.laneId);
  if (!lane || !['completed', 'abandoned'].includes(lane.state)) return false;
  const closed = lane.lifecycle?.at(-1);
  if (closed && closed.to !== lane.state) return false;
  const at = Math.max(Date.parse(snapshot.at), Date.parse(closed?.at ?? snapshot.at));
  return Number.isFinite(at) && now - at > RETENTION_MS;
}
function snapshots(store: WorkStore, laneId?: string) {
  const directory = autoSnapshotDirectory(store);
  try {
    if (realpathSync(directory) !== directory) return [];
    return (laneId ? [`${laneId}.json`] : readdirSync(directory)).flatMap(name => {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) return [];
      const path = join(directory, name),
        info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return [];
      const snapshot = readAutoSnapshot(store, name.slice(0, -5));
      return snapshot ? [{ snapshot, path, bytes: info.size }] : [];
    });
  } catch {
    return [];
  }
}
function objects(source: NativeSource, snapshot: AutoSnapshot) {
  return [snapshot.state, ...source.state(snapshot.state).files.map(file => file.blob)];
}
/** Called under the owner and snapshot publication locks by object collection. */
export function autoSnapshotObjects(
  store: WorkStore,
  source = new NativeSource(store.root),
  now = Date.now(),
) {
  return snapshots(store).flatMap(({ snapshot }) => {
    if (expired(store, snapshot, now)) return [];
    try {
      return objects(source, snapshot);
    } catch {
      return [];
    }
  });
}
export type SnapshotRetentionItem = {
  id: string;
  kind: 'auto-snapshots';
  path: string;
  laneId: string;
  bytes: number;
  snapshotBytes: number;
  reason: string;
};
/** Only pointer/cache bytes are removed here. Snapshot object bytes are reported
 * separately: they can be shared with main, other Lanes or retained history. */
export function autoSnapshotRetentionPlan(
  store: WorkStore,
  now = Date.now(),
  laneId?: string,
): SnapshotRetentionItem[] {
  const source = new NativeSource(store.root);
  return snapshots(store, laneId).flatMap(({ snapshot, path, bytes }) => {
    if (!expired(store, snapshot, now)) return [];
    const cache = path.replace(/\.json$/, '.cache.json');
    try {
      const info = lstatSync(cache);
      if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1) bytes += info.size;
    } catch {
      /* No cache is required. */
    }
    let snapshotBytes = 0;
    try {
      for (const id of new Set(objects(source, snapshot)))
        snapshotBytes += lstatSync(join(source.directory, id)).size;
    } catch {
      /* Object collection may already have reclaimed this expired State. */
    }
    return [
      {
        id: path,
        kind: 'auto-snapshots' as const,
        path,
        laneId: snapshot.laneId,
        bytes,
        snapshotBytes,
        reason:
          'Completed or abandoned Lane snapshot and closure are older than seven days. Remove pointer/cache only; objects are collectable only when unreachable from every other retained root.',
      },
    ];
  });
}
/** Current snapshot footprint, including protected open Lanes. Shared objects
 * count once here, but may also belong to other source/history roots. */
export function autoSnapshotDiskUsage(store: WorkStore) {
  const source = new NativeSource(store.root),
    entries = snapshots(store),
    ids = new Set<string>();
  let metadataBytes = 0,
    objectBytes = 0,
    unavailableSnapshots = 0,
    unavailableObjects = 0;
  for (const { snapshot, path, bytes } of entries) {
    metadataBytes += bytes;
    try {
      const info = lstatSync(path.replace(/\.json$/, '.cache.json'));
      if (info.isFile() && !info.isSymbolicLink()) metadataBytes += info.size;
    } catch {
      /* Cache may be absent. */
    }
    try {
      for (const id of objects(source, snapshot)) ids.add(id);
    } catch {
      unavailableSnapshots++;
    }
  }
  for (const id of ids) {
    try {
      objectBytes += lstatSync(join(source.directory, id)).size;
    } catch {
      unavailableObjects++;
    }
  }
  return {
    kind: 'auto-snapshots' as const,
    count: entries.length,
    bytes: metadataBytes + objectBytes,
    metadataBytes,
    objectBytes,
    unavailableSnapshots,
    unavailableObjects,
    coverage:
      'Pointer/cache bytes plus unique referenced State/blob bytes, including shared objects; not an estimate of reclaimable bytes. Unavailable entries make this a partial footprint.',
  };
}

/** The caller holds the owner lock, so lifecycle cannot change. Publication is
 * excluded while the current pointer/cache are revalidated and removed. */
export function removeAutoSnapshot(store: WorkStore, item: SnapshotRetentionItem): string | undefined {
  return withAutoSnapshotLock(store, () => {
    const current = autoSnapshotRetentionPlan(store, Date.now(), item.laneId).find(
      candidate => candidate.id === item.id,
    );
    if (!current) return 'Auto-snapshot is no longer eligible.';
    const cache = current.path.replace(/\.json$/, '.cache.json');
    try {
      const info = lstatSync(cache);
      if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1) unlinkSync(cache);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    unlinkSync(current.path);
    return undefined;
  });
}
