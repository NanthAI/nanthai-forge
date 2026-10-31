// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { releaseProcesses, belowRuntime } from './release-owner-processes.js';
import type { ReleaseJournal } from './maintainer-release-schema.js';

/** Current release, the one it replaced, and the one before that: a rollback chain of depth 3. */
export const defaultRetainReleases = 3;
/** A release without a selection file is unfinished or failed: leave a day for resume. */
const unselectedGraceMs = 24 * 60 * 60 * 1000;

export type ReleaseRetentionDependencies = {
  /** True when any process has a file open (or its working directory) below the directory. */
  inUse?: (directory: string) => boolean;
  now?: () => number;
};

/** Open files, cwd and executable images all count; a failed probe is treated as in use. */
export function releaseDirectoryInUse(directory: string) {
  const result = spawnSync('lsof', ['-w', '-t', '+D', directory], {
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (!result.error && result.status !== null && !result.signal)
    return result.status === 0 && result.stdout.trim() !== '';
  try {
    return releaseProcesses().some(process => belowRuntime(directory, process.executablePath));
  } catch {
    return true;
  }
}

function releaseOf(releases: string, path: string | undefined) {
  if (!path) return;
  for (const base of new Set([releases, realpathSync(releases)])) {
    const part = relative(base, path);
    const name = part.split(sep)[0];
    if (name && name !== '..' && !isAbsolute(part)) return name;
  }
}
function previousOf(releases: string, id: string) {
  try {
    const plan = JSON.parse(readFileSync(join(releases, id, 'owner-install-selection.json'), 'utf8')) as {
      previous?: unknown;
    };
    return releaseOf(releases, typeof plan.previous === 'string' ? plan.previous : undefined);
  } catch {
    return undefined;
  }
}

/**
 * Remove old runtime releases after a successful install. Kept: this release, the one the owner
 * install link points at, and each one named `previous` in a kept release's selection file, `keep`
 * deep. Never removed: a directory a process still uses, or an unfinished one younger than a day.
 */
export function pruneReleases(
  runtimeDirectory: string,
  current: string,
  keep = defaultRetainReleases,
  dependencies: ReleaseRetentionDependencies = {},
) {
  const releases = join(runtimeDirectory, 'releases');
  const now = (dependencies.now ?? Date.now)();
  const inUse = dependencies.inUse ?? releaseDirectoryInUse;
  const names = existsSync(releases)
    ? readdirSync(releases, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory() ? [entry.name] : [],
      )
    : [];
  const roots: (string | undefined)[] = [current];
  try {
    // The install link is how the owner service resolves its runtime.
    roots.push(releaseOf(releases, realpathSync(join(runtimeDirectory, 'installed-owner'))));
  } catch {
    // No link yet: the release that just finished is the only root.
  }
  const kept = new Set<string>();
  for (const root of roots) {
    let id = root;
    for (let depth = 0; id && depth < keep && names.includes(id); depth++) {
      kept.add(id);
      id = previousOf(releases, id);
    }
  }
  const removed: string[] = [];
  const skipped: { release: string; reason: 'in-use' | 'unfinished' }[] = [];
  for (const name of names.filter(name => !kept.has(name))) {
    const directory = join(releases, name);
    if (
      !existsSync(join(directory, 'owner-install-selection.json')) &&
      now - statSync(directory).mtimeMs < unselectedGraceMs
    )
      skipped.push({ release: name, reason: 'unfinished' });
    else if (inUse(directory)) skipped.push({ release: name, reason: 'in-use' });
    else {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      removed.push(name);
    }
  }
  return { kept: [...kept].sort(), removed: removed.sort(), skipped };
}

/**
 * A completed release never reruns its build: drop what only build, deploy and resume needed.
 * The Netlify CLI fills `.netlify/plugins` with its own node_modules (0.5 GB) during the web deploy.
 */
export function slimReleaseBuild(journal: ReleaseJournal) {
  const build = journal.stages.find(stage => stage.name === 'build')?.attempts.at(-1)?.receipt?.result.path;
  if (!build || !belowRuntime(journal.directory, build) || !existsSync(build)) return [];
  const removed: string[] = [];
  for (const path of ['node_modules', join('.netlify', 'plugins'), '.git']) {
    if (!existsSync(join(build, path))) continue;
    rmSync(join(build, path), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    removed.push(path);
  }
  return removed;
}

/** Best effort and idempotent: a cleanup failure never fails a release that already succeeded. */
export function settleRelease(journal: ReleaseJournal, dependencies: ReleaseRetentionDependencies = {}) {
  try {
    const slimmed = slimReleaseBuild(journal);
    const pruned = pruneReleases(
      journal.request.runtimeDirectory,
      journal.request.operationId,
      journal.request.retainReleases,
      dependencies,
    );
    return { slimmed, ...pruned };
  } catch (error) {
    process.stderr.write(`Release cleanup skipped: ${(error as Error).message}\n`);
    return undefined;
  }
}
