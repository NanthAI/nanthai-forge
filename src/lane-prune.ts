// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { removeCachePreservingKept } from './hosted-apply-kept.js';
import { canonicalRoot, clientCacheRoot, rootSibling } from './root-paths.js';
import { lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  isLaneDirectoryName,
  isNestedLaneCopy,
  markerIdentity,
  nestedLaneParent,
} from './hosted-lane-directory.js';
import { makeFunctionReference } from 'convex/server';
import {
  forgetLane,
  laneCommandRunning,
  laneRegistryDirectory,
  listLanes,
  readLaneEntry,
  recordLane,
  type LaneRegistryEntry,
} from './lane-registry.js';
import { logLanePrune } from './lane-prune-log.js';
import { readClientSettings, type ClientSettings } from './client-settings.js';
import { hostedLaneDirty } from './hosted-lane-dirty.js';
import { invariant } from './errors.js';
import { digest } from './hash.js';
import { hostedLaneMarkerName } from './forge-cache-paths.js';
import { readCacheUse, cacheUsePath } from './client-cache-use.js';
import type { PruneFolder } from './lane-prune-inventory.js';
import { processBlocker, workingProcesses } from './clean-processes.js';

const hour = 3_600_000;
/** An open Lane may be waiting on a long landing or review; its root outlives a week by default. */
const DEFAULT_ACTIVE_PRUNE_HOURS = 168;
/** Unsaved-edit checks hash a whole checkout; bound them per pass. */
const DIRTY_CHECKS = 8;
/** The detached snapshot worker writes its launch stamp before it can take the lock.
 * Keep a launch window as long as the worker's one-minute deadline. */
const SNAPSHOT_LAUNCH_MS = 60_000;
const terminal = new Set(['completed', 'abandoned']);
const receiptPageSize = 48;
export { markerIdentity };
export type LaneAddress = { url: string; projectId: string };
type LaneState = string | { state: string; pinned?: boolean; reason?: string; landedHead?: string };
type LaneStateGroup = { address: LaneAddress; laneIds: string[] };
/** Legacy single-project readers use 100-Lane pages; hosted prune uses 250 identities
 * across projects per deployment. Unavailable data never authorizes removal. */
export type LaneStateReader = ((
  address: LaneAddress,
  laneIds: string[],
  finishedOnly?: boolean,
) => Promise<Map<string, LaneState> | null>) & {
  batch?: (groups: LaneStateGroup[], finishedOnly?: boolean) => Promise<Map<string, LaneState> | null>;
};
export type IdleLane = { laneId: string; outcome?: string; idleHours: number; root: string };
/** An idle Lane on this machine that another agent run (or an unknown, older run) of the account
 * started (d730121f): listed so nobody is surprised, never offered for abandon. */
export type OtherRunLane = { laneId: string; idleHours: number; run: 'other' | 'unknown'; agent?: string };
export type LaneHousekeeping = {
  /** Idle Lanes this agent run started (all idle Lanes when no run is given, e.g. `nforge prune`). */
  idle: IdleLane[];
  /** Idle Lanes of other agent runs on the same account; only when a run is given. */
  otherRuns: OtherRunLane[];
  /** Roots removed (apply only). */
  pruned: { laneId: string; root: string; bytes: number }[];
  /** Roots a dry run would remove; they still exist. Empty when applying. */
  wouldPrune: { laneId: string; root: string; bytes: number }[];
  kept: { laneId: string; reason: string; root?: string }[];
  apply: boolean;
  folders?: PruneFolder[];
};

