// SPDX-License-Identifier: Apache-2.0
import { canonicalRoot, clientCacheRoot, rootSibling } from './root-paths.js';
import { lstatSync, readdirSync, readlinkSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readClientSettings, type ClientSettings } from './client-settings.js';
import { hostedLaneDirty } from './hosted-lane-dirty.js';
import { listLanes } from './lane-registry.js';
import { isNestedLaneCopy, readCacheUse, writeCacheUse, unknownCacheMetadata } from './client-cache-use.js';
import { processBlocker, workingProcesses } from './clean-processes.js';
import { logLanePrune } from './lane-prune-log.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hour = 3_600_000;
/** A copy touched this recently counts as in use by a running operation. */
const GRACE_MS = 10 * 60_000;
const BUDGET_MS = 15_000;
const exists = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
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
 * least recently used first. Never the caller's own Lane, a copy in use (lock or touched within
 * ten minutes), a copy a sibling symlink points at, or one with unsaved edits. Local only. */
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
    isDirty = input.isDirty ?? hostedLaneDirty,
    deadline = Date.now() + (input.budgetMs ?? BUDGET_MS);
  const result: CacheGcResult = { evicted: [], kept: [], totalBytes: 0, finished: true };
  const maxBytes = settings.clientCacheMaxGB * 1e9,
    maxAgeMs = settings.clientCacheMaxAgeHours * hour;
  if (maxBytes === 0 && maxAgeMs === 0) return result;
  const directory = join(clientCacheRoot(input.root), 'lanes');
  let names: string[];
  try {
    names = readdirSync(directory).filter(name => uuid.test(name));
  } catch {
    return result;
  }
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
  const keep = new Set(input.keepLaneIds ?? []);
  const copies = names.map(laneId => {
    const copy = join(directory, laneId);
    const usage = readCacheUse(copy);
    const used = Math.max(usage?.used ?? 0, registry.get(copy) ?? 0, exists(copy)?.mtimeMs ?? 0);
    const bytes = usage?.bytes;
    return { laneId, copy, used, bytes };
  });
  copies.sort((a, b) => a.used - b.used);
  for (const item of copies) {
    if (Date.now() > deadline) {
      result.finished = false;
      break;
    }
    item.bytes ??= treeBytes(item.copy);
    try {
      writeCacheUse(item.copy, { bytes: item.bytes, used: item.used });
    } catch {
      /* The size is re-measured next time. */
    }
  }
  let total = copies.reduce((sum, item) => sum + (item.bytes ?? 0), 0);
  let processes: ReturnType<typeof workingProcesses> | undefined;
  for (const item of copies) {
    if (Date.now() > deadline) {
      result.finished = false;
      break;
    }
    const tooOld = maxAgeMs > 0 && now - item.used >= maxAgeMs,
      tooBig = maxBytes > 0 && total > maxBytes;
    if (!tooOld && !tooBig) continue;
    const reason = keep.has(item.laneId)
      ? 'the caller’s Lane'
      : pinned.has(item.laneId)
        ? 'pinned'
        : lockHeld(item.copy) || now - item.used < GRACE_MS
          ? 'in use'
          : linked.has(item.copy)
            ? 'linked from a sibling directory'
            : (processBlocker(item.copy, (processes ??= (input.processes ?? workingProcesses)())) ??
              (unknownCacheMetadata(item.copy)
                ? 'unknown Forge metadata'
                : isDirty(item.copy)
                  ? 'unsaved edits'
                  : null));
    if (reason) {
      result.kept.push({ laneId: item.laneId, reason });
      continue;
    }
    logLanePrune(
      {
        laneId: item.laneId,
        root: item.copy,
        state: 'cache',
        reason: tooOld ? 'Unused Lane cache exceeded age limit' : 'Unused Lane cache exceeded size cap',
        idleHours: (now - item.used) / hour,
        bytes: item.bytes ?? 0,
      },
      now,
    );
    for (const path of [
      item.copy,
      clientCacheRoot(item.copy),
      rootSibling(item.copy, '.forge-metrics.jsonl'),
    ])
      rmSync(path, { recursive: true, force: true });
    total -= item.bytes ?? 0;
    result.evicted.push({ laneId: item.laneId, bytes: item.bytes ?? 0 });
  }
  result.totalBytes = total;
  return result;
}
/** Once an hour per client directory, from CLI start. The stamp is written only when the pass finished. */
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
  if (result.finished) {
    try {
      writeFileSync(stamp, '');
      utimesSync(stamp, now / 1000, now / 1000);
    } catch {
      /* A missing stamp only repeats the pass. */
    }
  }
  return result;
}
