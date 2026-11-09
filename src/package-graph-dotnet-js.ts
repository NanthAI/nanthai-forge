// SPDX-License-Identifier: Apache-2.0
import { ecosystemEntry, pinLockfiles } from './ecosystems.js';
import { globRegExp } from './path-glob.js';
import {
  basename,
  dirname,
  joinPath,
  packageKey,
  type EcosystemResult,
  type GraphPackage,
  type ManifestReader,
  type PackageCommand,
} from './package-graph-types.js';

const DOTNET = /\.(?:cs|fs|vb)proj$/;
const BUILD_OUTPUT = /(?:^|\/)(?:bin|obj)\//;
export const dotnetManifest = (path: string) => DOTNET.test(path) && !BUILD_OUTPUT.test(path);
/** MSBuild files a project can import (Directory.Build.props, shared .props/.targets): read for the
 * project references they add. */
export const dotnetImport = (path: string) => /\.(?:props|targets)$/i.test(path) && !BUILD_OUTPUT.test(path);
const TEST_PACKAGES =
  /Include\s*=\s*["'](?:Microsoft\.NET\.Test\.Sdk|xunit(?:\.v3)?|NUnit|MSTest(?:\.TestFramework|\.Sdk)?|TUnit)["']/i;
/** Imports rooted in the SDK or tool folders: outside the repository, nothing to read. */
const SDK_IMPORT =
  /^\$\((?:MSBuild(?:Extensions|Tools|Bin|SDKs|FrameworkTools|UserExtensions)Path\w*|VSToolsPath|NuGetPackageRoot)\)/i;
/** Walks up to a Directory.Build file, which Forge reads for every enclosing folder anyway. */
const FILE_ABOVE = /GetPathOfFileAbove|GetDirectoryNameOfFileAbove/;

type Scan = { references: string[]; unresolved?: string } | { refusal: string };

/** .NET: every project file is a package; edges are `<ProjectReference Include="…">` paths in the
 * project, in every Directory.Build.props/.targets of an enclosing folder and in the in-repository
 * files they `<Import>`. MSBuild paths are case-insensitive, and a wildcard reference names every
 * project it matches. A reference or import Forge cannot place marks the project unresolved (every
 * change selects it). Test projects (Microsoft.NET.Test.Sdk, xunit, NUnit, MSTest, TUnit,
 * `<IsTestProject>true`, or named `*Tests`/`*Test`) run as `dotnet test PROJECT`; other projects have
 * nothing to run themselves. */
export function dotnetGraph(paths: string[], read: ManifestReader): EcosystemResult {
  const manifests = paths.filter(dotnetManifest);
  if (!manifests.length) return null;
  const folded = new Map<string, string[]>();
  for (const path of paths.filter(path => dotnetManifest(path) || dotnetImport(path)))
    folded.set(path.toLowerCase(), [...(folded.get(path.toLowerCase()) ?? []), path]);
  /** Repository files a (possibly wildcard) MSBuild path names, case-insensitively. */
  const resolve = (target: string, kind: (path: string) => boolean) => {
    if (!/[*?]/.test(target)) return (folded.get(target.toLowerCase()) ?? []).filter(kind);
    const glob = globRegExp(target.toLowerCase());
    return [...folded].flatMap(([lower, found]) => (glob.test(lower) ? found.filter(kind) : []));
  };
  const imports = paths.filter(path => /^directory\.build\.(?:props|targets)$/i.test(basename(path)));
  const texts = new Map<string, string | undefined>();
  const text = (path: string) => {
    if (!texts.has(path)) texts.set(path, read(path)?.replace(/<!--[\s\S]*?-->/g, ''));
    return texts.get(path);
  };
  /** MSBuild's own location properties expanded; undefined: computed some other way; null: outside
   * the repository. */
  const expand = (value: string, fileDir: string, projectDir: string) => {
    const known = /^\$\((MSBuildThisFileDirectory|MSBuildProjectDirectory)\)[\\/]?/i.exec(value);
    const base = !known ? projectDir : /ThisFile/i.test(known[1]!) ? fileDir : projectDir;
    const rest = known ? value.slice(known[0].length) : value;
    return rest.includes('$(') ? undefined : joinPath(base, rest);
  };
  const scan = (file: string, project: string, seen: Set<string>): Scan => {
    const body = text(file);
    if (body === undefined) return { refusal: `${file} is unreadable` };
    const projectDir = dirname(project);
    const references: string[] = [];
    let unresolved: string | undefined;
    for (const match of body.matchAll(/<ProjectReference\b[^>]*\bInclude\s*=\s*["']([^"']+)["']/g)) {
      for (const include of match[1]!
        .split(';')
        .map(item => item.trim())
        .filter(Boolean)) {
        const target = expand(include, dirname(file), projectDir);
        if (target === undefined) return { refusal: `${file} references a computed project path` };
        if (target === null) return { refusal: `${file} references a project outside the repository` };
        const found = resolve(target, dotnetManifest);
        if (found.length) references.push(...found);
        else unresolved ??= `${file} references ${target}, which is no project Forge read`;
      }
    }
    for (const match of body.matchAll(/<Import\b[^>]*\bProject\s*=\s*["']([^"']+)["']/g)) {
      const value = match[1]!.trim();
      if (SDK_IMPORT.test(value) || FILE_ABOVE.test(value)) continue;
      const target = expand(value, dirname(file), dirname(file));
      if (target === undefined) {
        unresolved ??= `${file} imports a computed path (${value.slice(0, 80)})`;
        continue;
      }
      if (target === null) continue;
      // A file not in the repository holds no repository reference (a missing optional import).
      for (const found of resolve(target, dotnetImport)) {
        if (seen.has(found)) continue;
        seen.add(found);
        const inner = scan(found, project, seen);
        if ('refusal' in inner) return inner;
        references.push(...inner.references);
        unresolved ??= inner.unresolved;
      }
    }
    return { references, ...(unresolved ? { unresolved } : {}) };
  };
  const projects = new Map<string, { pkg: GraphPackage; references: string[] }>();
  for (const manifest of manifests) {
    const own = text(manifest);
    if (own === undefined) return { ecosystem: 'dotnet', refusal: `${manifest} is unreadable` };
    // Every Directory.Build file of an enclosing folder (MSBuild reads the nearest; over-select).
    const enclosing = imports.filter(path => !dirname(path) || manifest.startsWith(`${dirname(path)}/`));
    const seen = new Set([manifest, ...enclosing]);
    const scans = [manifest, ...enclosing].map(file => scan(file, manifest, seen));
    const refused = scans.find(item => 'refusal' in item);
    if (refused && 'refusal' in refused) return { ecosystem: 'dotnet', refusal: refused.refusal };
    const found = scans as Extract<Scan, { references: string[] }>[];
    const name = basename(manifest).replace(DOTNET, '');
    const testable =
      TEST_PACKAGES.test(own) ||
      /<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(own) ||
      /[.]?Tests?$/.test(name);
    const unresolved = found.find(item => item.unresolved)?.unresolved;
    projects.set(manifest, {
      pkg: {
        ecosystem: 'dotnet',
        dir: dirname(manifest),
        name,
        manifest,
        dependsOn: [],
        testable,
        declared: false,
        ...(unresolved ? { unresolved } : {}),
      },
      references: found.flatMap(item => item.references),
    });
  }
  for (const project of projects.values())
    project.pkg.dependsOn = [
      ...new Set(
        project.references.flatMap(target =>
          projects.get(target) ? [packageKey(projects.get(target)!.pkg)] : [],
        ),
      ),
    ]
      .filter(key => key !== packageKey(project.pkg))
      .sort();
  return {
    ecosystem: 'dotnet',
    packages: [...projects.values()].map(project => project.pkg),
    commands: selected =>
      selected
        .map(pkg => pkg.manifest)
        .sort()
        .map(manifest => ({
          ecosystem: 'dotnet' as const,
          cwd: '',
          argv: ['dotnet', 'test', manifest],
          packages: [packageKey(projects.get(manifest)!.pkg)],
        })),
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const NO_TEST = /^echo "Error: no test specified" && exit 1$/;
/** A JS/TS test file by the names test runners pick up by default. */
const JS_TEST = /(?:(?:^|\/)(?:__tests__|__specs?__|tests?|specs?)\/.*|\.(?:test|spec)s?)\.[cm]?[jt]sx?$/;

/** The workspace globs of pnpm-workspace.yaml's `packages:` list (a plain YAML sequence). */
function pnpmGlobs(text: string) {
  const globs: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^packages\s*:/.test(line)) inside = true;
    else if (inside && /^\s+-\s*/.test(line))
      globs.push(
        line
          .replace(/^\s+-\s*/, '')
          .replace(/\s+#.*$/, '')
          .replace(/^(['"])(.*)\1$/, '$2'),
      );
    else if (inside && /^\S/.test(line)) inside = false;
  }
  return globs;
}

/** The JS ecosystem's lockfiles and managers (src/ecosystems.ts); npm is the default manager. */
const JS = ecosystemEntry('js');
const LOCKFILES = pinLockfiles([JS]);
const [DEFAULT_MANAGER, ...OTHER_MANAGERS] = JS.managers!;
/** The package manager of one folder, from its package.json `packageManager` or its lockfile (or,
 * for pnpm, its workspace file). */
function managerOf(manifest: Record<string, unknown>, dir: string, present: Set<string>) {
  const at = (file: string) => present.has(dir ? `${dir}/${file}` : file);
  const declared = typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : '';
  return (
    declared ||
    (
      OTHER_MANAGERS.find(manager => [...(manager.lockfiles ?? []), ...(manager.manifests ?? [])].some(at)) ??
      DEFAULT_MANAGER!
    ).name
  );
}

/** JS/TS packages: the root package.json `workspaces` (or pnpm-workspace.yaml `packages`) list the
 * workspace packages; any other package.json with its own lockfile (`web/`, `server/`, the root of a
 * repository without workspaces) is a standalone package. Edges are dependencies (any kind) named
 * like an in-repository package, or `file:`/`link:` paths to one; a path or `workspace:` dependency
 * that names no package Forge read marks the package unresolved. A package with a `test` script runs
 * it through its package manager: `pnpm --filter ./DIR run test`, `npm run test --workspace=DIR`,
 * `yarn workspace NAME run test` for workspace packages, `npm run test` in its own folder otherwise. */
export function jsWorkspaceGraph(paths: string[], read: ManifestReader): EcosystemResult {
  const present = new Set(paths);
  const manifests = paths.filter(
    path => basename(path) === 'package.json' && !/(?:^|\/)node_modules\//.test(path),
  );
  if (!manifests.length) return null;
  const parse = (path: string): Record<string, unknown> | string => {
    try {
      const parsed: unknown = JSON.parse(read(path) ?? '');
      return record(parsed) ? parsed : {};
    } catch {
      return `${path} is not JSON`;
    }
  };
  let root: Record<string, unknown> = {};
  if (present.has('package.json')) {
    const parsed = parse('package.json');
    if (typeof parsed === 'string') return { ecosystem: 'js', refusal: parsed };
    root = parsed;
  }
  const declared = record(root.workspaces) ? strings(root.workspaces.packages) : strings(root.workspaces);
  const globs = present.has('pnpm-workspace.yaml') ? pnpmGlobs(read('pnpm-workspace.yaml') ?? '') : declared;
  const include = globs
    .filter(glob => !glob.startsWith('!'))
    .map(glob => globRegExp(glob.replace(/^\.\//, '').replace(/\/$/, '')));
  const exclude = globs
    .filter(glob => glob.startsWith('!'))
    .map(glob => globRegExp(glob.slice(1).replace(/^\.\//, '').replace(/\/$/, '')));
  const member = (dir: string) =>
    !!dir && include.some(glob => glob.test(dir)) && !exclude.some(glob => glob.test(dir));
  const ownLock = (dir: string) => LOCKFILES.some(file => present.has(dir ? `${dir}/${file}` : file));
  const packages = new Map<string, { pkg: GraphPackage; manifest: Record<string, unknown>; tool?: string }>();
  for (const path of manifests) {
    const dir = dirname(path);
    const workspace = member(dir);
    // The workspace root is not a package of its own workspace; outside it, a lockfile makes one.
    if (!workspace && ((globs.length && !dir) || !ownLock(dir))) continue;
    const manifest = path === 'package.json' ? root : parse(path);
    if (typeof manifest === 'string') return { ecosystem: 'js', refusal: manifest };
    const scripts = record(manifest.scripts) ? manifest.scripts : {};
    const test = typeof scripts.test === 'string' && !NO_TEST.test(scripts.test.trim());
    packages.set(dir, {
      pkg: {
        ecosystem: 'js',
        dir,
        name: typeof manifest.name === 'string' ? manifest.name : dir || 'package.json',
        manifest: path,
        dependsOn: [],
        testable: test,
        declared: workspace,
      },
      manifest,
      ...(workspace ? {} : { tool: managerOf(manifest, dir, present) }),
    });
  }
  if (!packages.size)
    return {
      ecosystem: 'js',
      unplaced: globs.length
        ? `package.json workspaces (${globs.slice(0, 3).join(', ')}) match no package.json`
        : `${manifests.slice(0, 3).join(', ')}${manifests.length > 3 ? ', …' : ''}: no workspaces, and no package.json has its own lockfile (${LOCKFILES.slice(0, 4).join(', ')}, …)`,
    };
  const byName = new Map([...packages.values()].map(item => [item.pkg.name, item.pkg]));
  for (const item of packages.values()) {
    const edges = new Set<string>();
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = record(item.manifest[field]) ? item.manifest[field] : {};
      for (const [name, spec] of Object.entries(deps)) {
        const path =
          typeof spec === 'string'
            ? (/^(?:file|link|portal):(.*)$/.exec(spec)?.[1] ?? /^workspace:([./].*)$/.exec(spec)?.[1])
            : undefined;
        const local = path === undefined ? null : joinPath(item.pkg.dir, path);
        const target = (local !== null && packages.get(local)?.pkg) || byName.get(name);
        if (target && target !== item.pkg) edges.add(packageKey(target));
        // A path inside the repository, or a workspace dependency, that no package Forge read owns.
        else if (!target && ((path !== undefined && local !== null) || String(spec).startsWith('workspace:')))
          item.pkg.unresolved ??= `${item.pkg.manifest} depends on ${name} (${String(spec).slice(0, 60)}), which is no package Forge read`;
      }
    }
    item.pkg.dependsOn = [...edges].sort();
  }
  // A package without a test script whose folder holds test files: something else runs them.
  for (const path of paths) {
    if (!JS_TEST.test(path) || /(?:^|\/)node_modules\//.test(path)) continue;
    let dir = dirname(path);
    while (dir && !packages.has(dir)) dir = dirname(dir);
    const owner = packages.get(dir)?.pkg;
    if (owner && !owner.testable) owner.hiddenTests ??= path;
  }
  const tool = managerOf(root, '', present);
  const workspaceCommands = (selected: GraphPackage[]): PackageCommand[] | { refusal: string } => {
    if (!selected.length) return [];
    const keys = selected.map(packageKey);
    const dirs = selected.map(pkg => pkg.dir).sort();
    if (tool === 'pnpm')
      return [
        {
          ecosystem: 'js',
          cwd: '',
          argv: ['pnpm', ...dirs.flatMap(dir => ['--filter', `./${dir}`]), 'run', 'test'],
          packages: keys,
        },
      ];
    if (tool === 'npm')
      return [
        {
          ecosystem: 'js',
          cwd: '',
          argv: ['npm', 'run', 'test', ...dirs.map(dir => `--workspace=${dir}`)],
          packages: keys,
        },
      ];
    if (tool === 'yarn')
      return selected
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(pkg => ({
          ecosystem: 'js' as const,
          cwd: '',
          argv: ['yarn', 'workspace', pkg.name, 'run', 'test'],
          packages: [packageKey(pkg)],
        }));
    return { refusal: `no unambiguous per-package test command for ${tool} workspaces` };
  };
  return {
    ecosystem: 'js',
    packages: [...packages.values()].map(item => item.pkg),
    commands(selected): PackageCommand[] | { refusal: string } {
      const workspace = workspaceCommands(selected.filter(pkg => pkg.declared));
      if ('refusal' in workspace) return workspace;
      const standalone = selected
        .filter(pkg => !pkg.declared)
        .sort((a, b) => a.dir.localeCompare(b.dir))
        .map(pkg => ({
          ecosystem: 'js' as const,
          cwd: pkg.dir,
          argv: [packages.get(pkg.dir)!.tool!, 'run', 'test'],
          packages: [packageKey(pkg)],
        }));
      return [...workspace, ...standalone];
    },
  };
}
