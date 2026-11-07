// SPDX-License-Identifier: Apache-2.0
import { removeCachePreservingKept, sweepKeptApplyCache } from './hosted-apply-kept.js';
import { canonicalRoot, clientCacheRoot, rootSibling } from './root-paths.js';
import { lstatSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { makeFunctionReference } from 'convex/server';
import {
  forgetLane,
  laneCommandRunning,
  listLanes,
  recordLane,
  type LaneRegistryEntry,
} from './lane-registry.js';
import { logLanePrune } from './lane-prune-log.js';
import { readClientSettings, type ClientSettings } from './client-settings.js';
import { hostedLaneDirty } from './hosted-lane-dirty.js';
import { invariant } from './errors.js';

const hour = 3_600_000;
/** An open Lane may be waiting on a long landing or review; its root outlives a week by default. */
const DEFAULT_ACTIVE_PRUNE_HOURS = 168;
/** Unsaved-edit checks hash a whole checkout; bound them per pass. */
const DIRTY_CHECKS = 8;
const terminal = new Set(['completed', 'abandoned']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type LaneAddress = { url: string; projectId: string };
/** One batched server read per 100 Lanes; null when the deployment predates it (nothing is pruned). */
export type LaneStateReader = (
  address: LaneAddress,
  laneIds: string[],
) => Promise<Map<string, string | { state: string; pinned?: boolean }> | null>;
export type IdleLane = { laneId: string; outcome?: string; idleHours: number; root: string };
export type LaneHousekeeping = {
  idle: IdleLane[];
  /** Roots removed (apply only). */
  pruned: { laneId: string; root: string; bytes: number }[];
  /** Roots a dry run would remove; they still exist. Empty when applying. */
  wouldPrune: { laneId: string; root: string; bytes: number }[];
  kept: { laneId: string; reason: string }[];
  apply: boolean;
};

const exists = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};
/** Reads the Lane identity from a checkout marker without hydrating its source state. */
export function markerIdentity(root: string): { laneId: string; url: string; projectId: string } | null {
  try {
    const marker = JSON.parse(readFileSync(join(root, '.forge', 'hosted-lane.json'), 'utf8')) as {
      url?: unknown;
      selection?: { laneId?: unknown; projectId?: unknown };
    };
    const laneId = marker.selection?.laneId,
      projectId = marker.selection?.projectId;
    return typeof laneId === 'string' && uuid.test(laneId) && typeof projectId === 'string'
      ? { laneId, projectId, url: typeof marker.url === 'string' ? marker.url : '' }
      : null;
  } catch {
    return null;
  }
}
/** Newest change and allocated bytes; symlinks (node_modules) are never followed. */
function scanTree(paths: string[]) {
  let newest = 0,
    bytes = 0;
  const stack = [...paths];
  while (stack.length) {
    const path = stack.pop()!;
    const stat = exists(path);
    if (!stat) continue;
    newest = Math.max(newest, stat.mtimeMs);
    bytes += stat.blocks * 512;
    if (stat.isDirectory()) for (const name of readdirSync(path)) stack.push(join(path, name));
  }
  return { newest, bytes };
}
const siblings = (root: string) => [root, clientCacheRoot(root), rootSibling(root, '.forge-metrics.jsonl')];
const nestedLanes = (root: string) => {
  try {
    return readdirSync(join(clientCacheRoot(root), 'lanes')).length > 0;
  } catch {
    return false;
  }
};
const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);

/** Register hosted Lane checkouts found directly in DIRECTORY or under its ROOT.forge-client/lanes.
 * With `write` false nothing is recorded; `found` lists the unregistered checkouts instead. */
export function adoptLaneCheckouts(directory: string, now = Date.now(), write = true) {
  const links = new Map<string, string[]>();
  const found: LaneRegistryEntry[] = [];
  let adopted = 0;
  const adopt = (root: string) => {
    const identity = markerIdentity(root);
    if (!identity || listed.has(identity.laneId)) return;
    const stat = exists(join(root, '.forge', 'hosted-lane.json')),
      lastActionAt = Math.min(now, stat?.mtimeMs ?? now);
    if (!write) found.push({ ...identity, root, openedAt: now, lastActionAt });
    else if (recordLane({ ...identity, root, lastActionAt }, now)) adopted++;
    listed.add(identity.laneId);
  };
  const listed = new Set(listLanes().map(entry => entry.laneId));
  directory = canonicalRoot(directory);
  for (const name of readdirSync(directory)) {
    const path = join(directory, name),
      stat = exists(path);
    if (stat?.isSymbolicLink()) {
      const target = canonicalRoot(resolve(directory, readlinkSync(path)));
      links.set(target, [...(links.get(target) ?? []), path]);
    } else if (stat?.isDirectory() && name.endsWith('.forge-client')) {
      if (write) {
        try {
          sweepKeptApplyCache(path);
        } catch {
          /* Expiry bookkeeping never fails a scan. */
        }
      }
      let lanes: string[] = [];
      try {
        lanes = readdirSync(join(path, 'lanes'));
      } catch {}
      for (const lane of lanes) if (uuid.test(lane)) adopt(join(path, 'lanes', lane));
    } else if (stat?.isDirectory()) adopt(path);
  }
  return { adopted, links, found };
}

