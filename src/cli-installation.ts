// SPDX-License-Identifier: Apache-2.0
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliRuntimePaths, type CliRuntimeUser } from './cli-runtime-processes.js';
import { randomUUID } from 'node:crypto';
import { durableReplace, syncDirectory } from './native-durability.js';
import { processAlive, processStartTime } from './local-process.js';
import {
  CLI_RUNTIME_WAIT_MS,
  claimCliRuntime,
  resolveCliPointer,
  withCliRuntimeLock,
} from './cli-launcher.js';
import { canonicalRoot } from './root-paths.js';
import { ForgeError } from './errors.js';
import { linkDirectory } from './source-links.js';

export const cliPackageRoot = (url = import.meta.url) => dirname(dirname(fileURLToPath(url)));
export function cliInstallation(root = cliPackageRoot()): string | null {
  root = canonicalRoot(root);
  if (basename(dirname(root)) === 'builds' && /^[a-f0-9]{12,64}$/.test(basename(root)))
    return dirname(dirname(root));
  const binding = join(root, '.cli-installation');
  return existsSync(binding) ? canonicalRoot(readFileSync(binding, 'utf8').trim()) : null;
}
export function cliBuildCommit(root = cliPackageRoot()): string {
  const path = join(root, '.commit');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const marker = join(root, '.forge', 'hosted-main.json');
  return existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')).selection.head : 'development';
}
/** The build a pointer selects, or null when the pointer does not exist. Never follows the link
 * for the existence check, so a lookup racing a switch cannot read as "no selection". */