const exists = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};
/** Newest change and allocated bytes; symlinks (node_modules) are never followed. */
function scanTree(root: string, snapshots: string | null, deadline = Infinity, countNested = false) {
  const cache = clientCacheRoot(root);
  const use = snapshots && readCacheUse(root, false) ? exists(cacheUsePath(root)) : null;
  const scratch = join(root, '.forge', 'scratch');
  const recovery = join(cache, 'kept-apply');
  const laneMarkerSuffix = `${sep}.forge${sep}${hostedLaneMarkerName}`;
  let newest = 0,
    bytes = 0,
    rootBytes = 0,
    scratchBytes = 0,
    nested = false;
  const snapshotPrefix = snapshots === null ? null : snapshots + sep;
  const stack = siblings(root);
  while (stack.length) {
    if (Date.now() >= deadline) return null;
    const path = stack.pop()!;
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    // The worker replaces the stat index and creates/removes its lock, touching the directory
    // as well. Keep counting those bytes and the age of other entries, including recovery data.
    const snapshotBookkeeping =
      (path === snapshots && stat.isDirectory()) ||
      (snapshotPrefix &&
        stat.isFile() &&
        path.startsWith(snapshotPrefix) &&
        /^(?:stat\.json(?:\.\d+\.tmp)?|worker|lock)$/.test(path.slice(snapshotPrefix.length)));
    // An atomic cache-use replacement changes its parent's mtime even when the record
    // preserves the last actual use. The record and other cache entries keep their own ages.
    const cacheUseReplacement =
      path === cache && use?.isFile() && Math.abs(stat.mtimeMs - use.ctimeMs) < 1_000;
    if (!snapshotBookkeeping && !cacheUseReplacement) newest = Math.max(newest, stat.mtimeMs);
    bytes += stat.blocks * 512;
    if (inside(path, root)) rootBytes += stat.blocks * 512;
    if (inside(path, scratch)) scratchBytes += stat.blocks * 512;
    if (stat.isFile() && path.endsWith(laneMarkerSuffix) && !inside(path, recovery)) {
      const checkout = dirname(dirname(path));
      if (checkout !== root && markerIdentity(checkout)) nested = true;
    }
    if (stat.isDirectory()) {
      if (
        path !== root &&
        !inside(path, recovery) &&
        isLaneDirectoryName(basename(path)) &&
        nestedLaneParent(dirname(path))
      ) {
        nested = true;
        if (!countNested) continue;
      }
      for (const name of readdirSync(path)) stack.push(join(path, name));
    }
  }
  return { newest, bytes, rootBytes, scratchBytes, nested };
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

/** A redirect or checkout can appear after the age/source walk. Read only directory entries
 * here, and skip the recovery archive that the cache remover leaves intact. */
function nestedCheckoutBlocker(root: string, deadline: number) {
  const cache = clientCacheRoot(root);
  const recovery = join(cache, 'kept-apply');
  const directories = [root];
  try {
    if (lstatSync(cache, { throwIfNoEntry: false })?.isDirectory()) directories.push(cache);
    while (directories.length) {
      if (Date.now() >= deadline) return 'nested checkout recheck deferred';
      const directory = directories.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(directory, entry.name);
        if (path === recovery) continue;
        if (
          (isLaneDirectoryName(entry.name) && nestedLaneParent(directory)) ||
          (entry.name === '.forge' && directory !== root && markerIdentity(directory))
        )
          return 'contains other Lane roots';
        directories.push(path);
      }
    }
  } catch {
    return 'checkout could not be fully inspected';
  }
  return null;
}

