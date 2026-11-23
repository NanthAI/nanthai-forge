// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ecosystemEntry, JS_PACKAGE_MANIFEST, pinLockfiles } from './ecosystems.js';
import { checkEntryMatcher, ciConfigurationPath } from './first-check-risk.js';
import { JS_TEST, jsWorkspaceMembership, pnpmGlobs } from './package-graph-dotnet-js.js';
import type { PackageGraph } from './package-graph.js';
import { basename, dirname, joinPath, type ManifestReader } from './package-graph-types.js';
import { safeRelative } from './safe-relative.js';

const lockfiles = pinLockfiles([ecosystemEntry('js')]);
const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const installTree = (path: string) => path.split('/').includes('node_modules');

type Manifest = {
  dir: string;
  name?: string | undefined;
  dependencies: [string, string][];
  bundles: boolean;
  scripts: string[];
  ownTests: boolean;
  member: (dir: string) => boolean;
};

function manifest(path: string, read: ManifestReader) {
  const value: unknown = JSON.parse(read(path) ?? '');
  if (!record(value)) throw new Error('package manifest must be an object');
  return value;
}

/** Certify only workspace syntax we can prove the existing matcher reads completely. */
function workspaceGlobs(value: unknown): string[] {
  const items = record(value) ? value.packages : value;
  if (value === undefined) return [];
  if (
    !Array.isArray(items) ||
    items.some(
      item =>
        typeof item !== 'string' ||
        !item ||
        /[\[\]\\]|[?*!+@]\(/.test(item) ||
        /\{[^}]*\{|\{[^{}]*\.\.[^{}]*\}/.test(item) ||
        item.startsWith('!!') ||
        item
          .replace(/^!?\.\//, '')
          .replace(/^!/, '')
          .replace(/\/$/, '')
          .split('/')
          .some(segment => !segment || segment === '.' || segment === '..'),
    )
  )
    throw new Error('workspace patterns are unreadable');
  // Managers disagree on exclusion ordering. A positive match cannot prove nonmembership.
  return (items as string[]).filter(item => !item.startsWith('!'));
}

function pnpmMembership(text: string | undefined) {
  const lines = text?.split(/\r?\n/) ?? [];
  const headers = lines.flatMap((line, i) => (/^packages\s*:/.test(line) ? [i] : []));
  const start = headers[0];
  if (start === undefined || headers.length !== 1) throw new Error('pnpm workspace packages are unreadable');
  if (/^packages\s*:\s*\[\s*\]\s*(?:#.*)?$/.test(lines[start]!)) return jsWorkspaceMembership([]);
  if (!/^packages\s*:\s*(?:#.*)?$/.test(lines[start]!))
    throw new Error('pnpm workspace packages are unreadable');
  let end = start + 1;
  while (end < lines.length && !/^[\w-]+\s*:/.test(lines[end]!)) {
    const line = lines[end++]!;
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    if (!/^\s+-\s+(?:'[^']+'|"[^"]+"|[\w./][^\s#]*)(?:\s+#.*)?\s*$/.test(line))
      throw new Error('pnpm workspace packages are unreadable');
  }
  const globs = pnpmGlobs(
    lines
      .slice(start, end)
      .map(line => line.trimEnd())
      .join('\n'),
  );
  if (!globs.length) throw new Error('pnpm workspace packages are unreadable');
  return jsWorkspaceMembership(workspaceGlobs(globs));
}

function manifests(paths: readonly string[], read: ManifestReader): Map<string, Manifest> {
  const result = new Map<string, Manifest>();
  for (const path of paths) {
    if (basename(path) !== JS_PACKAGE_MANIFEST || installTree(path)) continue;
    const value = manifest(path, read);
    const dir = dirname(path);
    const dependencies: Manifest['dependencies'] = [];
    for (const field of dependencyFields) {
      const entries = value[field];
      if (entries === undefined) continue;
      if (!record(entries)) throw new Error('package dependencies must be an object');
      for (const [name, spec] of Object.entries(entries)) {
        if (typeof spec !== 'string') throw new Error('package dependency specifier must be a string');
        dependencies.push([name, spec]);
      }
    }
    const declared = value.scripts;
    const scripts = record(declared) ? Object.values(declared) : [];
    if ((declared !== undefined && !record(declared)) || scripts.some(line => typeof line !== 'string'))
      throw new Error('package scripts are unreadable');
    const test = record(declared) ? declared.test : undefined;
    const bundles = value.bundleDependencies ?? value.bundledDependencies;
    result.set(dir, {
      dir,
      name: typeof value.name === 'string' ? value.name : undefined,
      dependencies,
      bundles: Array.isArray(bundles) ? bundles.length > 0 : Boolean(bundles),
      scripts: scripts as string[],
      ownTests:
        typeof test === 'string' &&
        !!test.trim() &&
        test.trim() !== 'echo "Error: no test specified" && exit 1',
      member: jsWorkspaceMembership(workspaceGlobs(value.workspaces)),
    });
  }
  return result;
}

/** Outermost nonmembers on the original inventory. No placement-only package is sent to selection. */
export function standaloneJsFolders(
  paths: readonly string[],
  read: ManifestReader,
  graph: Extract<PackageGraph, { status: 'available' }>,
  checkEntries: readonly string[],
  commandLines: readonly string[],
  regularFile: (path: string) => boolean,
): string[] {
  if (graph.packages.some(pkg => pkg.unresolved)) return [];
  if (
    graph.crossEcosystem !== 'declared' &&
    graph.packages.some(pkg => pkg.ecosystem !== 'js' && (pkg.testable || pkg.hiddenTests))
  )
    return [];

  const packages = manifests(paths, read);
  const pnpm = new Map<string, Manifest['member']>();
  for (const path of paths)
    if (basename(path) === 'pnpm-workspace.yaml' && !installTree(path))
      pnpm.set(dirname(path), pnpmMembership(read(path)));

  const nonmembers = new Set<string>();
  const claimed = new Set<string>();
  for (const dir of packages.keys()) {
    if (!dir) continue;
    let workspace = false;
    for (let parent = dirname(dir); ; parent = dirname(parent)) {
      const child = parent ? dir.slice(parent.length + 1) : dir;
      if (packages.get(parent)?.member(child) || pnpm.get(parent)?.(child)) {
        workspace = true;
        claimed.add(dir);
      }
      if (!parent) break;
    }
    if (!workspace) nonmembers.add(dir);
  }
  const folders = new Set<string>();
  for (const dir of nonmembers) {
    let outer = true;
    for (let parent = dirname(dir); parent; parent = dirname(parent))
      if (nonmembers.has(parent)) {
        outer = false;
        break;
      }
    if (outer && safeRelative(dir)) folders.add(dir);
  }
  if (!folders.size) return [];
  const owner = (path: string) => {
    if (installTree(path)) return undefined;
    for (let parent = path; parent; parent = dirname(parent)) if (folders.has(parent)) return parent;
  };
  const reject = (path: string) => {
    const dir = owner(path);
    if (dir) folders.delete(dir);
  };
  for (const dir of claimed) reject(dir);
  for (const pkg of graph.packages) {
    reject(pkg.dir);
    for (const dir of pkg.claims ?? []) reject(dir);
  }
  // Every path dependency must stay on its own side of the prospective boundary. This also
  // checks name-based dependencies on packages missing from the ordinary graph.
  const installedNames = new Map<string, Set<string>>();
  for (const pkg of packages.values()) {
    if (pkg.name === undefined) continue;
    if (!installedNames.has(pkg.name)) installedNames.set(pkg.name, new Set());
    installedNames.get(pkg.name)!.add(pkg.dir);
  }
  const present = new Set(paths);
  const locked = new Set(
    [...folders].filter(dir =>
      lockfiles.some(name => {
        const path = dir + '/' + name;
        return present.has(path) && regularFile(path);
      }),
    ),
  );
  const cross = (from: string | undefined, to: string | undefined) => {
    if (from === to) return;
    if (from) folders.delete(from);
    if (to) folders.delete(to);
  };
  for (const pkg of packages.values()) {
    const from = owner(pkg.dir);
    if (from && !locked.has(from) && (pkg.dependencies.length || pkg.bundles)) folders.delete(from);
    for (const [name, spec] of pkg.dependencies) {
      const local = /^(?:file|link|portal):(.*)$/.exec(spec)?.[1] ?? /^workspace:([./].*)$/.exec(spec)?.[1];
      if (local !== undefined) {
        if (/^(?:[/\\]|[A-Za-z]:)/.test(local)) return [];
        const destination = joinPath(pkg.dir, local);
        cross(from, destination === null ? undefined : owner(destination));
      } else {
        const alias = /^(?:workspace|npm):((?:@[^/@]+\/)?[^/@]+)@/.exec(spec)?.[1];
        const targets = installedNames.get(alias ?? name);
        for (const dir of targets ?? []) cross(from, owner(dir));
        if (from && spec.startsWith('workspace:') && !targets?.size) folders.delete(from);
      }
    }
  }
  for (const path of paths) {
    if (!JS_TEST.test(path)) continue;
    const dir = owner(path);
    if (dir && !packages.get(dir)!.ownTests) folders.delete(dir);
  }
  if (!folders.size) return [];
  const entries = checkEntries.map(checkEntryMatcher);
  const checkText = [...commandLines, ...checkEntries];
  for (const path of paths)
    if (entries.some(matches => matches(path)) || ciConfigurationPath(path)) {
      const text = read(path);
      if (text === undefined) return [];
      checkText.push(path, text);
    }
  for (const dir of folders)
    for (let parent = dir; parent; parent = dirname(parent)) {
      const enclosing = packages.get(dirname(parent));
      if (
        checkText.some(line => line.includes(parent)) ||
        enclosing?.scripts.some(line => line.includes(parent) || line.includes(basename(parent)))
      ) {
        folders.delete(dir);
        break;
      }
    }
  return [...folders].sort();
}
