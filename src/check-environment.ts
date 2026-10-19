// SPDX-License-Identifier: Apache-2.0
import { mkdirSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { join } from 'node:path';
import { digest } from './hash.js';
import type { Check, CheckEnvironment } from './work-types.js';

// Deliberately no prefix passthrough except locale. New runtime settings belong here,
// not in an expanding credential denylist. Node/npm set their own child-process vars.
const runtimeNames = new Set([
  'PATH',
  'LANG',
  'TZ',
  'TERM',
  'SystemRoot',
  'WINDIR',
  'PATHEXT',
  'FORGE_GIT_TIMEOUT_MS',
  'FORGE_CHECK_FULL',
  'FORGE_CHECK_SCOPED',
  'FORGE_MAX_CONCURRENT_CHECKS',
  'FORGE_CHECK_QUEUE_DIR',
  'FORGE_DISK_WARN_GB',
  'FORGE_DISK_BLOCK_GB',
]);
export const checkPassthrough = (check: Pick<Check, 'env' | 'credentials'>) =>
  [...new Set([...(check.env ?? []), ...(check.credentials ?? [])])].sort();

export function checkEnvironment(): CheckEnvironment {
  const env = Object.fromEntries(
    Object.entries(process.env)
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && (runtimeNames.has(entry[0]) || /^LC_[A-Z_]+$/.test(entry[0])),
      ),
  );
  env.CI = 'true';
  // A dedicated content cache, never the user's npm config/cache directory.
  env.npm_config_cache = join(homedir(), '.cache', 'nanthai-forge', 'check-npm-cache');
  const observed = {
    mode: 'clean' as const,
    platform: process.platform,
    arch: process.arch,
    os: release(),
    node: process.version,
    env,
  };
  return { ...observed, fingerprint: digest(JSON.stringify(observed)) };
}

/** Transient values only: never persist arbitrary passthrough values in Work/receipts. */
export function checkProcessEnvironment(check: Check, environment: CheckEnvironment, runDirectory: string) {
  const runtime = join(runDirectory, 'runtime');
  const env = { ...environment.env };
  const dirs = {
    HOME: 'home',
    USERPROFILE: 'home',
    XDG_CONFIG_HOME: 'config',
    XDG_CACHE_HOME: 'cache',
    XDG_DATA_HOME: 'data',
    XDG_STATE_HOME: 'state',
    TMPDIR: 'tmp',
    TMP: 'tmp',
    TEMP: 'tmp',
  };
  for (const [name, leaf] of Object.entries(dirs)) env[name] = join(runtime, leaf);
  // Prevent machine-level npmrc credentials from entering a clean check too.
  env.npm_config_userconfig = join(runtime, 'npmrc');
  env.npm_config_globalconfig = join(runtime, 'global-npmrc');
  for (const name of checkPassthrough(check)) {
    // Runtime settings already belong to the recorded run, including when an
    // adopter explicitly lists PATH or a FORGE setting as passthrough.
    if (!(name in environment.env) && process.env[name] !== undefined) env[name] = process.env[name]!;
  }
  const omitted = Object.keys(process.env)
    .filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !(name in env))
    .sort();
  return {
    env,
    omitted,
    prepare() {
      for (const leaf of new Set(Object.values(dirs)))
        mkdirSync(join(runtime, leaf), { recursive: true, mode: 0o700 });
      mkdirSync(environment.env.npm_config_cache!, { recursive: true, mode: 0o700 });
    },
  };
}

export function checkEnvironmentDescription(check: Pick<Check, 'env' | 'credentials'>) {
  const names = checkPassthrough(check);
  return `Clean environment${names.length ? `; declared passthrough: ${names.join(', ')}` : '; no declared passthrough'}.`;
}

/** Names only: diagnostics must not expose runtime values. */
export function changedEnvironmentFields(before: CheckEnvironment, after: CheckEnvironment): string[] {
  return [
    ...(['mode', 'platform', 'arch', 'os', 'node'] as const).filter(key => before[key] !== after[key]),
    ...[...new Set([...Object.keys(before.env), ...Object.keys(after.env)])]
      .sort()
      .filter(key => before.env[key] !== after.env[key]),
  ];
}
