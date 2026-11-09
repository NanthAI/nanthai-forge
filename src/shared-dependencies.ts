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
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { readInstallScriptAllowlist, type InstallScriptAllowlist } from './install-script-allowlist.js';
import { linkInstall } from './dependency-link.js';
import { removeInstall, sealInstall } from './dependency-seal.js';
import { recordLink, relinkIfStale, type Relinked } from './dependency-relink.js';
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
import { installRegistryHosts, type RegistryHosts } from './install-registry-hosts.js';
import { sharedDownloadCache } from './install-download-cache.js';
import { linkDirectory } from './source-links.js';

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
    /** Download cache shared by this project's script-less pnpm and Yarn Berry installs. */
    downloads?: string;
  },
) => Promise<void>;
/** Install scripts a default (script-less) install skipped, and the command that runs them. */
export type SkippedScripts = SkippedScriptsHint;
/** Which dependency install scripts ran for this install, and who decided: `start` (installScripts:true)
 * or `machine` (the installScripts client setting accepted the repository's request). */
export type RanScripts = { ran: 'all' | string[]; because: 'start' | 'machine'; source?: string };
/** Whose decision runs install scripts. A repository's declaration (forge.json install.scripts,
 * .yarnrc.yml enableScripts, a package allowlist) is only a request: it runs when start passes
 * installScripts:true (everything) or this machine's installScripts setting accepts it. */
