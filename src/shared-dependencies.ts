// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { readInstallScriptAllowlist } from './install-script-allowlist.js';
import { acquireHeavySlot, heavySlotDirectory } from './heavy-slots.js';
import { heavySlots, readClientSettings } from './client-settings.js';

export type DependencyInstaller = (
  directory: string,
  /** `rebuild`: packages the repository allowlists; their scripts run after a script-less install. */
  options?: { runScripts?: boolean; rebuild?: string[] },
) => Promise<void>;
/** Install scripts a default (script-less) install skipped, and the command that runs them. */
export type SkippedScripts = { packages: number; command: string };
export type SharedDependencies =
  | { status: 'off' | 'present' }
  | { status: 'none'; reason?: string }
  | { status: 'linked' | 'installed'; key: string; path: string; skippedScripts?: SkippedScripts }
  | { status: 'failed'; key: string; message: string };

export function dependencyCacheDirectory() {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'forge', 'deps');
}
/** Workspace folders the lockfile records: every `packages` key outside node_modules (not the root).
 * Null when one escapes the root, so the stage could not hold a faithful copy. */
export function workspaceDirectories(lock: Buffer): string[] | null {
  let packages: Record<string, unknown>;
  try {
    packages = (JSON.parse(lock.toString('utf8')) as { packages?: Record<string, unknown> }).packages ?? {};
  } catch {
    return [];
  }
  const folders = Object.keys(packages).filter(
    key => key !== '' && !key.startsWith('node_modules/') && !key.includes('/node_modules/'),
  );
  return folders.every(folder => !isAbsolute(folder) && !folder.split('/').includes('..'))
    ? folders.sort()
    : null;
}
/** npm installs are keyed by the exact lockfile, package.json (and every workspace package.json),
 * platform and Node major version, so a Lane with a different lockfile never shares another Lane's install. */
export function dependencyKey(root: string): string | null {
  let lock: Buffer, manifest: Buffer;
  try {
    lock = readFileSync(join(root, 'package-lock.json'));
    manifest = readFileSync(join(root, 'package.json'));
  } catch {
    return null;
  }
  const hash = createHash('sha256').update(lock).update('\0').update(manifest);
  for (const folder of workspaceDirectories(lock) ?? []) {
    try {
      hash.update(`\0${folder}\0`).update(readFileSync(join(root, folder, 'package.json')));
    } catch {
      /* A missing workspace manifest is reported when the stage is built. */
    }
  }
  const allow = readInstallScriptAllowlist(root);
  if (allow) hash.update(`\0allow:${JSON.stringify(allow)}`);
  return hash
    .update(`\0${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}`)
    .digest('hex')
    .slice(0, 24);
}
const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
const complete = (entry: string, key: string) => {
  try {
    return readFileSync(join(entry, '.forge-complete'), 'utf8') === key;
  } catch {
    return false;
  }
};
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
function scriptedPackages(lock: Buffer): string[] {
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
function allowedRebuilds(root: string): string[] {
  const allow = readInstallScriptAllowlist(root);
  if (!allow || allow.all) return [];
  try {
    const scripted = new Set(scriptedPackages(readFileSync(join(root, 'package-lock.json'))));
    return allow.packages.filter(name => scripted.has(name));
  } catch {
    return [];
  }
}

const ROOT_INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];
/** What an install without scripts skipped: lockfile packages that declare an install script
 * (`hasInstallScript`) plus the root package's own install lifecycle. */
export function skippedInstallScripts(root: string): SkippedScripts | undefined {
  let packages = 0;
  try {
    const allowed = new Set(allowedRebuilds(root));
    for (const name of scriptedPackages(readFileSync(join(root, 'package-lock.json'))))
      if (!allowed.has(name)) packages++;
    const scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: object })
      .scripts as Record<string, unknown> | undefined;
    if (scripts && ROOT_INSTALL_SCRIPTS.some(name => typeof scripts[name] === 'string')) packages++;
  } catch {
    return undefined;
  }
  return packages ? { packages, command: 'npm rebuild' } : undefined;
}
/** The one line printed when a script-less install skipped declared scripts; null otherwise. */
export function skippedScriptsNotice(result: object): string | null {
  const skipped = (result as { skippedScripts?: SkippedScripts }).skippedScripts;
  return skipped
    ? `Skipped install scripts of ${skipped.packages} package${skipped.packages === 1 ? '' : 's'}. Run them with: ${skipped.command} (in the Lane), or start with {"installScripts":true}.`
    : null;
}
/** Build the install stage: root manifest and lockfile plus every workspace package.json.
 * Returns a reason when the lockfile names a workspace the stage cannot copy faithfully. */