/** Idle listing plus prune of finished Lane roots, from the local registry and one batched read. */
export async function laneHousekeeping(input: {
  readStates: LaneStateReader;
  address?: LaneAddress;
  apply: boolean;
  settings?: Pick<ClientSettings, 'autoPruneHours' | 'idleLaneHours'> &
    Partial<Pick<ClientSettings, 'activeLanePruneHours'>>;
  /** Never removed: the caller's own root and Lane. */
  exclude?: { roots?: string[]; laneIds?: string[] };
  scan?: string;
  now?: number;
  /** Replaceable in tests. True when the root has edits that are not saved. */
  isDirty?: (root: string) => boolean;
}): Promise<LaneHousekeeping> {
  const now = input.now ?? Date.now(),
    settings = input.settings ?? readClientSettings();
  const pruneMs = settings.autoPruneHours * hour,
    idleMs = settings.idleLaneHours * hour,
    activeMs = (settings.activeLanePruneHours ?? DEFAULT_ACTIVE_PRUNE_HOURS) * hour;
  // A dry run (no apply) changes no registry file, pin mirror, link or checkout.
  const scanned = input.scan ? adoptLaneCheckouts(input.scan, now, input.apply) : null;
  const links = scanned?.links ?? new Map<string, string[]>();
  // A link whose Lane copy is gone (removed by GC or by hand) is only clutter; remove it with its target.
  if (input.apply)
    for (const [target, paths] of links)
      if (!exists(target) && target.includes(`.forge-client${sep}lanes${sep}`))
        for (const path of paths) rmSync(path, { force: true });
  const excludedRoots = (input.exclude?.roots ?? []).map(root => canonicalRoot(root));
  const workingRoot = canonicalRoot(process.cwd());
  const excludedLanes = new Set(input.exclude?.laneIds ?? []);
  const result: LaneHousekeeping = { idle: [], pruned: [], wouldPrune: [], kept: [], apply: input.apply };
  const entries: LaneRegistryEntry[] = [];
  for (const entry of [...listLanes(), ...(scanned?.found ?? [])]) {
    if (input.address && (entry.url !== input.address.url || entry.projectId !== input.address.projectId))
      continue;
    // A removed checkout leaves nothing to prune or list.
    if (!exists(entry.root)) {
      if (input.apply) forgetLane(entry.laneId);
    } else if (!excludedLanes.has(entry.laneId)) entries.push(entry);
  }
  const thresholds = [pruneMs, idleMs].filter(value => value > 0);
  // An open Lane's root is removed only past its own, longer age, and never when pruning is off.
  const activeLimit = pruneMs > 0 && activeMs > 0 ? Math.max(pruneMs, activeMs) : 0;
  if (!thresholds.length) return result;
  const due = entries.filter(entry => now - entry.lastActionAt >= Math.min(...thresholds));
  const states = new Map<string, string | null>();
  const pins = new Map<string, boolean>();
  const groups = new Map<string, LaneRegistryEntry[]>();
  for (const entry of due) {
    const key = JSON.stringify([entry.url, entry.projectId]);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  for (const [key, group] of groups) {
    const [url, projectId] = JSON.parse(key) as [string, string];
    for (let index = 0; index < group.length; index += 100) {
      const page = group.slice(index, index + 100);
      let read: Map<string, string | { state: string; pinned?: boolean }> | null = null;
      try {
        read = await input.readStates(
          { url, projectId },
          page.map(entry => entry.laneId),
        );
      } catch {
        read = null;
      }
      for (const entry of page) {
        const row = read?.get(entry.laneId);
        states.set(entry.laneId, row === undefined ? null : typeof row === 'string' ? row : row.state);
        if (read && row !== undefined)
          pins.set(entry.laneId, typeof row === 'string' ? false : Boolean(row.pinned));
      }
    }
  }
  const isDirty = input.isDirty ?? hostedLaneDirty;
  let dirtyChecks = 0;
  for (const entry of due) {
    const state = states.get(entry.laneId) ?? null,
      idleFor = now - entry.lastActionAt;
    // The server flag wins and refreshes this client's mirror; an unreadable server keeps the last known pin.
    const pinned = pins.get(entry.laneId) ?? Boolean(entry.pinned);
    if (input.apply && pins.has(entry.laneId) && pinned !== Boolean(entry.pinned))
      recordLane({ laneId: entry.laneId, pinned, lastActionAt: entry.lastActionAt }, now);
    if (pinned) {
      result.kept.push({ laneId: entry.laneId, reason: 'pinned' });
      continue;
    }
    const listIdle = () =>
      result.idle.push({
        laneId: entry.laneId,
        ...(entry.outcome ? { outcome: entry.outcome } : {}),
        idleHours: Math.round((idleFor / hour) * 10) / 10,
        root: entry.root,
      });
    // An active Lane idle past the active prune age loses its root only when nothing in it is unsaved
    // and no command runs in it; `open` restores it from the saved head.
    const activeIdle = state === 'active' && activeLimit > 0 && idleFor >= activeLimit;
    const limit = activeIdle ? activeLimit : pruneMs;
    if (state === 'active' && !activeIdle) {
      if (idleMs > 0 && idleFor >= idleMs) listIdle();
      continue;
    }
    if (!state || (!activeIdle && !terminal.has(state)) || limit === 0 || idleFor < limit) {
      if (!state) result.kept.push({ laneId: entry.laneId, reason: 'state unknown' });
      continue;
    }
    const root = canonicalRoot(entry.root);
    let reason =
      excludedRoots.some(path => inside(path, root) || inside(root, path)) || inside(workingRoot, root)
        ? 'in use by this command'
        : markerIdentity(root)?.laneId !== entry.laneId
          ? 'not this Lane checkout'
          : laneCommandRunning(entry)
            ? 'command running'
            : nestedLanes(root)
              ? 'contains other Lane roots'
              : null;
    if (!reason && activeIdle)
      reason =
        dirtyChecks++ >= DIRTY_CHECKS
          ? 'unsaved-edit check deferred'
          : isDirty(root)
            ? 'unsaved edits'
            : null;
    if (reason) {
      if (activeIdle && idleMs > 0 && idleFor >= idleMs) listIdle();
      result.kept.push({ laneId: entry.laneId, reason });
      continue;
    }
    const tree = scanTree(siblings(root));
    if (now - tree.newest < limit) {
      result.kept.push({ laneId: entry.laneId, reason: `modified within ${limit / hour}h` });
      continue;
    }
    if (input.apply) {
      logLanePrune(
        {
          laneId: entry.laneId,
          root,
          state,
          reason: `${state} Lane idle ${Math.round((idleFor / hour) * 10) / 10}h, threshold ${limit / hour}h`,
          idleHours: Math.round((idleFor / hour) * 10) / 10,
          bytes: tree.bytes,
        },
        now,
      );
      for (const path of siblings(root))
        if (path === clientCacheRoot(root)) removeCachePreservingKept(path);
        else rmSync(path, { recursive: true, force: true });
      for (const link of links.get(root) ?? []) rmSync(link, { force: true });
      forgetLane(entry.laneId);
    }
    (input.apply ? result.pruned : result.wouldPrune).push({ laneId: entry.laneId, root, bytes: tree.bytes });
  }
  return result;
}

/** The deployment's batched Lane state read. */
export function convexLaneStates(
  client: (address: LaneAddress) => {
    query: (name: unknown, args: Record<string, unknown>) => Promise<unknown>;
  },
): LaneStateReader {
  return async (address, laneIds) => {
    let value: unknown;
    try {
      value = await client(address).query(makeFunctionReference<'query'>('projectHostedLanes:states'), {
        projectId: address.projectId,
        laneIds,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /Could not find (?:public )?function|function .* not found/i.test(error.message)
      )
        return null;
      throw error;
    }
    const rows = (typeof value === 'string' ? JSON.parse(value) : value) as {
      laneId: string;
      state: string;
      pinned?: boolean;
    }[];
    return new Map(rows.map(row => [row.laneId, { state: row.state, pinned: row.pinned === true }]));
  };
}

/** Terse agent-facing lines; nothing when there is nothing to say. */
export function housekeepingLines(
  root: string,
  idle: IdleLane[],
  pruned: { count: number; bytes: number },
  apply = true,
): string[] {
  const lines: string[] = [];
  if (idle.length) {
    lines.push(`Idle Lanes (yours, no Forge action): ${idle.length}. Land or abandon them:`);
    for (const lane of idle.slice(0, 10))
      lines.push(
        `  ${lane.laneId} ${lane.idleHours}h ${lane.outcome ? JSON.stringify(lane.outcome.slice(0, 60)) : ''}`.trimEnd(),
      );
    lines.push(`  nforge x ${root} abandon '{"laneId":"LANE_ID","reason":"..."}'`);
  }
  if (pruned.count)
    lines.push(
      `${apply ? 'Pruned' : 'Would prune'} ${pruned.count} finished Lane root(s), ${(pruned.bytes / 1e9).toFixed(2)} GB.`,
    );
  return lines;
}

/** nforge prune [--apply] [--scan DIRECTORY] */
export async function pruneCli(args: string[], readStates: LaneStateReader) {
  let apply = false,
    scan: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply') apply = true;
    else if (args[index] === '--scan' && args[index + 1]) scan = args[++index];
    else invariant(false, 'BAD_ARGUMENT', 'Use prune [--apply] [--scan DIRECTORY].');
  }
  const settings = readClientSettings();
  // An explicit prune uses the configured age even when automatic prune is off.
  const hours = settings.autoPruneHours || 3;
  const result = await laneHousekeeping({
    readStates,
    apply,
    settings: {
      autoPruneHours: hours,
      idleLaneHours: settings.idleLaneHours,
      activeLanePruneHours: settings.activeLanePruneHours,
    },
    ...(scan ? { scan } : {}),
  });
  return { ...result, olderThanHours: hours };
}
