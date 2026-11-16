// SPDX-License-Identifier: Apache-2.0
import { homedir } from 'node:os';
import { canonicalRoot } from './root-paths.js';
import { randomUUID } from 'node:crypto';
import { processAlive } from './local-process.js';
import { startIdentity } from './heavy-queue.js';
import { fileURLToPath } from 'node:url';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tryHeavySlot } from './heavy-slots.js';
import { listLanes } from './lane-registry.js';
import { readLink } from './dependency-relink.js';
import { removeInstall } from './dependency-seal.js';

const ENTRY = /^((?:npm|pnpm|yarn|bun)(?:-scripts|-rebuild|-skipped)?-[0-9a-f]{24})(?:\.tmp-[a-zA-Z0-9]+)?$/;
const lockDirectory = (entry: string) => join(dirname(entry), `${ENTRY.exec(basename(entry))![1]}.lock`);
/** Made while holding the entry lock, then held without that exclusive lock during a relink.
 * A shared rollback lease avoids an A→B / B→A install-lock cycle across two Lanes. */
export function retainDependencyEntry(entry: string): () => void {
  const path = join(lockDirectory(entry), `keep-${process.pid}-${randomUUID()}`);
  writeFileSync(path, JSON.stringify({ pid: process.pid, startTime: startIdentity(process.pid) }));
  return () => rmSync(path, { force: true });
}
function retained(entry: string): boolean {
  const directory = lockDirectory(entry);
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
    else rmSync(path, { force: true });
  }
  return live;
}
const USAGE = '.forge-usage.json';
const DEFAULT_BYTES = 4 * 1024 ** 3;
type Usage = { bytes?: number; tools?: number; folders?: string[]; used: number; roots: string[] };
const stat = (path: string) => lstatSync(path, { throwIfNoEntry: false });
const writeUsage = (entry: string, value: Usage) => {
  const next = join(entry, '.forge-usage.next');
  writeFileSync(next, JSON.stringify(value));
  renameSync(next, join(entry, USAGE));
};
const runtimeRoots = (root: string) => {
  const parent = dirname(root);
  return basename(parent) === 'builds' && stat(parent)?.isDirectory()
    ? readdirSync(parent).map(name => join(parent, name))
    : [];
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
export function touchDependencyEntry(entry: string, root: string, folders?: string[]) {
  const previous = usage(entry);
  const roots = previous.roots.filter(path => stat(path) || runtimeRoots(path).length);
  writeUsage(entry, {
    ...previous,
    ...(folders ? { folders } : {}),
    used: Date.now(),
    roots: [...new Set([...roots, canonicalRoot(root)])],
  });
}
/** Registered roots cover pre-upgrade installs; enclosing project roots cover main's old links. */
function knownRoots(extra: string[]): string[] {
  const roots = new Set(extra.map(root => resolve(root)));
  for (const lane of listLanes()) {
    roots.add(lane.root);
    for (let parent = dirname(lane.root); parent !== dirname(parent); parent = dirname(parent))
      if (basename(parent).endsWith('.forge-client')) roots.add(parent.slice(0, -'.forge-client'.length));
  }
  const runtime = dirname(dirname(fileURLToPath(import.meta.url)));
  roots.add(runtime);
  for (const root of runtimeRoots(runtime)) roots.add(root);
  return [...roots];
}
function referenced(entry: string, roots: string[]): boolean {
  return roots
    .flatMap(root => [root, ...runtimeRoots(root)])
    .some(root => {
      try {
        const modules = join(root, 'node_modules'),
          found = stat(modules);
        if (!found) return false;
        const link = readLink(root);
        if (link) return canonicalRoot(link.entry) === entry;
        // Legacy/custom symlinks need no marker. An unreadable marker or directory keeps its bytes.
        const pointsInto = (path: string) => {
          const target = canonicalRoot(resolve(dirname(path), readlinkSync(path)));
          return target === entry || target.startsWith(entry + sep);
        };
        if (found.isSymbolicLink()) return pointsInto(modules);
        if (found.isDirectory()) {
          for (const name of readdirSync(modules)) {
            const path = join(modules, name),
              child = stat(path);
            if (child?.isSymbolicLink() && pointsInto(path)) return true;
            if (child?.isDirectory() && (name.startsWith('@') || name === '.bin'))
              for (const name of readdirSync(path)) {
                const nested = join(path, name);
                if (stat(nested)?.isSymbolicLink() && pointsInto(nested)) return true;
              }
          }
        }
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        // Unknown filesystem coverage cannot authorize eviction.
        return true;
      }
    });
}
export type DependencyCachePrune = {
  budgetBytes: number;
  bytes: number;
  removed: { entry: string; bytes: number }[];
  wouldRemove: { entry: string; bytes: number }[];
  kept: { entry: string; reason: string }[];
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
    bytes: 0,
    removed: [],
    wouldRemove: [],
    kept: [],
    apply: options.apply ?? true,
  };
  if (!stat(cache)) return result;
  cache = canonicalRoot(cache);
  const sweep = tryHeavySlot(join(cache, '.gc.lock'), 1);
  if (!sweep) return result;
  try {
    const roots = knownRoots(options.roots ?? []);
    const entries = readdirSync(cache)
      .filter(name => ENTRY.test(name) && stat(join(cache, name))?.isDirectory())
      .map(name => ({ entry: join(cache, name), ...usage(join(cache, name)) }))
      .sort((a, b) => a.used - b.used || a.entry.localeCompare(b.entry));
    // Running installers own the base lock, including temporary stages; abandoned stages can go.
    for (const item of entries) {
      if (
        !options.remeasure &&
        Number.isFinite(item.bytes) &&
        item.bytes! >= 0 &&
        Number.isFinite(item.tools)
      ) {
        item.bytes = item.bytes! - (item.tools ?? 0) + toolBytes(item.entry, item.folders);
        result.bytes += item.bytes;
        continue;
      }
      const lock = tryHeavySlot(lockDirectory(item.entry), 1);
      if (!lock) {
        result.bytes += item.bytes ?? 0;
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
        result.bytes += item.bytes!;
        if (result.apply)
          writeUsage(item.entry, {
            bytes: item.bytes!,
            tools: item.tools,
            folders: item.folders ?? [],
            used: item.used,
            roots: item.roots,
          });
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    }
    for (const item of entries) {
      if (result.bytes <= budgetBytes) break;
      if (item.bytes === undefined || result.kept.some(kept => kept.entry === item.entry)) continue;
      const lock = tryHeavySlot(lockDirectory(item.entry), 1);
      if (!lock) {
        result.kept.push({ entry: item.entry, reason: 'Install or link is running.' });
        continue;
      }
      try {
        if (!stat(item.entry)) continue;
        // Re-read under the lock: a concurrent cache hit may have added a new root or refreshed LRU.
        const current = usage(item.entry);
        if (
          current.used !== item.used ||
          retained(item.entry) ||
          referenced(item.entry, [...roots, ...current.roots])
        ) {
          result.kept.push({
            entry: item.entry,
            reason:
              'Linked from an existing checkout, retained for a running relink, or used during this sweep.',
          });
          continue;
        }
        if (result.apply) removeInstall(item.entry);
        (result.apply ? result.removed : result.wouldRemove).push({ entry: item.entry, bytes: item.bytes });
        result.bytes -= item.bytes;
      } finally {
        rmSync(lock, { recursive: true, force: true });
        // The lock directory persists: removing it could race a new slot claim.
      }
    }
  } finally {
    rmSync(sweep, { recursive: true, force: true });
  }
  return result;
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
