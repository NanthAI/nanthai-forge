// SPDX-License-Identifier: Apache-2.0
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliRuntimePaths, type CliRuntimeUser } from './cli-runtime-processes.js';
import { randomUUID } from 'node:crypto';
import { durableReplace, syncDirectory } from './native-durability.js';
import { processAlive, processStartTime } from './local-process.js';
import { claimCliRuntime, withCliRuntimeLock } from './cli-launcher.js';
import { canonicalRoot } from './root-paths.js';
import { ForgeError } from './errors.js';

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
export function stableCliRunner(runner: string) {
  const installation = cliInstallation(dirname(dirname(runner)));
  return installation && existsSync(join(installation, 'current'))
    ? join(installation, 'current', 'dist', basename(runner))
    : runner;
}
/** Same lock fences new runtime users, selection, and retirement. No timers or server calls. */
export function withCliLock<T>(installation: string, run: () => T): T {
  try {
    return withCliRuntimeLock(installation, run);
  } catch (error) {
    if (error instanceof Error && 'code' in error && !(error instanceof ForgeError))
      throw new ForgeError(String(error.code), error.message);
    throw error;
  }
}
export function selectCliBuild(installation: string, build: string, pointer = 'current') {
  const next = join(installation, `${pointer}-${randomUUID()}`);
  try {
    symlinkSync(build, next, 'dir');
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
/** Inspect legacy users before retirement; managed users additionally carry durable leases. */
export function pruneCliBuilds(
  installation: string,
  inspectUsers: () => (CliRuntimeUser | string)[] = cliRuntimePaths,
) {
  installation = canonicalRoot(installation);
  const current = realpathSync(join(installation, 'current'));
  const manager = existsSync(join(installation, 'manager'))
    ? realpathSync(join(installation, 'manager'))
    : null;
  const permission = join(installation, 'hooks-ready');
  if (!existsSync(permission) || readFileSync(permission, 'utf8') !== cliBuildCommit(current)) return [];
  const builds = readdirSync(join(installation, 'builds'))
    .filter(name => /^[a-f0-9]{12,64}$/.test(name))
    .map(name => ({ name, path: join(installation, 'builds', name), live: false }));
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
  const removed: string[] = [];
  for (const build of builds) {
    if (canonicalRoot(build.path) === current || canonicalRoot(build.path) === manager || build.live)
      continue;
    if (!legacyUsers || ambiguous) continue;
    if (
      legacyUsers.some(user =>
        canonicalRoot(typeof user === 'string' ? user : user.path).startsWith(build.path + '/'),
      )
    )
      continue;
    if (
      !existsSync(join(build.path, '.managed-cli')) &&
      (!existsSync(join(build.path, '.commit')) || !existsSync(join(build.path, 'dist', 'cli-entry.js')))
    )
      continue;
    rmSync(build.path, { recursive: true });
    removed.push(build.name);
  }
  return removed;
}
export function retainCliRuntime(root = cliPackageRoot()) {
  root = canonicalRoot(root);
  const installation = cliInstallation(root);
  if (!installation) return;
  try {
    claimCliRuntime(installation, root);
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw new ForgeError(String(error.code), error.message);
    throw error;
  }
  // Keep the lease until the process is fully gone, including all exit handlers.
}