function writeStage(root: string, stage: string): string | null {
  const lock = readFileSync(join(root, 'package-lock.json')),
    folders = workspaceDirectories(lock);
  if (!folders) return 'package-lock.json names a workspace folder outside the repository.';
  for (const folder of folders) {
    const source = join(root, folder, 'package.json');
    if (!exists(source)) return `Workspace ${folder} has no package.json; npm ci would fail.`;
    mkdirSync(join(stage, dirname(join(folder, 'package.json'))), { recursive: true });
    copyFileSync(source, join(stage, folder, 'package.json'));
  }
  copyFileSync(join(root, 'package.json'), join(stage, 'package.json'));
  copyFileSync(join(root, 'package-lock.json'), join(stage, 'package-lock.json'));
  return null;
}

/** Link ROOT/node_modules to the machine's install for this exact lockfile, installing it once.
 * Leaves an existing node_modules alone. Concurrent opens of the same lockfile install once. */
export async function shareDependencies(
  root: string,
  options: {
    install?: DependencyInstaller;
    enabled?: boolean;
    cache?: string;
    heavy?: boolean;
    /** Opt in to all dependency install scripts (default: skipped, unless the repository allowlists some). */
    runScripts?: boolean;
  } = {},
): Promise<SharedDependencies> {
  if (!(options.enabled ?? readClientSettings().shareDependencies)) return { status: 'off' };
  const key = dependencyKey(root);
  if (!key) return { status: 'none' };
  if (exists(join(root, 'node_modules'))) return { status: 'present' };
  const cache = options.cache ?? dependencyCacheDirectory(),
    runScripts = options.runScripts === true || readInstallScriptAllowlist(root)?.all === true,
    prefix = runScripts ? 'npm-scripts' : 'npm',
    entry = join(cache, `${prefix}-${key}`);
  let installed = false;
  if (!complete(entry, key)) {
    mkdirSync(cache, { recursive: true });
    // The per-lockfile lock reuses the heavy-slot primitive with one slot; a dead holder is reclaimed.
    const locks = join(cache, `${prefix}-${key}.lock`);
    const lock = await acquireHeavySlot(locks, 1);
    try {
      if (!complete(entry, key)) {
        for (const name of readdirSync(cache))
          if (name.startsWith(`${prefix}-${key}.tmp-`))
            rmSync(join(cache, name), { recursive: true, force: true });
        rmSync(entry, { recursive: true, force: true });
        const stage = mkdtempSync(join(cache, `${prefix}-${key}.tmp-`));
        const unusable = writeStage(root, stage);
        if (unusable) {
          rmSync(stage, { recursive: true, force: true });
          return { status: 'none', reason: unusable };
        }
        const settings = readClientSettings(),
          slots = options.heavy === false ? 0 : heavySlots(settings.localHeavySlots);
        const slot = slots ? await acquireHeavySlot(heavySlotDirectory(), slots) : null;
        try {
          await (options.install ?? npmInstaller)(stage, { runScripts, rebuild: allowedRebuilds(root) });
        } catch (error) {
          rmSync(stage, { recursive: true, force: true });
          return { status: 'failed', key, message: error instanceof Error ? error.message : String(error) };
        } finally {
          if (slot) rmSync(slot, { recursive: true, force: true });
        }
        writeFileSync(join(stage, '.forge-complete'), key);
        renameSync(stage, entry);
        installed = true;
      }
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  const path = join(entry, 'node_modules');
  if (!exists(path)) return { status: 'none' };
  symlinkSync(path, join(root, 'node_modules'), 'dir');
  const skippedScripts = runScripts ? undefined : skippedInstallScripts(root);
  return {
    status: installed ? 'installed' : 'linked',
    key,
    path,
    ...(skippedScripts ? { skippedScripts } : {}),
  };
}
