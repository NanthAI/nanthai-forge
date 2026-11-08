// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanCommandEnvironment } from './clean-command-env.js';
import { readInstallScriptAllowlist } from './install-script-allowlist.js';
import type { DependencyInstaller } from './shared-dependencies.js';

/** Why an install can fail here that works in the agent's shell, named once on every failure. */
export const CLEAN_INSTALL_HINT =
  "in Forge's clean install environment (no personal npm config, credentials or environment variables); if it needs them, run the install in the Lane yourself";
const npm = (directory: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn('npm', args, {
      cwd: directory,
      env,
      // npm output goes to stderr; stdout stays the command's JSON receipt.
      stdio: ['ignore', 2, 2],
    });
    child.once('error', reject);
    child.once('exit', code =>
      code === 0 ? resolve() : reject(new Error(`npm ${args[0]} exited ${code} ${CLEAN_INSTALL_HINT}.`)),
    );
  });
/** Install scripts never run by default (the Actions executor and AGENTS.md do the same).
 * `runScripts` is the explicit opt-in; `rebuild` runs only the allowlisted scripts that were accepted.
 * Every step runs in the clean check environment, built once per install. */
export const npmInstaller: DependencyInstaller = async (directory, options) => {
  const clean = cleanCommandEnvironment('install');
  try {
    await npm(
      directory,
      [
        'ci',
        ...(options?.runScripts ? [] : ['--ignore-scripts']),
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
      ],
      clean.env,
    );
    if (!options?.runScripts && options?.rebuild?.length)
      await npm(
        directory,
        ['rebuild', '--no-audit', '--no-fund', '--loglevel=error', ...options.rebuild],
        clean.env,
      );
  } finally {
    clean.dispose();
  }
};
/** Lockfile packages (by name) that declare an install script. */
export function scriptedPackages(lock: Buffer): string[] {
  try {
    const packages =
      (JSON.parse(lock.toString('utf8')) as { packages?: Record<string, { hasInstallScript?: boolean }> })
        .packages ?? {};
    return Object.entries(packages)
      .filter(([key, entry]) => key !== '' && entry?.hasInstallScript === true)
      .map(([key]) =>
        key.includes('node_modules/') ? key.slice(key.lastIndexOf('node_modules/') + 13) : key,
      );
  } catch {
    return [];
  }
}
/** Allowlisted packages that are in the lockfile and declare a script: what to rebuild. */
export function allowedRebuilds(root: string): string[] {
  const allow = readInstallScriptAllowlist(root);
  if (!allow || allow.all) return [];
  try {
    const scripted = new Set(scriptedPackages(readFileSync(join(root, 'package-lock.json'))));
    return allow.packages.filter(name => scripted.has(name));
  } catch {
    return [];
  }
}