export function cliSelectedBuild(
  installation: string,
  pointer: 'current' | 'manager' | 'previous' = 'current',
) {
  try {
    lstatSync(join(installation, pointer));
  } catch {
    return null;
  }
  try {
    return resolveCliPointer(installation, pointer);
  } catch (error) {
    // A previous pointer whose build is gone is just "no previous build".
    if (pointer === 'previous' && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export function stableCliRunner(runner: string) {
  const installation = cliInstallation(dirname(dirname(runner)));
  return installation && existsSync(join(installation, 'current'))
    ? join(installation, 'current', 'dist', basename(runner))
    : runner;
}
/** Same lock fences new runtime users, selection, and retirement. No timers or server calls. */
export function withCliLock<T>(installation: string, run: () => T, waitMs = CLI_RUNTIME_WAIT_MS): T {
  try {
    return withCliRuntimeLock(installation, run, waitMs);
  } catch (error) {
    if (error instanceof Error && 'code' in error && !(error instanceof ForgeError))
      throw new ForgeError(String(error.code), error.message);
    throw error;
  }
}
export function selectCliBuild(installation: string, build: string, pointer = 'current') {
  const next = join(installation, `${pointer}-${randomUUID()}`);
  try {
    linkDirectory(build, next);
    renameSync(next, join(installation, pointer));
    syncDirectory(installation);
  } finally {
    rmSync(next, { force: true });
  }
}
/** Publish only after all existing hook settings have migrated successfully. */
export function permitCliRetirement(installation: string) {
  durableReplace(join(installation, 'hooks-ready'), cliBuildCommit(join(installation, 'current')));
}
/** A replaced build stays on disk this long after it stops being selected. Leases protect processes
 * that claimed it; the grace also covers a process that resolved the old path just before the
 * switch and has not claimed yet, so it never meets a deleted runtime. Product retention, not a
 * machine setting: at most the builds of the last few minutes of updates stay on disk. */
export const CLI_RETIRE_GRACE_MS = 10 * 60_000;
const RETIRED = '.retired';
/** Selecting a build (again) clears its retirement mark. */
export function unretireCliBuild(build: string) {
  rmSync(join(build, RETIRED), { force: true });
}
/** Inspect legacy users before retirement; managed users additionally carry durable leases.
 * Slow work (process table, lease liveness, recursive deletion) runs outside the runtime lock;
 * the lock is held only to re-check leases and rename chosen builds out of `builds/`, so
 * concurrent CLI starts never queue behind a prune. */
export function pruneCliBuilds(
  installation: string,
  inspectUsers: () => (CliRuntimeUser | string)[] = cliRuntimePaths,
  graceMs = 0,
) {
  installation = canonicalRoot(installation);
  const current = resolveCliPointer(installation, 'current');
  const manager = cliSelectedBuild(installation, 'manager');
  // The one rollback build is the single exception to retirement (canary, ac9c4ed4).
  const previous = cliSelectedBuild(installation, 'previous');
  const permission = join(installation, 'hooks-ready');
  if (!existsSync(permission) || readFileSync(permission, 'utf8') !== cliBuildCommit(current)) return [];
  const directory = join(installation, 'builds');
  // A prune killed mid-deletion leaves only renamed (unselectable) leftovers.
  for (const name of readdirSync(directory))
    if (name.startsWith('.retiring-')) rmSync(join(directory, name), { recursive: true, force: true });
  const builds = readdirSync(directory)
    .filter(name => /^[a-f0-9]{12,64}$/.test(name))
    .map(name => ({ name, path: join(directory, name), live: false }));
  const covered = new Set<number>();
  for (const build of builds) {
    const users = join(build.path, '.users');
    for (const user of existsSync(users) ? readdirSync(users) : []) {
      const file = join(users, user);
      try {
        const identity = JSON.parse(readFileSync(file, 'utf8'));
        if (processAlive(identity)) {
          build.live = true;
          // Only an exact kernel identity can explain a stable-path invocation.
          if (identity.startTime && processStartTime(identity.pid) === identity.startTime)
            covered.add(identity.pid);
        } else rmSync(file);
      } catch {
        build.live = true;
      }
    }
  }
  let legacyUsers: (CliRuntimeUser | string)[] | undefined;
  try {
    legacyUsers = inspectUsers();
  } catch {
    /* Unknown legacy users stay protected. */
  }
  const ambiguous = legacyUsers?.some(user => {
    if (typeof user === 'string' || covered.has(user.pid)) return false;
    const root = dirname(dirname(user.path));
    return basename(root) === 'current' && canonicalRoot(dirname(root)) === installation;
  });
  const now = Date.now();
  const candidates = builds.filter(build => {
    if (
      canonicalRoot(build.path) === current ||
      canonicalRoot(build.path) === manager ||
      canonicalRoot(build.path) === previous ||
      build.live
    )
      return false;
    if (!legacyUsers || ambiguous) return false;
    if (
      legacyUsers.some(user =>
        canonicalRoot(typeof user === 'string' ? user : user.path).startsWith(build.path + sep),
      )
    )
      return false;
    if (
      !existsSync(join(build.path, '.managed-cli')) &&
      (!existsSync(join(build.path, '.commit')) || !existsSync(join(build.path, 'dist', 'cli-entry.js')))
    )
      return false;
    if (graceMs <= 0) return true;
    const mark = join(build.path, RETIRED);
    if (!existsSync(mark)) {
      durableReplace(mark, new Date(now).toISOString());
      return false;
    }
    return now - statSync(mark).mtimeMs >= graceMs;
  });
  if (!candidates.length) return [];
  // Fence: a process that claimed a candidate since the inspection above keeps it.
  const retiring = withCliLock(installation, () => {
    const selected = [
      resolveCliPointer(installation, 'current'),
      cliSelectedBuild(installation, 'manager'),
      cliSelectedBuild(installation, 'previous'),
    ];
    return candidates.flatMap(build => {
      const users = join(build.path, '.users');
      if (selected.includes(canonicalRoot(build.path))) return [];
      if (existsSync(users) && readdirSync(users).length) return [];
      const target = join(directory, `.retiring-${build.name}-${randomUUID()}`);
      renameSync(build.path, target);
      return [{ name: build.name, target }];
    });
  });
  for (const build of retiring) rmSync(build.target, { recursive: true, force: true });
  return retiring.map(build => build.name);
}
/** `waitMs` > 0 lets a user command ride out a concurrent update; hooks keep 0 and fail open. */
export function retainCliRuntime(root = cliPackageRoot(), waitMs = 0) {
  root = canonicalRoot(root);
  const installation = cliInstallation(root);
  if (!installation) return;
  try {
    claimCliRuntime(installation, root, waitMs);
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw new ForgeError(String(error.code), error.message);
    throw error;
  }
  // Keep the lease until the process is fully gone, including all exit handlers.
}