export type InstallScriptsPolicy = {
  mode: 'none' | 'allowlist' | 'all';
  because?: RanScripts['because'];
  requested: InstallScriptAllowlist | null;
};
export function installScriptsPolicy(
  root: string,
  startFlag: boolean | undefined,
  machine: boolean = readClientSettings().installScripts,
): InstallScriptsPolicy {
  const requested = readInstallScriptAllowlist(root);
  if (startFlag === true) return { mode: 'all', because: 'start', requested };
  if (startFlag === false || !machine || !requested) return { mode: 'none', requested };
  return { mode: requested.all ? 'all' : 'allowlist', because: 'machine', requested };
}
export type SharedDependencies =
  | { status: 'off' | 'present' }
  | { status: 'none'; reason?: string }
  /** A Forge link to an install of an older lockfile that could not be replaced safely. */
  | { status: 'stale'; reason: string }
  | {
      status: 'linked' | 'installed';
      key: string;
      path: string;
      skippedScripts?: SkippedScripts;
      /** The repository asked for install scripts and nobody accepted: shown, never run. */
      requestedScripts?: { source: string; packages: 'all' | string[] };
      /** Install scripts this install ran (in the clean environment) and why. */
      scripts?: RanScripts;
      /** The Lane's links followed a changed lockfile; `from` is the key it pointed at before. */
      relinked?: Relinked;
      /** Hosts besides the public npm registries that the lockfile or install settings name. */
      registryHosts?: RegistryHosts;
    }
  | { status: 'failed'; key: string; message: string; registryHosts?: RegistryHosts };

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
/** The hosted project a Lane checkout belongs to (deployment and project id), or null for any other folder. */
function hostedProject(root: string): string | null {
  try {
    const marker = JSON.parse(readFileSync(join(root, '.forge', 'hosted-lane.json'), 'utf8')) as {
      url?: unknown;
      selection?: { projectId?: unknown };
    };
    const project = marker.selection?.projectId;
    return typeof project === 'string' && project && typeof marker.url === 'string'
      ? `${marker.url}/${project}`
      : null;
  } catch {
    return null;
  }
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
  // A hosted Lane's install is its project's own: a fork with identical manifests never shares it.
  const project = hostedProject(root);
  if (project) hash.update(`\0project:${project}`);
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
export function skippedInstallScripts(root: string, rebuilt: string[] = []): SkippedScripts | undefined {
  const detected = detectPackageManager(root);
  if (detected && 'manager' in detected && detected.manager.name !== 'npm') {
    const hint = managerSkippedScripts(root, detected.manager, rebuilt);
    return hint.packages === 0 ? undefined : hint;
  }
  let packages = 0;
  try {
    const allowed = new Set(rebuilt);
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
const ACCEPT =
  'start with {"installScripts":true}, or accept repository requests on this machine with nforge settings installScripts true';
/** The one stderr line about install scripts: which ran and why, or which were skipped (naming the
 * repository's request when it made one) and how to run them; null when nothing declared a script. */
export function installScriptsNotice(result: object): string | null {
  const {
    skippedScripts: skipped,
    requestedScripts: requested,
    scripts,
    status,
  } = result as {
    skippedScripts?: SkippedScripts;
    requestedScripts?: { source: string; packages: 'all' | string[] };
    scripts?: RanScripts;
    status?: string;
  };
  if (scripts) {
    const what =
      scripts.ran === 'all'
        ? 'all dependency install scripts'
        : `install scripts of ${scripts.ran.join(', ')}`;
    const why =
      scripts.because === 'start'
        ? 'start passed installScripts:true'
        : `this machine's installScripts setting accepts the request in ${scripts.source ?? 'the repository'}`;
    return `${status === 'installed' ? 'Ran' : 'node_modules links an install that ran'} ${what} in the clean install environment: ${why}.`;
  }
  if (!skipped) return null;
  const count =
    skipped.packages === null
      ? 'dependencies'
      : `${skipped.packages} package${skipped.packages === 1 ? '' : 's'}`;
  const asked = requested
    ? ` ${requested.source} asks to run ${requested.packages === 'all' ? 'them' : requested.packages.join(', ')}; that is a request, not a permission.`
    : '';
  return `Skipped install scripts of ${count}.${asked} Run them with: ${skipped.command} (in the Lane), or ${ACCEPT}.`;
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
 * An install the agent made is left alone. A link Forge made to an older lockfile's install is
 * replaced (one key compare; an install only when the new key is not cached yet), so a sync that
 * brings a package never leaves the Lane on the old one. `refresh` never creates a first link.
 * Concurrent opens of the same lockfile install once. */
export async function shareDependencies(
  root: string,
  options: {
    install?: DependencyInstaller;
    enabled?: boolean;
    cache?: string;
    heavy?: boolean;
    /** Opt in to (true) or out of (false) all dependency install scripts (start installScripts).
     * Unset: skipped; a repository's request (forge.json `install.scripts`, an allowlist) runs only
     * when this machine's installScripts setting accepts it (installScriptsPolicy). */
    runScripts?: boolean | undefined;
    /** Only follow a lockfile change of an existing Forge link; a Lane with no node_modules stays without. */
    refresh?: boolean;
    /** How to run a non-npm manager (default: corepack at the declared version, else PATH). */
    resolve?: (pm: PackageManager) => Promise<ManagerRunner | { reason: string }>;
    /** Called with the non-public hosts the install will fetch from, before it runs. */
    announce?: (hosts: RegistryHosts) => void;
  } = {},
): Promise<SharedDependencies> {
  if (!(options.enabled ?? readClientSettings().shareDependencies)) return { status: 'off' };
  const detected = detectPackageManager(root);
  if (!detected) return { status: 'none' };
  if ('reason' in detected) return { status: 'none', reason: detected.reason };
  const pm = detected.manager,
    other = pm.name !== 'npm';
  if (exists(join(root, 'node_modules'))) {
    const current = dependencyKey(root);
    if (!current) return { status: 'none' };
    const relinked = await relinkIfStale(root, current, () =>
      shareDependencies(root, { ...options, refresh: false }),
    );
    return relinked ?? { status: 'present' };
  }
  if (options.refresh) return { status: 'none' };
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
  const policy = installScriptsPolicy(root, options.runScripts),
    runScripts = policy.mode === 'all',
    rebuild = policy.mode !== 'allowlist' ? [] : other ? managerRebuilds(root, pm) : allowedRebuilds(root);
  // Each script mode has its own entry: a Lane that did not accept scripts never links one that ran
  // them. `-skipped` holds a requesting repository's script-less install: its plain entry from before
  // requests needed acceptance may have run the allowlisted scripts, so it is never linked again.
  const cache = options.cache ?? dependencyCacheDirectory(),
    mode = runScripts ? '-scripts' : rebuild.length ? '-rebuild' : policy.requested ? '-skipped' : '',
    prefix = `${pm.name}${mode}`,
    entry = join(cache, `${prefix}-${key}`);
  const registryHosts = installRegistryHosts(root, pm),
    hosts = registryHosts ? { registryHosts } : {};
  let installed = false;
  if (!complete(entry, key)) {
    if (registryHosts) options.announce?.(registryHosts);
    mkdirSync(cache, { recursive: true });
    // The per-lockfile lock reuses the heavy-slot primitive with one slot; a dead holder is reclaimed.
    const locks = join(cache, `${prefix}-${key}.lock`);
    const lock = await acquireHeavySlot(locks, 1);
    try {
      if (!complete(entry, key)) {
        for (const name of readdirSync(cache))
          if (name.startsWith(`${prefix}-${key}.tmp-`)) removeInstall(join(cache, name));
        removeInstall(entry);
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
        // Script-less installs of one project share a content-addressed download cache; an install
        // that runs package scripts keeps a private one (code that could write the shared directory).
        const downloads =
          other && !runScripts && !rebuild.length
            ? sharedDownloadCache(cache, pm, hostedProject(root))
            : null;
        const settings = readClientSettings(),
          slots = options.heavy === false ? 0 : heavySlots(settings.localHeavySlots);
        const slot = slots ? await acquireHeavySlot(heavySlotDirectory(), slots) : null;
        try {
          await (
            options.install ??
            (other
              ? (directory, installOptions) => managerInstall(directory, pm, runner!, installOptions)
              : npmInstaller)
          )(stage, { runScripts, rebuild, manager: pm, runner, ...(downloads ? { downloads } : {}) });
        } catch (error) {
          rmSync(stage, { recursive: true, force: true });
          return {
            status: 'failed',
            key,
            message: error instanceof Error ? error.message : String(error),
            ...hosts,
          };
        } finally {
          if (slot) rmSync(slot, { recursive: true, force: true });
        }
        // Read-only before the marker: an entry that carries the marker is always sealed.
        sealInstall(
          stage,
          ['', ...(stageFolders ?? [])].map(folder => join(stage, folder, 'node_modules')),
        );
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
  else linkDirectory(path, join(root, 'node_modules'));
  const fingerprint = dependencyKey(root);
  if (fingerprint) recordLink(root, { fingerprint, entry, folders: other ? folders : npmFolders });
  const skippedScripts = runScripts ? undefined : skippedInstallScripts(root, rebuild);
  const ran: RanScripts | undefined =
    policy.because && (runScripts || rebuild.length)
      ? {
          ran: runScripts ? 'all' : rebuild,
          because: policy.because,
          ...(policy.because === 'machine' && policy.requested ? { source: policy.requested.source } : {}),
        }
      : undefined;
  const requested =
    policy.requested && skippedScripts
      ? {
          source: policy.requested.source,
          packages: policy.requested.all ? ('all' as const) : policy.requested.packages,
        }
      : undefined;
  return {
    status: installed ? 'installed' : 'linked',
    key,
    path,
    ...(skippedScripts ? { skippedScripts } : {}),
    ...(requested ? { requestedScripts: requested } : {}),
    ...(ran ? { scripts: ran } : {}),
    ...hosts,
  };
}
