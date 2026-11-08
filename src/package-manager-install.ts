// SPDX-License-Identifier: Apache-2.0
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PackageManager } from './package-manager.js';
import { cleanCommandEnvironment } from './clean-command-env.js';
import { readInstallScriptAllowlist } from './install-script-allowlist.js';
import { CLEAN_INSTALL_HINT } from './npm-install.js';

/** How to invoke the declared manager: through corepack at the declared version where it can,
 * else the manager already on PATH. Forge never installs a manager globally. */
export type ManagerRunner = { command: string; prefix: string[]; version: string };
export type SkippedScriptsHint = { packages: number | null; command: string };

const probe = (command: string, args: string[]) =>
  new Promise<string | null>(resolve =>
    execFile(command, args, { timeout: 20_000 }, (error, stdout) =>
      resolve(error ? null : (String(stdout).trim().split('\n').pop() ?? '')),
    ),
  );

/** The runner for a non-npm manager, or the reason none is usable. */
export async function resolveRunner(pm: PackageManager): Promise<ManagerRunner | { reason: string }> {
  if (pm.declared && (pm.name === 'pnpm' || pm.name === 'yarn') && (await probe('corepack', ['--version'])))
    return { command: 'corepack', prefix: [pm.name], version: pm.declared };
  const found = await probe(pm.name, ['--version']);
  if (!found)
    return {
      reason: `${pm.name} is not installed${pm.declared ? ` (the repository declares ${pm.name}@${pm.declared})` : ''}; Forge does not install package managers.`,
    };
  if (pm.name === 'yarn' && Number(found.split('.')[0]) >= 2 !== pm.berry)
    return {
      reason: `yarn ${found} on PATH does not match this repository's ${pm.berry ? 'Yarn Berry' : 'Yarn classic'} lockfile; declare packageManager so corepack can supply it.`,
    };
  return { command: pm.name, prefix: [], version: found };
}

type Step = { args: string[]; env: Record<string, string> };
/** The install (and, for allowlisted packages, rebuild) commands per manager. Pure, so tests assert them. */
export function installSteps(pm: PackageManager, runScripts: boolean, rebuild: string[]): Step[] {
  const skip = runScripts ? [] : ['--ignore-scripts'];
  const rebuilds = !runScripts && rebuild.length > 0;
  switch (pm.name) {
    case 'pnpm':
      return [
        { args: ['install', '--frozen-lockfile', ...skip], env: { CI: '1' } },
        ...(rebuilds ? [{ args: ['rebuild', ...rebuild], env: { CI: '1' } }] : []),
      ];
    case 'bun':
      return [
        { args: ['install', '--frozen-lockfile', ...skip], env: {} },
        ...(rebuilds ? [{ args: ['pm', 'trust', ...rebuild], env: {} }] : []),
      ];
    case 'yarn': {
      if (!pm.berry)
        return [{ args: ['install', '--frozen-lockfile', '--non-interactive', ...skip], env: {} }];
      // YARN_IGNORE_PATH: never run the release file the repository commits; the declared version comes from corepack.
      const env = { YARN_IGNORE_PATH: '1', YARN_ENABLE_TELEMETRY: '0' };
      return [
        {
          args: ['install', '--immutable'],
          env: runScripts ? env : { ...env, YARN_ENABLE_SCRIPTS: 'false' },
        },
        ...(rebuilds ? [{ args: ['rebuild', ...rebuild], env }] : []),
      ];
    }
    default:
      throw new Error(`${pm.name} installs through npmInstaller`);
  }
}

const run = (runner: ManagerRunner, directory: string, step: Step, clean: NodeJS.ProcessEnv) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(runner.command, [...runner.prefix, ...step.args], {
      cwd: directory,
      env: {
        ...clean,
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
        COREPACK_ENABLE_AUTO_PIN: '0',
        ...step.env,
      },
      // Manager output goes to stderr; stdout stays the command's JSON receipt.
      stdio: ['ignore', 2, 2],
    });
    child.once('error', reject);
    child.once('exit', code =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${runner.prefix[0] ?? runner.command} ${step.args[0]} exited ${code} ${CLEAN_INSTALL_HINT}.`,
            ),
          ),
    );
  });
/** Install a non-npm repository's frozen lockfile in DIRECTORY (scripts skipped unless asked), in the
 * clean check environment built once for the install. */
export async function managerInstall(
  directory: string,
  pm: PackageManager,
  runner: ManagerRunner,
  options: { runScripts?: boolean; rebuild?: string[] } = {},
) {
  const clean = cleanCommandEnvironment('install');
  try {
    for (const step of installSteps(pm, options.runScripts === true, options.rebuild ?? []))
      await run(runner, directory, step, clean.env);
  } finally {
    clean.dispose();
  }
}

/** pnpm-lock.yaml packages that need a build (`requiresBuild: true`), by name. */
function pnpmScripted(lock: string): string[] {
  const found = new Set<string>();
  let current = '';
  for (const line of lock.split(/\r?\n/)) {
    const key = /^ {2}'?(@?[^@\s'][^@\s']*)@/.exec(line);
    if (key) current = key[1] ?? '';
    else if (/^ {4}requiresBuild:\s*true\s*$/.test(line) && current) found.add(current);
  }
  return [...found];
}
/** Allowlisted names a rebuild applies to: those the lockfile has (and, for pnpm, that need a build). */
export function managerRebuilds(root: string, pm: PackageManager): string[] {
  const allow = readInstallScriptAllowlist(root);
  if (!allow || allow.all || (pm.name === 'yarn' && !pm.berry)) return [];
  const lock = readLock(root, pm);
  if (pm.name === 'pnpm') {
    const scripted = new Set(pnpmScripted(lock));
    return allow.packages.filter(name => scripted.has(name));
  }
  // bun.lock and yarn.lock do not record which packages have scripts: rebuild the allowlisted ones they hold.
  return allow.packages.filter(name => lock.includes(`"${name}"`) || lock.includes(`${name}@`));
}
const readLock = (root: string, pm: PackageManager) => {
  try {
    return pm.lockfile.endsWith('.lockb') ? '' : readFileSync(join(root, pm.lockfile), 'utf8');
  } catch {
    return '';
  }
};

const ROOT_INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];
const REBUILD: Record<string, string> = {
  pnpm: 'pnpm rebuild',
  bun: 'bun pm trust --all',
  yarn: 'yarn rebuild',
};
/** What a script-less install of a non-npm repository skipped. pnpm's lockfile names the packages
 * that need a build; yarn and bun lockfiles do not, so their count is unknown (null). */
export function managerSkippedScripts(
  root: string,
  pm: PackageManager,
  rebuilt: string[] = [],
): SkippedScriptsHint {
  let packages: number | null = null;
  if (pm.name === 'pnpm') {
    const allowed = new Set(rebuilt);
    packages = pnpmScripted(readLock(root, pm)).filter(name => !allowed.has(name)).length;
  }
  try {
    const scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: object })
      .scripts as Record<string, unknown> | undefined;
    if (packages !== null && scripts && ROOT_INSTALL_SCRIPTS.some(name => typeof scripts[name] === 'string'))
      packages++;
  } catch {
    /* An unreadable manifest adds no root script. */
  }
  return {
    packages,
    command: pm.name === 'yarn' && !pm.berry ? 'npm rebuild' : (REBUILD[pm.name] ?? 'npm rebuild'),
  };
}
