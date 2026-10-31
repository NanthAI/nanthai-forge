// SPDX-License-Identifier: Apache-2.0
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readClientSettings, type ClientSettings } from './client-settings.js';
import { hostedLaneDirty } from './hosted-lane-dirty.js';
import { listLanes } from './lane-registry.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hour = 3_600_000;
/** A copy touched this recently counts as in use by a running operation. */
const GRACE_MS = 10 * 60_000;
const BUDGET_MS = 15_000;
const useFile = (copy: string) => join(copy, '.forge', 'cache-use.json');
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
    if (!/[\\/]\.forge-client[\\/]lanes[\\/][0-9a-f-]{36}$/.test(copy)) return;
    const file = useFile(copy);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    let bytes: number | undefined;
    try {
      bytes = (JSON.parse(readFileSync(file, 'utf8')) as { bytes?: number }).bytes;
    } catch {
      /* first use */
    }
    writeFileSync(file, JSON.stringify(bytes === undefined ? {} : { bytes }));
    utimesSync(file, now / 1000, now / 1000);
  } catch {
    /* Cache bookkeeping never fails a command. */
  }
}
const lockHeld = (copy: string) => Boolean(exists(`${copy}.forge-client/lock`));

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
}): CacheGcResult {
  const now = input.now ?? Date.now(),
    settings = input.settings ?? readClientSettings(),
    isDirty = input.isDirty ?? hostedLaneDirty,
    deadline = Date.now() + (input.budgetMs ?? BUDGET_MS);
  const result: CacheGcResult = { evicted: [], kept: [], totalBytes: 0, finished: true };
  const maxBytes = settings.clientCacheMaxGB * 1e9,
    maxAgeMs = settings.clientCacheMaxAgeHours * hour;
  if (maxBytes === 0 && maxAgeMs === 0) return result;
  const directory = join(`${resolve(input.root)}.forge-client`, 'lanes');
  let names: string[];
  try {
    names = readdirSync(directory).filter(name => uuid.test(name));
  } catch {
    return result;
  }
  // Sibling symlinks (conflict checkouts) point into this cache and keep a copy alive.
  const linked = new Set<string>();
  try {
    const parent = dirname(resolve(input.root));
    for (const name of readdirSync(parent)) {
      const stat = exists(join(parent, name));
      if (stat?.isSymbolicLink()) linked.add(resolve(parent, readlinkSync(join(parent, name))));
    }
  } catch {
    /* Without a parent listing, nothing is protected by link; the other guards still apply. */
  }
  const registry = new Map(listLanes().map(entry => [resolve(entry.root), entry.lastActionAt]));
  const keep = new Set(input.keepLaneIds ?? []);
  const copies = names.map(laneId => {
    const copy = join(directory, laneId);
    let used = 0;
    for (const time of [exists(useFile(copy))?.mtimeMs, registry.get(copy), exists(copy)?.mtimeMs])
      used = Math.max(used, time ?? 0);
    let bytes: number | undefined;
    try {
      bytes = (JSON.parse(readFileSync(useFile(copy), 'utf8')) as { bytes?: number }).bytes;
    } catch {
      /* measured below */
    }
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
      const file = useFile(item.copy);
      if (exists(dirname(file))) {
        const stat = statSync(file, { throwIfNoEntry: false });
        writeFileSync(file, JSON.stringify({ bytes: item.bytes }));
        if (stat) utimesSync(file, stat.mtimeMs / 1000, stat.mtimeMs / 1000);
      }
    } catch {
      /* The size is re-measured next time. */
    }
  }
  let total = copies.reduce((sum, item) => sum + (item.bytes ?? 0), 0);
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
      : lockHeld(item.copy) || now - item.used < GRACE_MS
        ? 'in use'
        : linked.has(item.copy)
          ? 'linked from a sibling directory'
          : isDirty(item.copy)
            ? 'unsaved edits'
            : null;
    if (reason) {
      result.kept.push({ laneId: item.laneId, reason });
      continue;
    }
    for (const path of [item.copy, `${item.copy}.forge-client`, `${item.copy}.forge-metrics.jsonl`])
      rmSync(path, { recursive: true, force: true });
    total -= item.bytes ?? 0;
    result.evicted.push({ laneId: item.laneId, bytes: item.bytes ?? 0 });
  }
  result.totalBytes = total;
  return result;
}
/** Once an hour per client directory, from CLI start. The stamp is written only when the pass finished. */
export function gcNestedLanesHourly(input: Parameters<typeof gcNestedLanes>[0]): CacheGcResult | null {
  const stamp = `${resolve(input.root)}.forge-client/gc-stamp`,
    now = input.now ?? Date.now();
  try {
    if (exists(stamp) && now - lstatSync(stamp).mtimeMs < hour) return null;
    if (!exists(`${resolve(input.root)}.forge-client/lanes`)) return null;
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
