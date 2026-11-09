// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectPackageManager, type ManagerName } from './package-manager.js';
import { shellQuote } from './shell-quote.js';

const INSTALL: Record<ManagerName, (berry: boolean) => string> = {
  npm: () => 'npm ci --ignore-scripts',
  pnpm: () => 'pnpm install --frozen-lockfile --ignore-scripts',
  yarn: berry =>
    berry ? 'yarn install --immutable --mode=skip-build' : 'yarn install --frozen-lockfile --ignore-scripts',
  bun: () => 'bun install --frozen-lockfile --ignore-scripts',
};
const read = (path: string) => {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
};
type LockPackages = Record<
  string,
  { version?: string; link?: boolean; optional?: boolean; os?: unknown; cpu?: unknown }
>;
const packages = (bytes: Buffer | null): LockPackages | null => {
  try {
    return bytes
      ? ((JSON.parse(bytes.toString('utf8')) as { packages?: LockPackages }).packages ?? null)
      : null;
  } catch {
    return null;
  }
};

/** The lockfile Forge's manager detection names for ROOT, with a digest of its bytes (null: none). */
export function lockfileState(root: string) {
  const detected = detectPackageManager(root);
  if (!detected || 'reason' in detected) return null;
  const bytes = read(join(root, detected.manager.lockfile));
  return bytes
    ? { manager: detected.manager, digest: createHash('sha256').update(bytes).digest('hex') }
    : null;
}

/** npm: every package the lockfile requires is installed at its locked version in the install's own
 * hidden lockfile. Platform-only optional packages are skipped. Unreadable files count as stale. */
function npmInstallCurrent(root: string, lockfile: string) {
  const locked = packages(read(join(root, lockfile)));
  // npm keeps its own copy of the lockfile, hidden, inside the install.
  const installed = packages(read(join(root, 'node_modules', `.${lockfile}`)));
  if (!locked || !installed) return false;
  return Object.entries(locked).every(([path, entry]) => {
    if (path === '' || entry.link) return true;
    const have = installed[path];
    return have ? have.version === entry.version : !!entry.optional || !!entry.os || !!entry.cpu;
  });
}

/** One line after `nforge pull`: the lockfile changed in this pull and the folder's own node_modules
 * does not match it. Pull never installs; the line names the command. null: nothing to say (no lockfile
 * change, no node_modules, a Forge link that the agent actions already follow, or an install that is
 * already current). Local reads only: no Convex call. */
export function staleDependenciesNotice(root: string, before: string | null) {
  const now = lockfileState(root);
  if (!now || now.digest === before) return null;
  try {
    if (!lstatSync(join(root, 'node_modules')).isDirectory()) return null;
  } catch {
    return null;
  }
  if (now.manager.name === 'npm' && npmInstallCurrent(root, now.manager.lockfile)) return null;
  return `${now.manager.lockfile} changed and node_modules is out of date; run: cd ${shellQuote(root)} && ${INSTALL[now.manager.name](now.manager.berry)}  (pull does not install)\n`;
}
