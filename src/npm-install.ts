// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readInstallScriptAllowlist } from './install-script-allowlist.js';
import type { DependencyInstaller } from './shared-dependencies.js';

const npm = (directory: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn('npm', args, {
      cwd: directory,
      // npm output goes to stderr; stdout stays the command's JSON receipt.
      stdio: ['ignore', 2, 2],
    });
    child.once('error', reject);
    child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`npm ${args[0]} exited ${code}`))));
  });
/** Install scripts never run by default (the Actions executor and AGENTS.md do the same).
 * `runScripts` is the explicit opt-in; `rebuild` runs only the scripts a repository allowlists. */
export const npmInstaller: DependencyInstaller = async (directory, options) => {
  await npm(directory, [
    'ci',
    ...(options?.runScripts ? [] : ['--ignore-scripts']),
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
  ]);
  if (!options?.runScripts && options?.rebuild?.length)
    await npm(directory, ['rebuild', '--no-audit', '--no-fund', '--loglevel=error', ...options.rebuild]);
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
