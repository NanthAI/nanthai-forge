// SPDX-License-Identifier: Apache-2.0
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
import { linkInstall } from './dependency-link.js';
import { allowedRebuilds, npmInstaller, scriptedPackages } from './npm-install.js';
import {
  detectPackageManager,
  installConfigFiles,
  managerWorkspaceFolders,
  unsharableReason,
  type PackageManager,
} from './package-manager.js';
import {
  managerInstall,
  managerRebuilds,
  managerSkippedScripts,
  resolveRunner,
  type ManagerRunner,
  type SkippedScriptsHint,
} from './package-manager-install.js';
import { acquireHeavySlot, heavySlotDirectory } from './heavy-slots.js';
import { heavySlots, readClientSettings } from './client-settings.js';

export { npmInstaller };
export type DependencyInstaller = (
  directory: string,
  /** `rebuild`: packages the repository allowlists; their scripts run after a script-less install. */
  options?: {
    runScripts?: boolean;
    rebuild?: string[];
    /** Set for pnpm, yarn and bun: the declared manager and how to run it. */
    manager?: PackageManager;
    runner?: ManagerRunner | undefined;
  },
) => Promise<void>;
/** Install scripts a default (script-less) install skipped, and the command that runs them. */
export type SkippedScripts = SkippedScriptsHint;
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
export function dependencyKey(root: string, managerVersion?: string): string | null {
  const detected = detectPackageManager(root);
  if (!detected || 'reason' in detected) return null;
  const pm = detected.manager;
  let lock: Buffer, manifest: Buffer;
  try {
    lock = readFileSync(join(root, pm.lockfile));
    manifest = readFileSync(join(root, 'package.json'));
  } catch {
    return null;
  }
  const hash = createHash('sha256').update(lock).update('\0').update(manifest);
  const other = pm.name !== 'npm';
  const found = other ? managerWorkspaceFolders(root, pm) : workspaceDirectories(lock);
  for (const folder of Array.isArray(found) ? found : []) {
    try {
      hash.update(`\0${folder}\0`).update(readFileSync(join(root, folder, 'package.json')));
    } catch {
      /* A missing workspace manifest is reported when the stage is built. */
    }
  }
  if (other) {
    // The manager and its version decide the layout; settings and patches decide the contents.
    hash.update(`\0pm:${pm.name}@${managerVersion ?? pm.declared ?? 'unresolved'}`);
    for (const file of installConfigFiles(root)) {
      try {
        hash.update(`\0${file}\0`).update(readFileSync(join(root, file)));
      } catch {
        /* A vanished file changes the next key. */
      }
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
const ROOT_INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];
/** What an install without scripts skipped: lockfile packages that declare an install script
 * (`hasInstallScript`) plus the root package's own install lifecycle. */
export function skippedInstallScripts(root: string): SkippedScripts | undefined {
  const detected = detectPackageManager(root);
  if (detected && 'manager' in detected && detected.manager.name !== 'npm') {
    const hint = managerSkippedScripts(root, detected.manager);
    return hint.packages === 0 ? undefined : hint;
  }
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
    ? `Skipped install scripts of ${skipped.packages === null ? 'dependencies' : `${skipped.packages} package${skipped.packages === 1 ? '' : 's'}`}. Run them with: ${skipped.command} (in the Lane), or start with {"installScripts":true} or set {"install":{"scripts":true}} in forge.json.`
    : null;
}
/** Build the install stage: root manifest and lockfile plus every workspace package.json (and, for
 * pnpm, yarn and bun, the manager settings and patches the install reads).
 * Returns a reason when the repository names a workspace the stage cannot copy faithfully. */
function writeStage(root: string, stage: string, pm: PackageManager, folders: string[]): string | null {
  const copy = (file: string) => {
    mkdirSync(dirname(join(stage, file)), { recursive: true });
    copyFileSync(join(root, file), join(stage, file));
  };
  for (const folder of folders) {
    if (!exists(join(root, folder, 'package.json')))
      return `Workspace ${folder} has no package.json; ${pm.name === 'npm' ? 'npm ci' : `${pm.name} install`} would fail.`;
    copy(join(folder, 'package.json'));
  }
  copy('package.json');
  copy(pm.lockfile);
  if (pm.name !== 'npm') for (const file of installConfigFiles(root)) copy(file);
  return null;
}

/** Link ROOT/node_modules to the machine's install for this exact lockfile and manager version,
 * installing it once with the manager the repository declares (npm, pnpm, yarn or bun).
 * Leaves an existing node_modules alone. Concurrent opens of the same lockfile install once. */
export async function shareDependencies(
  root: string,
  options: {
    install?: DependencyInstaller;
    enabled?: boolean;
    cache?: string;
    heavy?: boolean;
    /** Opt in to (true) or out of (false) all dependency install scripts; it wins over the repository.
     * Unset: skipped, unless the repository allows them (forge.json `install.scripts`, an allowlist). */
    runScripts?: boolean | undefined;
    /** How to run a non-npm manager (default: corepack at the declared version, else PATH). */
    resolve?: (pm: PackageManager) => Promise<ManagerRunner | { reason: string }>;
  } = {},
): Promise<SharedDependencies> {
  if (!(options.enabled ?? readClientSettings().shareDependencies)) return { status: 'off' };
  const detected = detectPackageManager(root);
  if (!detected) return { status: 'none' };
  if ('reason' in detected) return { status: 'none', reason: detected.reason };
  const pm = detected.manager,
    other = pm.name !== 'npm';
  if (exists(join(root, 'node_modules')))
    return dependencyKey(root) ? { status: 'present' } : { status: 'none' };
  let runner: ManagerRunner | undefined,
    folders: string[] = [];
  if (other) {
    const blocked = unsharableReason(root, pm);
    if (blocked) return { status: 'none', reason: blocked };
    const found = managerWorkspaceFolders(root, pm);
    if (!Array.isArray(found)) return { status: 'none', reason: found.reason };
    folders = found;
    const resolved = await (options.resolve ?? resolveRunner)(pm);
    if ('reason' in resolved) return { status: 'none', reason: resolved.reason };
    runner = resolved;
  }
  const key = dependencyKey(root, runner?.version);
  if (!key) return { status: 'none' };
  const cache = options.cache ?? dependencyCacheDirectory(),
    runScripts = options.runScripts ?? readInstallScriptAllowlist(root)?.all === true,
    prefix = `${pm.name}${runScripts ? '-scripts' : ''}`,
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
        // npm installs in a temporary stage renamed into place; other managers install in place
        // (their shims and links record absolute paths) and the completion marker makes it atomic.
        const stage = other ? entry : mkdtempSync(join(cache, `${prefix}-${key}.tmp-`));
        mkdirSync(stage, { recursive: true });
        const stageFolders = other ? folders : workspaceDirectories(readFileSync(join(root, pm.lockfile)));
        const unusable = stageFolders
          ? writeStage(root, stage, pm, stageFolders)
          : 'package-lock.json names a workspace folder outside the repository.';
        if (unusable) {
          rmSync(stage, { recursive: true, force: true });
          return { status: 'none', reason: unusable };
        }
        const settings = readClientSettings(),
          slots = options.heavy === false ? 0 : heavySlots(settings.localHeavySlots);
        const slot = slots ? await acquireHeavySlot(heavySlotDirectory(), slots) : null;
        try {
          const rebuild = other ? managerRebuilds(root, pm) : allowedRebuilds(root);
          await (
            options.install ??
            (other
              ? (directory, installOptions) => managerInstall(directory, pm, runner!, installOptions)
              : npmInstaller)
          )(stage, { runScripts, rebuild, manager: pm, runner });
        } catch (error) {
          rmSync(stage, { recursive: true, force: true });
          return { status: 'failed', key, message: error instanceof Error ? error.message : String(error) };
        } finally {
          if (slot) rmSync(slot, { recursive: true, force: true });
        }
        writeFileSync(join(stage, '.forge-complete'), key);
        if (!other) renameSync(stage, entry);
        installed = true;
      }
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  const path = join(entry, 'node_modules');
  if (!exists(path))
    return other
      ? { status: 'none', reason: `${pm.name} install produced no node_modules.` }
      : { status: 'none' };
  // npm workspaces link siblings inside the root node_modules; they must reach the Lane's source too.
  const npmFolders = other ? [] : (workspaceDirectories(readFileSync(join(root, pm.lockfile))) ?? []);
  if (other || npmFolders.length) linkInstall(entry, root, other ? folders : npmFolders);
  else symlinkSync(path, join(root, 'node_modules'), 'dir');
  const skippedScripts = runScripts ? undefined : skippedInstallScripts(root);
  return {
    status: installed ? 'installed' : 'linked',
    key,
    path,
    ...(skippedScripts ? { skippedScripts } : {}),
  };
}
