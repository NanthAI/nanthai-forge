// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEnvironment, checkProcessEnvironment } from './check-environment.js';
import type { Check } from './work-types.js';

/** No declared passthrough: these commands are chosen by the repository, not by a check definition. */
const NO_PASSTHROUGH = { env: [], credentials: [] } as Pick<Check, 'env' | 'credentials'> as Check;

/**
 * The clean check environment for a repository-chosen command Forge runs on the agent's machine
 * outside a check: start-time dependency installs and local preflight. Private HOME, XDG and temp
 * directories and npm configuration, the allowlisted variables only, the shared check caches, and
 * corepack's own home when it exists at its default location (the pnpm and Yarn versions it already
 * fetched; a path, never a credential), so a run does not fetch them again. Build it once per install
 * or preflight run; `dispose` removes the private directories.
 */
export function cleanCommandEnvironment(label: string) {
  const directory = mkdtempSync(join(tmpdir(), `forge-${label}-`));
  try {
    const built = checkProcessEnvironment(NO_PASSTHROUGH, checkEnvironment(), directory);
    built.prepare();
    const env: NodeJS.ProcessEnv = { ...built.env };
    const corepack = join(homedir(), '.cache', 'node', 'corepack');
    if (existsSync(corepack)) env.COREPACK_HOME = corepack;
    return { env, dispose: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
