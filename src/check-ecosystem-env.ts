// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Transient, per-run settings that keep non-npm ecosystems working and warm inside the
 * clean check environment. They are applied after the recorded environment is copied, so
 * the environment fingerprint is unchanged. Everything here is a path, never a credential.
 */

/** Dedicated content caches: shared across checks, credential-free, outside the private HOME. */
const contentCaches: Array<[name: string, leaf: string]> = [
  ['GOMODCACHE', 'check-go-mod-cache'],
  ['GOCACHE', 'check-go-build-cache'],
  // Registry and crate cache only. Toolchains stay in RUSTUP_HOME; no ~/.cargo credentials.
  ['CARGO_HOME', 'check-cargo-home'],
  ['GRADLE_USER_HOME', 'check-gradle-home'],
  ['PIP_CACHE_DIR', 'check-pip-cache'],
  ['UV_CACHE_DIR', 'check-uv-cache'],
  ['NUGET_PACKAGES', 'check-nuget-packages'],
];
const mavenRepository = 'check-maven-repository';

/** Toolchain homes hold installed compilers and interpreters, never credentials. */
const toolchainHomes: Array<[name: string, relative: string[]]> = [
  ['RUSTUP_HOME', ['.rustup']],
  ['PYENV_ROOT', ['.pyenv']],
  ['MISE_DATA_DIR', ['.local', 'share', 'mise']],
  ['ASDF_DATA_DIR', ['.asdf']],
];

/** Content caches live beside the npm cache, so one root identifies every check cache. */
export function checkCacheRoot(npmCache: string | undefined) {
  return npmCache ? dirname(npmCache) : join(homedir(), '.cache', 'nanthai-forge');
}

export function ecosystemCheckEnvironment(npmCache: string | undefined, home = homedir()) {
  const root = checkCacheRoot(npmCache);
  const env: Record<string, string> = {};
  const directories: string[] = [];
  for (const [name, leaf] of contentCaches) {
    env[name] = join(root, leaf);
    directories.push(env[name]);
  }
  const repository = join(root, mavenRepository);
  // MAVEN_ARGS is split on whitespace, so a root containing a space cannot carry the path.
  if (!/\s/.test(repository)) {
    env.MAVEN_ARGS = `-Dmaven.repo.local=${repository}`;
    directories.push(repository);
  }
  // Only a toolchain that is really installed at its default location is passed; nothing
  // is created, and a machine without it is unchanged.
  for (const [name, relative] of toolchainHomes) {
    const location = join(home, ...relative);
    if (existsSync(location)) env[name] = location;
  }
  return { env, directories };
}
