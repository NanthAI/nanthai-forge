// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

/** Which JavaScript package manager a repository declares, and what its install layout needs.
 * Reads files only. One small module so the ecosystem registry can absorb it later. */
export type ManagerName = 'npm' | 'pnpm' | 'yarn' | 'bun';
export type PackageManager = {
  name: ManagerName;
  /** Version from the `packageManager` field, or null when only the lockfile identifies the manager. */
  declared: string | null;
  lockfile: string;
  /** Yarn 2+ (Berry): `--immutable`, `.yarnrc.yml`; false for Yarn classic and every other manager. */
  berry: boolean;
};
/** null: nothing identifies a manager. A reason: a manager is named or implied but cannot be used safely. */
export type Detection = { manager: PackageManager } | { reason: string } | null;

const LOCKFILES: Record<ManagerName, string[]> = {
  npm: ['package-lock.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb'],
};
const NAMES = Object.keys(LOCKFILES) as ManagerName[];
const text = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};
const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2');
const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The manager the repository declares: `packageManager` first, then the lockfile. A declared
 * manager without its lockfile, or several lockfiles with no declaration, is a reason, never a guess. */
export function detectPackageManager(root: string): Detection {
  const raw = text(join(root, 'package.json'));
  if (raw === undefined) return null;
  let declaredField: unknown;
  try {
    declaredField = (JSON.parse(raw) as { packageManager?: unknown }).packageManager;
  } catch {
    return null;
  }
  const lockfileOf = (name: ManagerName) => LOCKFILES[name].find(file => existsSync(join(root, file)));
  const build = (name: ManagerName, declared: string | null, lockfile: string): Detection => {
    const major = declared ? Number(declared.split('.')[0]) : NaN;
    const berry =
      name === 'yarn' &&
      (Number.isFinite(major)
        ? major >= 2
        : existsSync(join(root, '.yarnrc.yml')) ||
          (text(join(root, lockfile)) ?? '').includes('__metadata:'));
    return { manager: { name, declared, lockfile, berry } };
  };
  if (typeof declaredField === 'string') {
    const [, name, version] = /^([a-z]+)@(\d+\.\d+\.\d+[^+]*)(?:\+.*)?$/.exec(declaredField) ?? [];
    if (!name || !NAMES.includes(name as ManagerName))
      return {
        reason: `package.json declares packageManager ${JSON.stringify(declaredField)}, which Forge cannot install.`,
      };
    const lockfile = lockfileOf(name as ManagerName);
    return lockfile
      ? build(name as ManagerName, version ?? null, lockfile)
      : {
          reason: `package.json declares ${name} but the repository has no ${LOCKFILES[name as ManagerName][0]}.`,
        };
  }
  const present = NAMES.filter(name => lockfileOf(name));
  if (!present.length) return null;
  if (present.length > 1)
    return {
      reason: `More than one lockfile (${present.map(name => lockfileOf(name)).join(', ')}) and no packageManager field to choose the manager.`,
    };
  const only = present[0]!;
  return build(only, null, lockfileOf(only)!);
}

/** pnpm: the `importers:` keys of pnpm-lock.yaml. pnpm 11+ writes a leading environment document
 * with its own `importers:`, so every block is read and merged. */
