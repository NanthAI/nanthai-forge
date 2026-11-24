// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { removeCachePreservingKept } from './hosted-apply-kept.js';
import { canonicalRoot, clientCacheRoot, rootSibling } from './root-paths.js';
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { readClientSettings, type ClientSettings } from './client-settings.js';
import { hostedLaneDirty } from './hosted-lane-dirty.js';
import { laneCommandRunning, listLanes, readLaneEntry } from './lane-registry.js';
import { readCacheUse, writeCacheUse, unknownCacheMetadata } from './client-cache-use.js';
import {
  isLaneDirectoryName,
  isNestedLaneCopy,
  legacyLaneDirectoryId,
  markerIdentity,
} from './hosted-lane-directory.js';
import { processBlocker, workingProcesses } from './clean-processes.js';
import { logLanePrune } from './lane-prune-log.js';
import { hostedLaneMarkerName } from './forge-cache-paths.js';

const hour = 3_600_000;
/** A copy touched this recently counts as in use by a running operation. */
const GRACE_MS = 10 * 60_000;
const SNAPSHOT_LAUNCH_MS = 60_000;
const BUDGET_MS = 15_000;
/** An unfinished pass resumes this long after it stopped. */
const RETRY_MS = 5 * 60_000;
const exists = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};
const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);
const siblings = (root: string) => [root, clientCacheRoot(root), rootSibling(root, '.forge-metrics.jsonl')];
const snapshotBusy = (root: string, time: number) => {
  const dir = join(clientCacheRoot(root), 'snapshots');
  const worker = exists(join(dir, 'worker'));
  if (worker !== null && time - worker.mtimeMs < SNAPSHOT_LAUNCH_MS) return true;
  const lockPath = join(dir, 'lock');
  const lock = exists(lockPath);
  if (!lock || Date.now() - lock.mtimeMs > 120_000) return false;
  try {
    const pid = Number(readFileSync(lockPath, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) return true;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
};
/** Allocated bytes of a tree; symlinks are never followed. */
function treeBytes(path: string): number {
  let bytes = 0;
  const stack = [path];
  while (stack.length) {
    const next = stack.pop()!,
      stat = exists(next);
    if (!stat) continue;
    bytes += stat.blocks * 512;
    if (stat.isDirectory()) for (const name of readdirSync(next)) stack.push(join(next, name));
  }
  return bytes;
}
/** Mark a nested Lane copy as used now (open, reuse, read). Advisory; never throws. */
export function touchNestedLane(copy: string, now = Date.now()) {
  try {
    if (!isNestedLaneCopy(copy)) return;
    writeCacheUse(copy, { bytes: readCacheUse(copy)?.bytes, used: now });
  } catch {
    /* Cache bookkeeping never fails a command. */
  }
}
const lockHeld = (copy: string) => Boolean(exists(join(clientCacheRoot(copy), `lock`)));

export type CacheGcResult = {
  evicted: { laneId: string; bytes: number }[];
  kept: { laneId: string; reason: string }[];
  totalBytes: number;
  finished: boolean;
};
/** Nested Lane copies under ROOT.forge-client/lanes are a cache: bounded by size and age, evicted
 * least recently used first. Never the caller's own Lane, a copy in use (lock, running snapshot,
 * active process or touched within ten minutes), a copy a sibling symlink points at, a Lane
 * checkout this machine's registry records, or one with unsaved edits. Local only. */
export function gcNestedLanes(input: {
  root: string;
  /** The caller's own Lane, never evicted. */
  keepLaneIds?: string[];
  settings?: Pick<ClientSettings, 'clientCacheMaxGB' | 'clientCacheMaxAgeHours'>;
  now?: number;
  budgetMs?: number;
  isDirty?: (root: string) => boolean;
  processes?: () => ReturnType<typeof workingProcesses>;
}): CacheGcResult {
  const now = input.now ?? Date.now(),
    settings = input.settings ?? readClientSettings(),
    isDirty = input.isDirty ?? (root => hostedLaneDirty(root, { preserveMaterializedSubmodules: true })),
    deadline = Date.now() + (input.budgetMs ?? BUDGET_MS);
  const result: CacheGcResult = { evicted: [], kept: [], totalBytes: 0, finished: true };
  const maxBytes = settings.clientCacheMaxGB * 1e9,
    maxAgeMs = settings.clientCacheMaxAgeHours * hour;
  if (maxBytes === 0 && maxAgeMs === 0) return result;
  let directory: string;
  let names: string[];
  try {
    directory = canonicalRoot(join(clientCacheRoot(input.root), 'lanes'));
    names = readdirSync(directory).filter(isLaneDirectoryName);
  } catch {
    return result;
  }
  const workingRoot = canonicalRoot(process.cwd());
  // Sibling symlinks (conflict checkouts) point into this cache and keep a copy alive.
  const linked = new Set<string>();
  try {
    const parent = dirname(canonicalRoot(input.root));
    for (const name of readdirSync(parent)) {
      const stat = exists(join(parent, name));
      if (stat?.isSymbolicLink())
        linked.add(canonicalRoot(resolve(parent, readlinkSync(join(parent, name)))));
    }
  } catch {
    /* Without a parent listing, nothing is protected by link; the other guards still apply. */
  }
  const lanes = listLanes();
  const registry = new Map(lanes.map(entry => [canonicalRoot(entry.root), entry.lastActionAt]));
  // Owner-pinned Lanes (this client's registry mirror of the server flag) are never evicted.
  const pinned = new Set(lanes.filter(entry => entry.pinned).map(entry => entry.laneId));
  // A local state or pin can be stale after activity on another machine. Registered
  // checkouts go through the fresh hosted lifecycle and process checks in lane-prune.
  const keep = new Set(input.keepLaneIds ?? []);
  const copies = names.flatMap(name => {
    const copy = join(directory, name);
    const stat = exists(copy);
    if (!stat?.isDirectory()) return [];
    const legacyId = legacyLaneDirectoryId(name);
    if (!legacyId && !exists(join(copy, '.forge', hostedLaneMarkerName))?.isFile()) return [];
    const usage = readCacheUse(copy);
    const used = Math.max(usage?.used ?? 0, registry.get(copy) ?? 0, stat.mtimeMs);
    const bytes = usage?.bytes;
    return [{ legacyId, copy, used, bytes }];
  });
  copies.sort((a, b) => a.used - b.used);
  for (const item of copies) {
    if (Date.now() > deadline) {
      result.finished = false;
      break;
    }
    if (item.bytes !== undefined) continue;
    item.bytes = treeBytes(item.copy);
    try {
      writeCacheUse(item.copy, { bytes: item.bytes, used: item.used });
    } catch {
      /* The size is re-measured next time. */
    }
  }
  let total = copies.reduce((sum, item) => sum + (item.bytes ?? 0), 0);
  const observe = input.processes ?? (() => workingProcesses(true));
  const runningProcess = (root: string, observed: ReturnType<typeof workingProcesses>) => {
    for (const path of siblings(root)) {
      const reason = processBlocker(path, observed);
      if (reason) return reason;
    }
    return null;
  };
  let processes: ReturnType<typeof workingProcesses> | undefined;
  // Batch pre-delete re-checks like lane-prune: one fresh process census per batch of up to 16
  // candidates instead of one open-file census per evicted copy.
  const pending: { bytes: number; run: (observed: ReturnType<typeof workingProcesses>) => void }[] = [];
  const flush = () => {
    if (!pending.length) return;
    if (Date.now() > deadline) {
      result.finished = false;
      for (const entry of pending.splice(0)) total += entry.bytes;
      return;
    }
    const observed = observe();
    for (const entry of pending.splice(0)) {
      if (Date.now() > deadline) {
        result.finished = false;
        total += entry.bytes;
        continue;
      }
      entry.run(observed);
    }
  };
  for (const item of copies) {
    if (Date.now() > deadline) {
      result.finished = false;
      break;
    }
    const tooOld = maxAgeMs > 0 && now - item.used >= maxAgeMs,
      tooBig = maxBytes > 0 && total > maxBytes;
    if (!tooOld && !tooBig) continue;
    // Named folders use the full marker id, including after an in-place resolution.
    const laneId = item.legacyId ?? markerIdentity(item.copy)?.laneId;
    if (!laneId) continue;
    const marker = join(item.copy, '.forge', hostedLaneMarkerName);
    const before = exists(marker);
    // Re-read the registry entry after any tree walk so a builder that started or resumed this
    // Lane during GC is never evicted under its feet (frictions a868ee3d, 9ecd8dab).
    const liveEntry = readLaneEntry(laneId);
    const liveRegistered = Boolean(
      liveEntry &&
      (canonicalRoot(liveEntry.root) === item.copy ||
        liveEntry.pinned ||
        laneCommandRunning(liveEntry) ||
        (!liveEntry.state && (liveEntry.landing || liveEntry.hold))),
    );
    const unsafeLink = () =>
      Boolean(exists(item.copy)?.isSymbolicLink() || exists(clientCacheRoot(item.copy))?.isSymbolicLink());
    const reason =
      keep.has(laneId) || inside(workingRoot, item.copy)
        ? 'the caller’s Lane'
        : pinned.has(laneId) || liveEntry?.pinned
          ? 'pinned'
          : unsafeLink() || lockHeld(item.copy) || snapshotBusy(item.copy, now) || now - item.used < GRACE_MS
            ? 'in use'
            : linked.has(item.copy)
              ? 'linked from a sibling directory'
              : registry.has(item.copy) || liveRegistered
                ? 'registered Lane checkout'
                : (runningProcess(item.copy, (processes ??= observe())) ??
                  (unknownCacheMetadata(item.copy)
                    ? 'unknown Forge metadata'
                    : isDirty(item.copy)
                      ? 'unsaved edits'
                      : null));
    if (reason) {
      result.kept.push({ laneId, reason });
      continue;
    }
    const bytes = item.bytes ?? 0;
    total -= bytes;
    pending.push({
      bytes,
      run: observed => {
        // Re-check live state right before deletion: a builder could have opened, edited or started a
        // process in this folder during the scan above.
        const after = exists(marker);
        const latestEntry = readLaneEntry(laneId);
        const latestUse = readCacheUse(item.copy);
        const checkTime = input.now ?? Date.now();
        const latestBlocked =
          (before && (!after || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs)) ||
          (!before && Boolean(after)) ||
          unsafeLink() ||
          lockHeld(item.copy) ||
          snapshotBusy(item.copy, checkTime) ||
          (latestUse?.used !== undefined && checkTime - latestUse.used < GRACE_MS) ||
          Boolean(
            latestEntry &&
            (canonicalRoot(latestEntry.root) === item.copy ||
              latestEntry.pinned ||
              laneCommandRunning(latestEntry) ||
              (!latestEntry.state && (latestEntry.landing || latestEntry.hold))),
          )
            ? 'in use'
            : (runningProcess(item.copy, observed) ?? (isDirty(item.copy) ? 'unsaved edits' : null));
        if (latestBlocked) {
          total += bytes;
          result.kept.push({ laneId, reason: latestBlocked });
          return;
        }
        logLanePrune(
          {
            laneId,
            root: item.copy,
            state: 'cache',
            reason: tooOld ? 'Unused Lane cache exceeded age limit' : 'Unused Lane cache exceeded size cap',
            idleHours: (now - item.used) / hour,
            bytes,
          },
          now,
        );
        try {
          removeCachePreservingKept(clientCacheRoot(item.copy));
          rmSync(rootSibling(item.copy, '.forge-metrics.jsonl'), { recursive: true, force: true });
          rmSync(item.copy, { recursive: true, force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
          total += bytes;
          result.kept.push({ laneId, reason: 'removal interrupted (ENOTEMPTY); remaining files retained' });
          return;
        }
        result.evicted.push({ laneId, bytes });
      },
    });
    if (pending.length === 16) flush();
  }
  flush();
  result.totalBytes = total;
  return result;
}
/** Once an hour per client directory, from CLI start; a pass that ran out of budget resumes five minutes later. */
export function gcNestedLanesHourly(input: Parameters<typeof gcNestedLanes>[0]): CacheGcResult | null {
  const stamp = join(clientCacheRoot(resolve(input.root)), `gc-stamp`),
    now = input.now ?? Date.now();
  try {
    if (exists(stamp) && now - lstatSync(stamp).mtimeMs < hour) return null;
    if (!exists(join(clientCacheRoot(resolve(input.root)), `lanes`))) return null;
  } catch {
    return null;
  }
  const result = gcNestedLanes(input);
  // A pass cut short by its budget continues RETRY_MS later, not on every command (7da396ed F4).
  const at = result.finished ? now : now - hour + RETRY_MS;
  try {
    writeFileSync(stamp, '');
    utimesSync(stamp, at / 1000, at / 1000);
  } catch {
    /* A missing stamp only repeats the pass. */
  }
  return result;
}
