// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { canonicalRoot } from './root-paths.js';
import { laneCommandRunning, listLanes, readLaneEntry, type LaneRegistryEntry } from './lane-registry.js';
import { readClientSettings } from './client-settings.js';
import { readLink } from './dependency-relink.js';
import { processAlive } from './local-process.js';
import { processBlocker, workingProcesses } from './clean-processes.js';
import { CLI_RETIRE_GRACE_MS, liveCliBuildUser } from './cli-installation.js';

const stat = (path: string) => lstatSync(path, { throwIfNoEntry: false });
const cliBuild = /^(?:\.install-|[0-9a-f]{12,64}$)/;
function runtimeDirectory(root: string) {
  const builds = dirname(root),
    installation = dirname(builds);
  return basename(builds) === 'builds' &&
    cliBuild.test(basename(root)) &&
    (stat(join(root, '.managed-cli')) ||
      ['current', 'previous', 'manager'].some(pointer =>
        stat(join(installation, pointer))?.isSymbolicLink(),
      ) ||
      stat(join(installation, 'update-lock', '1'))?.isDirectory())
    ? builds
    : null;
}

// Keep a missing stage path as an anchor for the installation's pointers after the stage is renamed.
export const dependencyRootExists = (root: string) =>
  stat(root) ||
  (basename(root).startsWith('.install-') &&
    basename(dirname(root)) === 'builds' &&
    stat(dirname(root))?.isDirectory());

function updateRunning(installation: string, now: number) {
  const slot = join(installation, 'update-lock', '1'),
    holder = stat(slot);
  if (!holder?.isDirectory()) return false;
  try {
    const pid = Number(readFileSync(join(slot, 'pid'), 'utf8'));
    let startTime: string | undefined;
    try {
      startTime = readFileSync(join(slot, 'start'), 'utf8');
    } catch {}
    return processAlive({ pid, startTime });
  } catch {
    return now - holder.mtimeMs < 60_000 && Boolean(stat(slot));
  }
}

function runtimeInUse(root: string, now: number) {
  const retired = stat(join(root, '.retired'));
  if (retired && now - retired.mtimeMs < CLI_RETIRE_GRACE_MS) return true;
  const users = join(root, '.users');
  if (!stat(users)?.isDirectory()) return false;
  return readdirSync(users).some(name => {
    try {
      return Boolean(liveCliBuildUser(join(users, name)));
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
  });
}

function runtimeRoots(builds: string, now: number) {
  const installation = dirname(builds);
  const updating = updateRunning(installation, now);
  const roots = ['current', 'previous', 'manager'].flatMap(pointer => {
    try {
      const root = realpathSync(join(installation, pointer));
      return dirname(root) === builds ? [root] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return [];
    }
  });
  // An updater can rename its stage before selecting it. Existing runtime leases and the
  // retirement grace also protect processes already running on a replaced build.
  for (const name of readdirSync(builds)) {
    const root = join(builds, name);
    if (
      cliBuild.test(name) &&
      !roots.includes(root) &&
      stat(root)?.isDirectory() &&
      (updating || runtimeInUse(root, now))
    )
      roots.push(root);
  }
  return roots;
}

/** Resolve registry and CLI roots once per sweep. References are still checked under the entry lock. */
export function dependencyRoots(extra: string[], runtime: string, now = Date.now()) {
  const maxAge = readClientSettings().clientCacheMaxAgeHours * 3_600_000;
  const known = new Set([...extra, runtime]);
  const lanes = new Map<string, LaneRegistryEntry>();
  const canonical = new Map<string, string>();
  const linked = new Map<string, string[]>();
  const markerTimes = new Map<string, number>();
  let processes: ReturnType<typeof workingProcesses> | undefined;
  for (const lane of listLanes()) {
    const root = canonicalRoot(lane.root);
    canonical.set(lane.root, root);
    known.add(root);
    lanes.set(root, lane);
    for (let parent = dirname(root); parent !== dirname(parent); parent = dirname(parent))
      if (basename(parent).endsWith('.forge-client')) known.add(parent.slice(0, -'.forge-client'.length));
  }
  const live = (root: string) => {
    if (!maxAge) return true;
    const snapshot = lanes.get(root);
    if (snapshot && now - snapshot.lastActionAt <= maxAge) return true;
    const lane = snapshot ? (readLaneEntry(snapshot.laneId) ?? snapshot) : null;
    if (lane) {
      if (
        lane.pinned ||
        lane.landing ||
        lane.hold ||
        laneCommandRunning(lane) ||
        now - lane.lastActionAt <= maxAge
      )
        return true;
    } else {
      const time = markerTimes.get(root) ?? stat(join(root, '.forge', 'hosted-lane.json'))?.mtimeMs ?? now;
      markerTimes.set(root, time);
      if (now - time <= maxAge) return true;
    }
    return Boolean(processBlocker(root, (processes ??= workingProcesses())));
  };
  return (entry: string, roots: string[], accepts?: (root: string) => boolean) => {
    try {
      const checked = new Set<string>();
      const checkedBuilds = new Set<string>();
      for (const path of new Set([...known, ...roots])) {
        const physical = canonical.get(path) ?? canonicalRoot(path);
        canonical.set(path, physical);
        const directory = lanes.has(physical) ? null : runtimeDirectory(physical);
        const builds = directory && !stat(join(physical, '.forge', 'hosted-lane.json')) ? directory : null;
        if (builds) {
          if (checkedBuilds.has(builds)) continue;
          checkedBuilds.add(builds);
        }
        for (const root of builds ? runtimeRoots(builds, now) : [physical]) {
          if (checked.has(root)) continue;
          checked.add(root);
          const targets = linked.get(root) ?? dependencyTargets(root);
          linked.set(root, targets);
          if (
            targets.some(target => target === entry || target.startsWith(entry + sep)) &&
            (builds || live(root)) &&
            (!accepts || accepts(root))
          )
            return true;
        }
      }
      return false;
    } catch {
      // Unknown filesystem coverage cannot authorize eviction.
      return true;
    }
  };
}

function dependencyTargets(root: string): string[] {
  try {
    const modules = join(root, 'node_modules'),
      found = stat(modules);
    if (!found) return [];
    const link = readLink(root);
    if (link) return [canonicalRoot(link.entry)];
    // Pre-marker installs and custom workspace overlays may link packages directly.
    const targetOf = (path: string) => canonicalRoot(resolve(dirname(path), readlinkSync(path)));
    if (found.isSymbolicLink()) return [targetOf(modules)];
    if (!found.isDirectory()) return [];
    const targets = [];
    for (const name of readdirSync(modules)) {
      const path = join(modules, name),
        child = stat(path);
      if (child?.isSymbolicLink()) targets.push(targetOf(path));
      if (child?.isDirectory() && (name.startsWith('@') || name === '.bin'))
        for (const nested of readdirSync(path).map(name => join(path, name)))
          if (stat(nested)?.isSymbolicLink()) targets.push(targetOf(nested));
    }
    return targets;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