function pnpmFolders(lock: string): string[] {
  const lines = lock.split(/\r?\n/),
    found: string[] = [];
  lines.forEach((line, start) => {
    if (line !== 'importers:') return;
    for (const entry of lines.slice(start + 1)) {
      if (entry && !/^\s/.test(entry)) break;
      const key = /^ {2}(\S.*?):(?:\s*\{\})?\s*$/.exec(entry);
      if (key) found.push(unquote(key[1] ?? ''));
    }
  });
  return found;
}
/** bun.lock: the keys of its `workspaces` object (one per line at four spaces of indent). */
function bunFolders(lock: string): string[] {
  const lines = lock.split(/\r?\n/),
    start = lines.findIndex(line => /^ {2}"workspaces":\s*\{/.test(line));
  const found: string[] = [];
  if (start === -1) return found;
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\}/.test(line)) break;
    const key = /^ {4}"([^"]*)":\s*\{/.exec(line);
    if (key) found.push(key[1] ?? '');
  }
  return found;
}
/** Yarn Berry: `name@workspace:folder` descriptors in yarn.lock keys that name a real folder. */
function yarnFolders(root: string, lock: string): string[] {
  const found = new Set<string>();
  for (const line of lock.split(/\r?\n/))
    if (line && !line.startsWith(' ') && line.endsWith(':'))
      for (const match of line.matchAll(/@workspace:([^,"'\s]+)/g))
        if (existsSync(join(root, match[1]!, 'package.json'))) found.add(match[1]!);
  return [...found];
}
/** `workspaces` of package.json with literal folders and `dir/*` expanded: the only
 * layout source for Yarn classic and bun.lockb. A pattern it cannot expand is a reason. */
function manifestFolders(root: string): string[] | { reason: string } {
  let workspaces: unknown;
  try {
    workspaces = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces?: unknown })
      .workspaces;
  } catch {
    return [];
  }
  const patterns = Array.isArray(workspaces)
    ? workspaces
    : ((workspaces as { packages?: unknown } | undefined)?.packages ?? []);
  const found: string[] = [];
  for (const pattern of Array.isArray(patterns) ? patterns : []) {
    if (typeof pattern !== 'string') continue;
    const clean = pattern.replace(/^\.\//, '').replace(/\/$/, '');
    if (/^[^*?[\]{}!]+$/.test(clean)) found.push(clean);
    else if (/^[^*?[\]{}!]+\/\*$/.test(clean)) {
      const parent = clean.slice(0, -2);
      try {
        for (const entry of readdirSync(join(root, parent)).sort())
          if (existsSync(join(root, parent, entry, 'package.json'))) found.push(`${parent}/${entry}`);
      } catch {
        /* A missing parent holds no workspaces. */
      }
    } else
      return {
        reason: `Workspace pattern ${JSON.stringify(pattern)} is not supported for shared dependencies.`,
      };
  }
  return found;
}

/** Workspace folders (not the root) an install stage must hold a package.json for. A reason when
 * the layout cannot be read or names a folder the stage could not copy faithfully. */
export function managerWorkspaceFolders(root: string, pm: PackageManager): string[] | { reason: string } {
  const lock = pm.lockfile.endsWith('.lockb') ? undefined : text(join(root, pm.lockfile));
  let folders: string[] | { reason: string };
  if (pm.name === 'pnpm') folders = pnpmFolders(lock ?? '');
  else if (pm.name === 'bun' && lock !== undefined) folders = bunFolders(lock);
  else if (pm.berry && lock !== undefined) folders = yarnFolders(root, lock);
  else folders = manifestFolders(root);
  if (!Array.isArray(folders)) return folders;
  folders = [...new Set(folders.filter(folder => folder && folder !== '.'))].sort();
  const bad = folders.find(folder => isAbsolute(folder) || folder.split('/').includes('..'));
  if (bad) return { reason: `${pm.lockfile} names a workspace folder outside the repository.` };
  const missing = folders.find(folder => !existsSync(join(root, folder, 'package.json')));
  return missing ? { reason: `Workspace ${missing} has no package.json; the install would fail.` } : folders;
}

const CONFIG_FILES = ['.npmrc', 'pnpm-workspace.yaml', '.yarnrc.yml', '.yarnrc', 'bunfig.toml'];
const CONFIG_DIRECTORIES = ['patches', '.yarn/patches'];
/** Files besides manifests and the lockfile an install reads: manager settings and patch files.
 * They shape what gets installed, so they enter the key and the stage. */
export function installConfigFiles(root: string): string[] {
  const found = CONFIG_FILES.filter(file => existsSync(join(root, file)));
  for (const directory of CONFIG_DIRECTORIES)
    if (isDirectory(join(root, directory)))
      try {
        for (const entry of readdirSync(join(root, directory), { recursive: true, withFileTypes: true }))
          if (entry.isFile()) found.push(relative(root, join(entry.parentPath, entry.name)));
      } catch {
        /* An unreadable patch directory fails the install, which reports it. */
      }
  return found.sort();
}

/** Why a repository cannot be installed once and shared: its install runs repository code, or
 * its layout has no node_modules to link. Null when neither applies. */
export function unsharableReason(root: string, pm: PackageManager): string | null {
  if (pm.name === 'pnpm') {
    const settings = [text(join(root, 'pnpm-workspace.yaml')), text(join(root, '.npmrc'))].join('\n');
    if (existsSync(join(root, '.pnpmfile.cjs')) || /^pnpmfile\b/m.test(settings))
      return 'pnpm runs the repository .pnpmfile.cjs at install; Forge does not run repository code to share dependencies.';
  }
  if (pm.berry) {
    const rc = text(join(root, '.yarnrc.yml')) ?? '';
    if (/^plugins:/m.test(rc))
      return 'Yarn plugins in .yarnrc.yml run repository code at install; Forge does not share those dependencies.';
    const linker = /^nodeLinker:\s*(\S+)/m.exec(rc)?.[1];
    if (!linker || !['node-modules', 'pnpm'].includes(unquote(linker)))
      return "Yarn Plug'n'Play has no node_modules to share; set nodeLinker: node-modules in .yarnrc.yml to share dependencies.";
  }
  return null;
}
