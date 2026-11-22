// SPDX-License-Identifier: Apache-2.0
import { homedir } from 'node:os';
import { canonicalRoot } from './root-paths.js';
import { randomUUID } from 'node:crypto';
import { processAlive } from './local-process.js';
import { startIdentity } from './heavy-queue.js';
import { fileURLToPath } from 'node:url';
import { lstatSync, readFileSync, readdirSync, rmSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { tryHeavySlot } from './heavy-slots.js';
import { removeInstall } from './dependency-seal.js';
import { dependencyCacheDiskUsage } from './dependency-cache-disk.js';
import { dependencyRootExists, dependencyRoots } from './dependency-cache-roots.js';
import {
  dependencyProject,
  downloadCachePath,
  privateDownloadDirectory,
  sharedDownloadCache,
} from './install-download-cache.js';
import type { PackageManager } from './package-manager.js';
import { readClientSettings } from './client-settings.js';

const ENTRY = /^((?:npm|pnpm|yarn|bun)(?:-scripts|-rebuild|-skipped)?-[0-9a-f]{24})(?:\.tmp-[a-zA-Z0-9]+)?$/;
const lockDirectory = (entry: string) => join(dirname(entry), `${ENTRY.exec(basename(entry))![1]}.lock`);
/** Made while holding the entry lock, then held without that exclusive lock during a relink.
 * A shared rollback lease avoids an A→B / B→A install-lock cycle across two Lanes. */
export function retainDependencyEntry(entry: string): () => void {
  return retain(lockDirectory(entry));
}
function retain(directory: string): () => void {
  const path = join(directory, `keep-${process.pid}-${randomUUID()}`);
  writeFileSync(path, JSON.stringify({ pid: process.pid, startTime: startIdentity(process.pid) }));
  return () => rmSync(path, { force: true });
}
function retained(directory: string, apply: boolean): boolean {
  let live = false;
  for (const name of readdirSync(directory).filter(name => name.startsWith('keep-'))) {
    const path = join(directory, name);
    let identity = { pid: Number(name.split('-')[1]) } as { pid: number; startTime?: string };
    try {
      identity = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      /* The filename still identifies a partial writer. */
    }
    if (processAlive(identity)) live = true;
    else if (apply) rmSync(path, { force: true });
  }
  return live;
}

/** Fence a store against eviction while the package manager uses it. Concurrent
 * installers share the store and hold their own leases through the install. */
export function retainDownloadCache(cache: string, manager: PackageManager, project: string | null) {
  const spelling = cache;
  cache = canonicalRoot(cache);
  const directory = sharedDownloadCache(cache, manager, project);
  if (!directory) return null;
  const lockDirectory = `${directory}.lock`;
  if (stat(lockDirectory) && !privateDownloadDirectory(lockDirectory)) return null;
  const lock = tryHeavySlot(lockDirectory, 1);
  if (!lock) return null;
  try {
    if (!sharedDownloadCache(cache, manager, project)) return null;
    const now = new Date();
    utimesSync(directory, now, now);
    return { directory: join(spelling, relative(cache, directory)), release: retain(lockDirectory) };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const USAGE = '.forge-usage.json';
const DEFAULT_BYTES = 4 * 1024 ** 3;
type Usage = {
  bytes?: number;
  tools?: number;
  folders?: string[];
  used: number;
  roots: string[];
  download?: string;
};
const stat = (path: string) => lstatSync(path, { throwIfNoEntry: false });
const writeUsage = (entry: string, value: Usage) => {
  const next = join(entry, '.forge-usage.next');
  writeFileSync(next, JSON.stringify(value));
  renameSync(next, join(entry, USAGE));
};
const usage = (entry: string): Usage => {
  try {
    const value = JSON.parse(readFileSync(join(entry, USAGE), 'utf8'));
    if (
      Number.isFinite(value.used) &&
      Array.isArray(value.roots) &&
      value.roots.every((r: unknown) => typeof r === 'string')
    )
      return value;
  } catch {}
  return { used: stat(join(entry, '.forge-complete'))?.mtimeMs ?? 0, roots: [] };
};
/** Do not follow package/workspace symlinks outside the cache. */
function bytes(path: string): number {
  const found = stat(path);
  if (!found) return 0;
  if (!found.isDirectory()) return found.size;
  return readdirSync(path).reduce((sum, name) => sum + bytes(join(path, name)), found.size);
}
/** Sealed package trees cannot grow, but tools may create writable cache directories beside them.
 * Stat top-level entries only; walk writable tool output, never the sealed package contents again. */
function toolBytes(entry: string, folders: string[] = []): number {
  let total = 0;
  for (const folder of ['', ...folders]) {
    const modules = join(entry, folder, 'node_modules');
    if (!stat(modules)?.isDirectory()) continue;
    for (const name of readdirSync(modules)) {
      const path = join(modules, name),
        found = stat(path);
      if (found && !found.isSymbolicLink() && found.mode & 0o222) total += bytes(path);
    }
  }
  return total;
}
/** Called under the entry lock, after publishing the Lane links. Main and custom roots are recorded too. */
export function touchDependencyEntry(entry: string, root: string, folders?: string[], download?: string) {
  const previous = usage(entry);
  const roots = previous.roots.filter(dependencyRootExists);
  writeUsage(entry, {
    ...previous,
    ...(folders ? { folders } : {}),
    ...(download ? { download: canonicalRoot(download) } : {}),
    used: Date.now(),
    roots: [...new Set([...roots, canonicalRoot(root)])],
  });
}
type DependencyCachePrune = {
  budgetBytes: number;
  status: 'measured' | 'busy' | 'unavailable';
  bytes: number | null;
  downloadBytes?: number | null;
  installedBytes?: number | null;
  removed: { entry: string; bytes: number }[];
  wouldRemove: { entry: string; bytes: number }[];
  kept: { entry: string; reason: string; bytes?: number | null; idleLaneIds?: string[] }[];
  apply: boolean;
};
/** Local, nonblocking LRU sweep. The budget is soft when live links or running installs need more.
 * A linker and an evictor hold the SAME per-entry lock through publication/deletion: a start that
 * loses the race installs again, and a start that wins publishes its reference before GC can act.
 * No daemon, network, timers or background work. Unknown cache contents are left alone. */
export function pruneDependencyCache(
  options: {
    cache?: string;
    budgetBytes?: number;
    roots?: string[];
    apply?: boolean;
    remeasure?: boolean;
  } = {},
): DependencyCachePrune {
  let cache = resolve(
    options.cache ?? join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'forge', 'deps'),
  );
  const configured = Number(process.env.FORGE_DEPS_CACHE_MAX_GB);
  const budgetBytes =
    options.budgetBytes ??
    (Number.isFinite(configured) && configured > 0 ? configured * 1024 ** 3 : DEFAULT_BYTES);
  const result: DependencyCachePrune = {
    budgetBytes,
    status: 'measured',
    bytes: 0,
    ...(options.remeasure ? { downloadBytes: 0, installedBytes: 0 } : {}),
    removed: [],
    wouldRemove: [],
    kept: [],
    apply: options.apply ?? true,
  };
  if (!stat(cache)) return result;
  cache = canonicalRoot(cache);
  const sweepDirectory = join(cache, '.gc.lock');
  if (stat(sweepDirectory) && !privateDownloadDirectory(sweepDirectory))
    return {
      ...result,
      status: 'unavailable',
      bytes: null,
      ...(options.remeasure ? { downloadBytes: null, installedBytes: null } : {}),
    };
  const sweep = tryHeavySlot(sweepDirectory, 1);
  if (!sweep)
    return {
      ...result,
      status: 'busy',
      bytes: null,
      ...(options.remeasure ? { downloadBytes: null, installedBytes: null } : {}),
    };
  let installedBytes = 0;
  let disk: ReturnType<typeof dependencyCacheDiskUsage> | undefined;
  try {
    const { referenced, idleLaneLinks } = dependencyRoots(
      options.roots ?? [],
      dirname(dirname(fileURLToPath(import.meta.url))),
    );
    const retainedLinks = options.remeasure ? new Set<string>() : undefined;
    const entries = readdirSync(cache)
      .filter(name => ENTRY.test(name) && stat(join(cache, name))?.isDirectory())
      .map(name => ({ entry: join(cache, name), ...usage(join(cache, name)) }));
    // Running installers own the base lock, including temporary stages; abandoned stages can go.
    for (const item of entries) {
      if (
        !options.remeasure &&
        Number.isFinite(item.bytes) &&
        item.bytes! >= 0 &&
        Number.isFinite(item.tools)
      ) {
        item.bytes = item.bytes! - (item.tools ?? 0) + toolBytes(item.entry, item.folders);
        installedBytes += item.bytes;
        continue;
      }
      const directory = lockDirectory(item.entry);
      const lock =
        !stat(directory) || privateDownloadDirectory(directory) ? tryHeavySlot(directory, 1) : null;
      if (!lock) {
        installedBytes += item.bytes ?? 0;
        result.kept.push({ entry: item.entry, reason: 'Install or link is running.' });
        continue;
      }
      try {
        if (!stat(item.entry)) continue;
        item.bytes =
          options.remeasure || !Number.isFinite(item.bytes) || item.bytes! < 0
            ? bytes(item.entry)
            : item.bytes!;
        item.tools = toolBytes(item.entry, item.folders);
        installedBytes += item.bytes!;
        if (result.apply)
          writeUsage(item.entry, {
            bytes: item.bytes!,
            tools: item.tools,
            folders: item.folders ?? [],
            used: item.used,
            roots: item.roots,
            ...(item.download ? { download: item.download } : {}),
          });
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    }
    if (options.remeasure) {
      try {
        disk = dependencyCacheDiskUsage(cache, sweep);
      } catch {
        // Keep the existing installed-tree sweep available if disk accounting fails.
      }
    }
    const stores = [...(disk?.entries ?? [])]
      .filter(([path]) => {
        const parent = dirname(path);
        return (
          /^[0-9a-f]{16}$/.test(basename(path)) &&
          ['pnpm', 'yarn'].includes(basename(parent)) &&
          dirname(parent) === join(cache, 'downloads')
        );
      })
      .map(([entry, measurement]) => ({ entry, used: measurement.newest, bytes: measurement.bytes }));
    const storePaths = new Set(stores.map(store => store.entry));
    const maxAge = stores.length ? readClientSettings().clientCacheMaxAgeHours * 3_600_000 : 0;
    const now = Date.now();
    const installRunning = Boolean(result.kept.length);
    let budgetUse = disk?.bytes ?? installedBytes;
    for (const item of [...entries, ...stores].sort(
      (a, b) => a.used - b.used || a.entry.localeCompare(b.entry),
    )) {
      if (budgetUse <= budgetBytes) break;
      const store = storePaths.has(item.entry);
      if (item.bytes === undefined || result.kept.some(kept => kept.entry === item.entry)) continue;
      const directory = store ? `${item.entry}.lock` : lockDirectory(item.entry);
      if (stat(directory) && !privateDownloadDirectory(directory)) continue;
      if (
        store &&
        ![join(cache, 'downloads'), dirname(item.entry), item.entry].every(privateDownloadDirectory)
      )
        continue;
      const lock = tryHeavySlot(directory, 1);
      if (!lock) {
        result.kept.push({ entry: item.entry, reason: 'Install or link is running.' });
        continue;
      }
      try {
        const found = stat(item.entry);
        if (!found?.isDirectory()) continue;
        if (store) {
          const linked = () =>
            entries.some(entry => {
              const current = usage(entry.entry);
              if (current.download)
                return current.download === item.entry && referenced(entry.entry, current.roots);
              // Older installs recorded checkout links without recording their download scope.
              const manager = /^(pnpm|yarn)(?:-skipped)?-[0-9a-f]{24}$/.exec(basename(entry.entry))?.[1];
              return (
                (manager === 'pnpm' || manager === 'yarn') &&
                referenced(
                  entry.entry,
                  current.roots,
                  root => downloadCachePath(cache, manager, dependencyProject(root)) === item.entry,
                )
              );
            });
          if (
            !maxAge ||
            installRunning ||
            now - Math.max(found.mtimeMs, item.used) <= maxAge ||
            retained(directory, result.apply) ||
            linked()
          ) {
            result.kept.push({ entry: item.entry, reason: 'Recent, linked or in-use package downloads.' });
            continue;
          }
        } else {
          // Re-read under the lock: a concurrent cache hit may have added a new root or refreshed LRU.
          const current = usage(item.entry);
          if (current.used !== item.used || retained(directory, result.apply)) {
            result.kept.push({
              entry: item.entry,
              reason: 'Retained for a running relink or used during this sweep.',
            });
            continue;
          }
          if (referenced(item.entry, current.roots)) {
            retainedLinks?.add(item.entry);
            result.kept.push({
              entry: item.entry,
              reason: 'Linked from an existing checkout or checkout links could not be verified.',
            });
            continue;
          }
          installedBytes -= item.bytes;
        }
        if (result.apply) removeInstall(item.entry);
        const size = disk?.reclaim(item.entry) ?? item.bytes;
        (result.apply ? result.removed : result.wouldRemove).push({ entry: item.entry, bytes: size });
        budgetUse -= size;
      } finally {
        rmSync(lock, { recursive: true, force: true });
        // The lock directory persists: removing it could race a new slot claim.
      }
    }
    if (retainedLinks) {
      const blockers = idleLaneLinks(cache, retainedLinks);
      for (const kept of result.kept) {
        const ids = blockers.get(kept.entry);
        if (ids?.size) kept.idleLaneIds = [...ids].sort();
      }
    }
  } finally {
    rmSync(sweep, { recursive: true, force: true });
  }
  if (!options.remeasure) return { ...result, bytes: installedBytes };
  // The separate disk report is observational. A slow or unreadable cache must not
  // hold the sweep lock or hide the removal receipt for changes already applied.
  try {
    if (disk && result.removed.length) disk = dependencyCacheDiskUsage(cache, sweep);
  } catch {
    disk = undefined;
  }
  for (const kept of result.kept)
    if (ENTRY.test(basename(kept.entry))) kept.bytes = disk?.entries.get(kept.entry)?.bytes ?? null;
  return disk
    ? { ...result, installedBytes, bytes: disk.bytes, downloadBytes: disk.downloadBytes }
    : { ...result, installedBytes, status: 'unavailable', bytes: null, downloadBytes: null };
}
/** Automatic sweeps are advisory; an unavailable cache never prevents a Lane from opening. */
export function sweepDependencyCache(cache: string, root: string) {
  try {
    const result = pruneDependencyCache({ cache, roots: [root] });
    if (result.removed.length)
      process.stderr.write(
        `Pruned ${result.removed.length} unused dependency install(s), ${(result.removed.reduce((sum, item) => sum + item.bytes, 0) / 1024 ** 3).toFixed(2)} GiB; reopening a Lane reinstalls them if needed.\n`,
      );
  } catch {
    /* Cache maintenance is best effort; explicit prune reports failures. */
  }
}
