// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { invariant } from './errors.js';
import { checkEnvCaches, checkEnvHomes, checkEnvToolchains } from './ecosystems.js';
import { digest } from './hash.js';

/**
 * Transient, per-run settings that keep non-npm ecosystems working and warm inside the
 * clean check environment. They are applied after the recorded environment is copied, so
 * the environment fingerprint is unchanged. Everything here is a path, never a credential.
 */

/** Pure content caches (src/ecosystems.ts): every tool re-verifies or only reads packages from them, and none reads
 * executable configuration from the directory. Segmented per project below the shared root. */
const contentCaches = checkEnvCaches();
const mavenRepository = 'check-maven-repository';
/** Tool homes also read executable configuration (Gradle `init.d` and `gradle.properties`, Cargo
 * `config.toml`). The variable points at a fresh directory inside the run, so nothing a check writes
 * there outlives it; only the named content subdirectories are linked in from a per-project store. */
const toolHomes = checkEnvHomes();

/** Toolchain homes hold installed compilers and interpreters, never credentials: each ecosystem's
 * (src/ecosystems.ts), then the version managers that serve every ecosystem. */
const toolchainHomes: ReadonlyArray<readonly [name: string, relative: readonly string[]]> = [
  ...checkEnvToolchains(),
  ['MISE_DATA_DIR', ['.local', 'share', 'mise']],
  ['ASDF_DATA_DIR', ['.asdf']],
];

/** Content caches live beside the npm cache, so one root identifies every check cache. */
export function checkCacheRoot(npmCache: string | undefined) {
  return npmCache ? dirname(npmCache) : join(homedir(), '.cache', 'nanthai-forge');
}

/** One directory name per project, so no check ever sees another project's caches. */
export const checkCacheScope = (scope: string) => digest(scope).slice(0, 16);

export function ecosystemCheckEnvironment(
  npmCache: string | undefined,
  home = homedir(),
  scope = 'local',
  runtime = '',
) {
  const root = checkCacheRoot(npmCache);
  const project = checkCacheScope(scope);
  const env: Record<string, string> = {};
  const directories: string[] = [];
  const links: Array<{ target: string; link: string }> = [];
  for (const [name, leaf] of contentCaches) {
    env[name] = join(root, leaf, project);
    directories.push(env[name]);
  }
  for (const tool of toolHomes) {
    // Without a run directory (no caller does this) the home would be the shared store itself.
    invariant(runtime, 'UNSAFE_PATH', 'A tool home needs a run directory.');
    env[tool.name] = join(runtime, tool.run);
    directories.push(env[tool.name]!);
    for (const name of tool.content) {
      const target = join(root, tool.leaf, project, name);
      directories.push(target);
      links.push({ target, link: join(env[tool.name]!, name) });
    }
  }
  const repository = join(root, mavenRepository, project);
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
  return { env, directories, links };
}

/** Make the run's tool homes: empty, with the project's content directories linked in. */
export function prepareEcosystemHomes(ecosystem: ReturnType<typeof ecosystemCheckEnvironment>) {
  for (const directory of ecosystem.directories) mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const { target, link } of ecosystem.links) {
    rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link, 'dir');
  }
}