/** Idle listing plus prune of finished Lane roots, from the local registry and one batched read. */
export async function laneHousekeeping(input: {
  readStates: LaneStateReader;
  address?: LaneAddress;
  apply: boolean;
  settings?: Pick<ClientSettings, 'autoPruneHours' | 'idleLaneHours'> &
    Partial<Pick<ClientSettings, 'activeLanePruneHours'>>;
  /** The calling agent run (session slug; null for a person). Given: `idle` lists only this run's
   * Lanes and the rest go to `otherRuns`. Omitted: every idle Lane is listed as before. */
  run?: string | null;
  /** Never removed: the caller's own root and Lane. */
  exclude?: { roots?: string[]; laneIds?: string[] };
  scan?: string;
  /** Cleanup scoped to landed and abandoned Lanes. */
  finishedOnly?: boolean;
  /** One automatic page on the deployment the command has already contacted. */
  automatic?: { url: string; idleProjectId: string; claim: () => boolean };
  /** The caller's automatic housekeeping time budget, including lifecycle reads. */
  budgetMs?: number;
  /** Report large scratch using the existing cache size budget as a reference. */
  scratchBudgetBytes?: number;
  /** Permanently deleted projects are eligible only in the explicit prune command. */
  deletedProjects?: boolean;
  now?: number;
  /** Replaceable in tests. True when the root has edits that are not saved. */
  isDirty?: (root: string) => boolean;
  processes?: () => ReturnType<typeof workingProcesses>;
}): Promise<LaneHousekeeping> {
  const budget = input.budgetMs ?? Infinity;
  const deadline = Date.now() + budget;
  const scanDeadline = deadline - Math.min(3_000, budget / 4);
  const now = input.now ?? Date.now(),
    settings = input.settings ?? readClientSettings();
  const pruneMs = settings.autoPruneHours * hour,
    idleMs = settings.idleLaneHours * hour,
    activeMs = (settings.activeLanePruneHours ?? DEFAULT_ACTIVE_PRUNE_HOURS) * hour;
  // A dry run (no apply) changes no registry file, pin mirror, link or checkout.
  const registered = listLanes();
  const registeredById = new Map(registered.map(entry => [entry.laneId, entry]));
  const scanned = input.scan
    ? (
        (await import(
          /* @vite-ignore */ new URL('./lane-prune-inventory.js', import.meta.url).href
        )) as typeof import('./lane-prune-inventory.js')
      ).scanLaneDirectory(input.scan, registered, now, input.apply && !input.finishedOnly)
    : null;
  const links = scanned?.links ?? new Map<string, string[]>();
  // A link whose Lane copy is gone (removed by GC or by hand) is only clutter; remove it with its target.
  if (input.apply && !input.finishedOnly)
    for (const [target, paths] of links)
      if (!exists(target) && target.includes(`.forge-client${sep}lanes${sep}`))
        for (const path of paths) rmSync(path, { force: true });
  const excludedRoots = (input.exclude?.roots ?? []).map(root => canonicalRoot(root));
  const workingRoot = canonicalRoot(process.cwd());
  let processes: ReturnType<typeof workingProcesses> | undefined;
  const excludedLanes = new Set(input.exclude?.laneIds ?? []);
  const result: LaneHousekeeping = {
    idle: [],
    otherRuns: [],
    pruned: [],
    wouldPrune: [],
    kept: [],
    apply: input.apply,
    ...(scanned ? { folders: scanned.folders } : {}),
  };
  const entries: LaneRegistryEntry[] = [];
  const found = new Map((scanned?.found ?? []).map(entry => [entry.laneId, entry]));
  const kept = (entry: LaneRegistryEntry, reason: string) => {
    result.kept.push({ laneId: entry.laneId, reason, ...(input.scan ? { root: entry.root } : {}) });
    const folder = scanned?.byRoot.get(entry.root);
    if (folder) folder.reason = reason;
  };
  for (const entry of [...registered.filter(entry => !found.has(entry.laneId)), ...found.values()]) {
    if (input.automatic && entry.url !== input.automatic.url) continue;
    if (input.address && (entry.url !== input.address.url || entry.projectId !== input.address.projectId))
      continue;
    // A missing checkout may be a start that has reserved its path but not installed
    // the tree yet. Unreadable paths are not evidence that a root went away.
    try {
      if (!lstatSync(entry.root, { throwIfNoEntry: false })) {
        if (input.apply && !input.finishedOnly && now - entry.lastActionAt >= hour) {
          const latest = readLaneEntry(entry.laneId);
          if (
            latest?.root === entry.root &&
            latest.lastActionAt === entry.lastActionAt &&
            !laneCommandRunning(latest) &&
            !latest.landing &&
            !latest.hold &&
            !latest.pinned
          )
            forgetLane(entry.laneId);
        }
        continue;
      }
    } catch {
      kept(entry, 'checkout path could not be inspected');
      continue;
    }
    if (excludedLanes.has(entry.laneId)) {
      if (!input.automatic) kept(entry, 'in use by this command');
    } else entries.push(entry);
  }
  const thresholds = [pruneMs, input.finishedOnly && input.automatic ? 0 : idleMs].filter(value => value > 0);
  // An open Lane's root is removed only past its own, longer age, and never when pruning is off.
  const activeLimit = !input.finishedOnly && pruneMs > 0 && activeMs > 0 ? Math.max(pruneMs, activeMs) : 0;
  if (!thresholds.length) return result;
  let due = entries.filter(entry => {
    if (now - entry.lastActionAt >= Math.min(...thresholds)) return true;
    const folder = scanned?.byRoot.get(entry.root);
    if (folder) folder.reason = 'recent Forge action';
    return false;
  });
  const auto = input.automatic;
  let cursorScope: unknown = input.address;
  if (auto) {
    due = due.filter(entry => {
      try {
        const path = canonicalRoot(entry.root);
        return (
          !inside(workingRoot, path) && !excludedRoots.some(root => inside(root, path) || inside(path, root))
        );
      } catch {
        return false;
      }
    });
    // Give the page to reclaimable ages before looking at advice for the caller's project.
    const pruneDue = pruneMs > 0 ? due.filter(entry => now - entry.lastActionAt >= pruneMs) : [];
    cursorScope = [auto.url, pruneDue.length ? null : auto.idleProjectId];
    due = pruneDue.length ? pruneDue : due.filter(entry => entry.projectId === auto.idleProjectId);
  }
  // Large local inventories continue from the previous bounded start instead
  // of repeatedly inspecting the same dirty or very large folders first.
  const cursor =
    (input.apply || auto) && input.budgetMs !== undefined && (input.address || auto) && due.length
      ? join(dirname(laneRegistryDirectory()), `prune-${digest(JSON.stringify(cursorScope))}.cursor`)
      : null;
  let resumed = false;
  if (cursor) {
    due.sort((a, b) => a.laneId.localeCompare(b.laneId));
    try {
      const last = readFileSync(cursor, 'utf8');
      const offset = due.findIndex(entry => entry.laneId > last);
      if (offset > 0) {
        due = due.slice(offset);
        resumed = true;
      }
    } catch {
      // A missing cursor starts at the first Lane.
    }
  }
  const moreDue = Boolean(input.automatic && due.length > receiptPageSize);
  if (input.automatic) {
    due = due.slice(0, receiptPageSize);
    if (!input.readStates.batch) return result;
  }
  const verifyCompleted = Boolean(input.finishedOnly || (auto && input.apply));
  const states = new Map<string, string | null>();
  const landedHeads = new Map<string, string>();
  const pins = new Map<string, boolean>();
  const groups = new Map<string, LaneRegistryEntry[]>();
  for (const entry of due) {
    const key = JSON.stringify([entry.url, entry.projectId]);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const reasons = new Map<string, string>();
  const pages: LaneStateGroup[][] = [];
  // One page can contain many projects, but credentials never cross deployment origins.
  const deployments = new Map<string, LaneStateGroup[]>();
  for (const [key, group] of groups) {
    const [url, projectId] = JSON.parse(key) as [string, string];
    const pending = deployments.get(url) ?? [];
    pending.push({ address: { url, projectId }, laneIds: group.map(entry => entry.laneId) });
    deployments.set(url, pending);
  }
  for (const deployment of deployments.values()) {
    let page: LaneStateGroup[] = [],
      size = 0;
    for (const group of deployment) {
      for (const laneId of group.laneIds) {
        const limit = verifyCompleted ? receiptPageSize : input.readStates.batch ? 250 : 100;
        if (
          size === limit ||
          (!input.readStates.batch && page.length > 0 && page[0]?.address !== group.address)
        ) {
          pages.push(page);
          page = [];
          size = 0;
        }
        let selected = page.at(-1);
        if (selected?.address !== group.address) {
          selected = { address: group.address, laneIds: [] };
          page.push(selected);
        }
        selected.laneIds.push(laneId);
        size++;
      }
    }
    if (page.length) pages.push(page);
  }
  let pageRead = false;
  for (const page of pages) {
    if (Date.now() >= scanDeadline) break;
    if (input.automatic && !input.automatic.claim()) return result;
    let read: Map<string, LaneState> | null = null;
    let failure =
      'State read unavailable: check sign-in and deployment/CLI compatibility, then rerun nforge prune; copy retained.';
    try {
      read = input.readStates.batch
        ? await input.readStates.batch(page, verifyCompleted)
        : await input.readStates(page[0]!.address, page[0]!.laneIds, verifyCompleted);
      pageRead ||= read !== null;
    } catch (error) {
      const code =
        (error as { code?: string; data?: { code?: string } } | null)?.data?.code ??
        (error as { code?: string } | null)?.code;
      if (code === 'PROJECT_UNAVAILABLE' || code === 'AUTH_REQUIRED')
        failure = `${code}: restore project access/sign-in, then rerun nforge prune; copy retained.`;
    }
    for (const { laneIds } of page)
      for (const laneId of laneIds) {
        const row = read?.get(laneId);
        const state = row === undefined ? null : typeof row === 'string' ? row : row.state;
        states.set(laneId, state);
        if (typeof row === 'object' && row.landedHead) landedHeads.set(laneId, row.landedHead);
        // An inaccessible/missing record contains no current pin evidence. Keep the local
        // mirror so offline cache GC cannot evict a previously pinned copy.
        if (read && row !== undefined && state && (state === 'active' || terminal.has(state)))
          pins.set(laneId, typeof row === 'string' ? false : Boolean(row.pinned));
        reasons.set(laneId, typeof row === 'object' && row.reason ? row.reason : failure);
      }
  }
  const isDirty = input.isDirty ?? (root => hostedLaneDirty(root, { preserveMaterializedSubmodules: true }));
  let dirtyChecks = 0;
  let snapshotHelpers: typeof import('./lane-snapshot-hint.js') | undefined;
  const checkUnsaved = (root: string, bounded: boolean) =>
    bounded && dirtyChecks++ >= DIRTY_CHECKS
      ? 'unsaved-edit check deferred'
      : isDirty(root)
        ? 'unsaved edits'
        : null;
  const measure = (entry: LaneRegistryEntry, tree: NonNullable<ReturnType<typeof scanTree>>) => {
    const folder = scanned?.byRoot.get(entry.root);
    if (!folder) return;
    folder.bytes = tree.bytes;
    folder.scratchBytes = tree.scratchBytes;
    if (input.scratchBudgetBytes && tree.scratchBytes > input.scratchBudgetBytes) folder.largeScratch = true;
  };
  const observe = input.processes ?? (() => workingProcesses(true));
  const runningProcess = (root: string, observed: ReturnType<typeof workingProcesses>) => {
    for (const path of siblings(root)) {
      const reason = processBlocker(path, observed);
      if (reason) return reason;
    }
    return null;
  };
  // Observe again after potentially expensive source inspection, in small batches
  // so this check remains close to removal without one process census per Lane.
  const pending: ((observed: ReturnType<typeof workingProcesses>) => void)[] = [];
  const flush = () => {
    if (!pending.length || Date.now() >= deadline) return;
    processes = observe();
    for (const remove of pending.splice(0)) remove(processes);
  };
  let lastInspected: string | undefined;
  for (const entry of due) {
    if (Date.now() >= scanDeadline) break;
    lastInspected = entry.laneId;
    const state = states.get(entry.laneId) ?? null,
      idleFor = now - entry.lastActionAt;
    // The server flag wins and refreshes this client's mirror; an unreadable server keeps the last known pin.
    const pinned = pins.get(entry.laneId) ?? Boolean(entry.pinned);
    if (pinned) {
      const latest = input.apply && !found.has(entry.laneId) && !entry.pinned && readLaneEntry(entry.laneId);
      if (latest && latest.root === entry.root && latest.lastActionAt === entry.lastActionAt)
        recordLane({ laneId: entry.laneId, pinned: true, lastActionAt: latest.lastActionAt }, now);
      kept(entry, 'pinned');
      continue;
    }
    const idleHours = Math.round((idleFor / hour) * 10) / 10;
    // Yours only when this run recorded the Lane: an entry with no run (older client, adopted or
    // reopened checkout) is the same account but an unknown run, and is never offered for abandon.
    const listIdle = () => {
      if (auto && entry.projectId !== auto.idleProjectId) return;
      return input.run === undefined || (entry.agent !== undefined && entry.agent === input.run)
        ? result.idle.push({
            laneId: entry.laneId,
            ...(entry.outcome ? { outcome: entry.outcome } : {}),
            idleHours,
            root: entry.root,
          })
        : result.otherRuns.push({
            laneId: entry.laneId,
            idleHours,
            run: entry.agent === undefined ? 'unknown' : 'other',
            ...(entry.agent ? { agent: entry.agent } : {}),
          });
    };
    // An active Lane idle past the active prune age loses its root only when nothing in it is unsaved
    // and no command runs in it; `open` restores it from the saved head.
    const deleted = !input.finishedOnly && input.deletedProjects === true && state === 'project-deleted';
    const activeIdle = state === 'active' && activeLimit > 0 && idleFor >= activeLimit;
    const limit = activeIdle ? activeLimit : pruneMs;
    if (state === 'active' && !activeIdle) {
      if (idleMs > 0 && idleFor >= idleMs) listIdle();
      const folder = scanned?.byRoot.get(entry.root);
      if (folder) folder.reason = 'active Lane';
      continue;
    }
    if (input.finishedOnly && state === 'project-deleted') {
      kept(entry, 'project deleted; finished Lane state unavailable');
      continue;
    }
    if (!state || (!activeIdle && !deleted && !terminal.has(state)) || limit === 0 || idleFor < limit) {
      const reason = reasons.get(entry.laneId);
      if (!state || !terminal.has(state)) kept(entry, reason ?? 'Lane state unavailable');
      else if (scanned?.byRoot.has(entry.root))
        kept(entry, limit ? `Forge action within ${limit / hour}h` : 'automatic pruning disabled');
      continue;
    }
    let root: string;
    try {
      root = canonicalRoot(entry.root);
    } catch {
      kept(entry, 'checkout path could not be inspected');
      continue;
    }
    const identity = markerIdentity(root);
    if (
      verifyCompleted &&
      state === 'completed' &&
      (!identity?.head || landedHeads.get(entry.laneId) !== identity.head)
    ) {
      kept(entry, 'no verified landing for this checkout head');
      continue;
    }
    const marker = join(root, '.forge', 'hosted-lane.json');
    const before = exists(marker);
    if (deleted && (root !== resolve(entry.root) || !isNestedLaneCopy(root))) {
      kept(entry, 'outside the Lane checkout cache');
      continue;
    }
    const unsafeLink = () =>
      exists(entry.root)?.isSymbolicLink() || exists(clientCacheRoot(root))?.isSymbolicLink();
    let reason =
      excludedRoots.some(path => inside(path, root) || inside(root, path)) || inside(workingRoot, root)
        ? 'in use by this command'
        : identity?.laneId !== entry.laneId ||
            identity.projectId !== entry.projectId ||
            identity.url !== entry.url ||
            !before?.isFile() ||
            unsafeLink()
          ? 'not this Lane checkout'
          : laneCommandRunning(entry) ||
              (deleted && (entry.landing || entry.hold)) ||
              exists(join(clientCacheRoot(root), 'lock'))
            ? 'command running'
            : nestedLanes(root)
              ? 'contains other Lane roots'
              : runningProcess(root, (processes ??= observe()));
    if (reason) {
      if (activeIdle && idleMs > 0 && idleFor >= idleMs) listIdle();
      kept(entry, reason);
      continue;
    }
    if (!activeIdle)
      snapshotHelpers ??= (await import(
        /* @vite-ignore */ new URL('./lane-snapshot-hint.js', import.meta.url).href
      )) as typeof import('./lane-snapshot-hint.js');
    const snapshots = activeIdle ? null : (snapshotHelpers?.snapshotDirectory(root) ?? null);
    let tree: ReturnType<typeof scanTree>;
    try {
      tree = scanTree(root, snapshots, scanDeadline, Boolean(scanned?.byRoot.has(entry.root)));
    } catch {
      kept(entry, 'checkout could not be fully inspected');
      continue;
    }
    if (!tree) break;
    measure(entry, tree);
    const snapshotBusy = (time: number) => {
      if (!snapshots || !snapshotHelpers) return false;
      const worker = exists(join(snapshots, 'worker'));
      return (
        (worker !== null && time - worker.mtimeMs < SNAPSHOT_LAUNCH_MS) ||
        snapshotHelpers.snapshotLockHeld(root)
      );
    };
    reason = tree.nested
      ? 'contains other Lane roots'
      : now - tree.newest < limit
        ? `modified within ${limit / hour}h`
        : snapshotBusy(now)
          ? 'snapshot running'
          : checkUnsaved(root, activeIdle || deleted);
    if (reason) {
      if (activeIdle && idleMs > 0 && idleFor >= idleMs) listIdle();
      kept(entry, reason);
      continue;
    }
    const reclaimedBytes = input.automatic ? tree.rootBytes : tree.bytes;
    const recordResult = () => {
      const companion = scanned?.byRoot.get(clientCacheRoot(root));
      if (companion)
        companion.reason = input.apply
          ? exists(companion.root)
            ? 'retained checkout recovery'
            : 'removed with Lane checkout'
          : 'would be pruned with Lane checkout, retaining any recovery';
      const folder = scanned?.byRoot.get(entry.root);
      if (folder) folder.reason = input.apply ? `${state} Lane pruned` : `${state} Lane eligible for prune`;
      (input.apply ? result.pruned : result.wouldPrune).push({
        laneId: entry.laneId,
        root,
        bytes: reclaimedBytes,
      });
    };
    if (!input.apply) {
      recordResult();
      continue;
    }
    pending.push(observed => {
      if (Date.now() >= deadline) return;
      const blocked = runningProcess(root, observed);
      if (blocked) {
        kept(entry, blocked);
        return;
      }
      if (snapshotBusy(input.now ?? Date.now())) {
        kept(entry, 'snapshot running');
        return;
      }
      const latest = readLaneEntry(entry.laneId);
      const original = registeredById.get(entry.laneId);
      const after = exists(marker);
      if (
        !after ||
        before!.ino !== after.ino ||
        before!.ctimeMs !== after.ctimeMs ||
        unsafeLink() ||
        exists(join(clientCacheRoot(root), 'lock')) ||
        nestedLanes(root) ||
        latest?.lastActionAt !== original?.lastActionAt ||
        latest?.root !== original?.root ||
        (latest &&
          ((latest.pinned && !original?.pinned) ||
            laneCommandRunning(latest) ||
            (!terminal.has(state) && (latest.hold || latest.landing))))
      ) {
        kept(entry, 'Lane use changed during prune');
        return;
      }
      const nestedCheckout = nestedCheckoutBlocker(root, deadline);
      if (nestedCheckout) {
        kept(entry, nestedCheckout);
        return;
      }
      // A writer could have saved an edit and exited after the initial check and
      // before the final process census. Check again before automatic removal.
      if (input.automatic && isDirty(root)) {
        kept(entry, 'unsaved edits');
        return;
      }
      if (Date.now() >= deadline) return;
      logLanePrune(
        {
          laneId: entry.laneId,
          root,
          state,
          reason: `${state} Lane idle ${idleHours}h, threshold ${limit / hour}h`,
          idleHours,
          bytes: reclaimedBytes,
        },
        now,
      );
      try {
        // Keep the checkout and its verifiable marker available for another pass if
        // adjacent generated files cannot be removed.
        if (!input.automatic) {
          removeCachePreservingKept(clientCacheRoot(root));
          rmSync(rootSibling(root, '.forge-metrics.jsonl'), { force: true, recursive: true });
        }
        rmSync(root, { recursive: true, force: true });
        if (!deleted) for (const link of links.get(root) ?? []) rmSync(link, { force: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOTEMPTY') throw error;
        kept(entry, 'removal interrupted (ENOTEMPTY); remaining files retained');
        return;
      }
      forgetLane(entry.laneId);
      recordResult();
    });
    if (pending.length === 16) flush();
  }
  flush();
  if (cursor && lastInspected && (!auto || pageRead)) {
    try {
      if (moreDue || Date.now() >= scanDeadline || (!auto && resumed))
        writeFileSync(cursor, lastInspected, { mode: 0o600 });
      else if (auto) rmSync(cursor, { force: true });
    } catch {
      // Cursor bookkeeping is advisory.
    }
  }
  if (input.apply)
    for (const entry of entries) {
      if (!entry.pinned || pins.get(entry.laneId) !== false || found.has(entry.laneId)) continue;
      const latest = readLaneEntry(entry.laneId);
      if (latest?.pinned && latest.root === entry.root && latest.lastActionAt === entry.lastActionAt)
        recordLane({ laneId: entry.laneId, pinned: false, lastActionAt: latest.lastActionAt }, now);
    }
  if (input.apply && !input.finishedOnly)
    for (const entry of found.values()) {
      if (!exists(entry.root)) continue;
      const original = registeredById.get(entry.laneId);
      const latest = readLaneEntry(entry.laneId);
      if (latest?.root === original?.root && latest?.lastActionAt === original?.lastActionAt)
        recordLane({ ...entry, pinned: pins.get(entry.laneId) ?? entry.pinned }, now);
    }
  if (scanned)
    for (const entry of entries) {
      const folder = scanned.byRoot.get(entry.root);
      if (!folder || folder.bytes !== undefined || !exists(entry.root)) continue;
      try {
        const tree = scanTree(entry.root, null, deadline, true);
        if (tree) measure(entry, tree);
      } catch {
        // Keep the lifecycle reason and omit an incomplete size.
      }
    }
  return result;
}

/** The deployment's batched Lane state read. */
export function convexLaneStates(
  client: (address: LaneAddress) => {
    query: (name: unknown, args: Record<string, unknown>) => Promise<unknown>;
  },
): LaneStateReader {
  const read = async (groups: LaneStateGroup[], batched: boolean, finishedOnly?: boolean) => {
    const { address, laneIds } = groups[0]!;
    const rest = groups.slice(1);
    let value: unknown;
    try {
      value = await client(address).query(makeFunctionReference<'query'>('projectHostedLanes:states'), {
        projectId: address.projectId,
        laneIds,
        ...(finishedOnly ? { checkoutReceipts: 1 } : {}),
        ...(batched
          ? {
              additionalProjects: rest.map(group => ({
                projectId: group.address.projectId,
                laneIds: group.laneIds,
              })),
            }
          : {}),
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
      reason?: string;
      landedHead?: string;
    }[];
    return new Map(
      rows.map(row => [
        row.laneId,
        {
          state: row.state,
          pinned: row.pinned === true,
          ...(row.landedHead ? { landedHead: row.landedHead } : {}),
          ...(row.reason ? { reason: row.reason } : {}),
        },
      ]),
    );
  };
  return Object.assign(
    (address: LaneAddress, laneIds: string[], finishedOnly?: boolean) =>
      read([{ address, laneIds }], false, finishedOnly),
    { batch: (groups: LaneStateGroup[], finishedOnly?: boolean) => read(groups, true, finishedOnly) },
  );
}

/** Terse agent-facing lines; nothing when there is nothing to say. */
export function housekeepingLines(
  root: string,
  idle: IdleLane[],
  pruned: { count: number; bytes: number },
  apply = true,
  otherRuns: OtherRunLane[] = [],
): string[] {
  const lines: string[] = [];
  if (idle.length) {
    lines.push(`Idle Lanes (this agent run's, no Forge action): ${idle.length}. Land or abandon them:`);
    for (const lane of idle.slice(0, 10))
      lines.push(
        `  ${lane.laneId} ${lane.idleHours}h ${lane.outcome ? JSON.stringify(lane.outcome.slice(0, 60)) : ''}`.trimEnd(),
      );
    lines.push(`  nforge agent ${root} abandon '{"laneId":"LANE_ID","reason":"..."}'`);
  }
  // Same account, another agent run: never an abandon offer (d730121f); their owner decides.
  if (otherRuns.length)
    lines.push(
      `Idle Lanes of other agent runs on this account (not yours; leave them): ${otherRuns.length}: ${otherRuns
        .slice(0, 5)
        .map(
          lane =>
            `${lane.laneId.slice(0, 8)} ${lane.idleHours}h${lane.run === 'unknown' ? ' (unknown run)' : ''}`,
        )
        .join(', ')}${otherRuns.length > 5 ? ', ...' : ''}`,
    );
  if (pruned.count)
    lines.push(
      `${apply ? 'Pruned' : 'Would prune'} ${pruned.count} finished Lane root(s), ${(pruned.bytes / 1e9).toFixed(2)} GB.`,
    );
  return lines;
}

/** nforge prune [--apply] [--finished-only] [--scan DIRECTORY] */
export async function pruneCli(args: string[], readStates: LaneStateReader) {
  let apply = false,
    finishedOnly = false,
    scan: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply') apply = true;
    else if (args[index] === '--finished-only') finishedOnly = true;
    else if (args[index] === '--scan' && args[index + 1]) scan = args[++index];
    else invariant(false, 'BAD_ARGUMENT', 'Use prune [--apply] [--finished-only] [--scan DIRECTORY].');
  }
  const settings = readClientSettings();
  const localLanes = join(clientCacheRoot(process.cwd()), 'lanes');
  if (!scan && exists(localLanes)?.isDirectory()) scan = localLanes;
  // An explicit prune uses the configured age even when automatic prune is off.
  const hours = settings.autoPruneHours || 3;
  const result = await laneHousekeeping({
    readStates,
    apply,
    deletedProjects: true,
    finishedOnly,
    scratchBudgetBytes: settings.clientCacheMaxGB * 1e9,
    settings: {
      autoPruneHours: hours,
      idleLaneHours: settings.idleLaneHours,
      activeLanePruneHours: settings.activeLanePruneHours,
    },
    ...(scan ? { scan } : {}),
  });
  const { pruneDependencyCache } = (await import(
    /* @vite-ignore */ new URL('./dependency-cache.js', import.meta.url).href
  )) as typeof import('./dependency-cache.js');
  const dependencies = pruneDependencyCache({ apply: apply && !finishedOnly, remeasure: true });
  return { ...result, olderThanHours: hours, dependencies };
}
