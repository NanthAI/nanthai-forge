// SPDX-License-Identifier: Apache-2.0
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
export const dotnetManifest = (path: string) => DOTNET.test(path) && !/(?:^|\/)(?:bin|obj)\//.test(path);
const TEST_PACKAGES =
  /Include\s*=\s*["'](?:Microsoft\.NET\.Test\.Sdk|xunit(?:\.v3)?|NUnit|MSTest(?:\.TestFramework|\.Sdk)?|TUnit)["']/i;

/** .NET: every project file is a package; edges are `<ProjectReference Include="…">` paths. Test
 * projects (Microsoft.NET.Test.Sdk, xunit, NUnit, MSTest, TUnit, `<IsTestProject>true`, or named
 * `*Tests`/`*Test`) run as `dotnet test PROJECT`; other projects have nothing to run themselves. */
export function dotnetGraph(paths: string[], read: ManifestReader): EcosystemResult {
  const manifests = paths.filter(dotnetManifest);
  if (!manifests.length) return null;
  const projects = new Map<string, { pkg: GraphPackage; references: string[] }>();
  for (const manifest of manifests) {
    const text = read(manifest)?.replace(/<!--[\s\S]*?-->/g, '');
    if (text === undefined) return { ecosystem: 'dotnet', refusal: `${manifest} is unreadable` };
    const references: string[] = [];
    for (const match of text.matchAll(/<ProjectReference\b[^>]*\bInclude\s*=\s*["']([^"']+)["']/g)) {
      if (match[1]!.includes('$('))
        return { ecosystem: 'dotnet', refusal: `${manifest} references a computed project path` };
      const target = joinPath(dirname(manifest), match[1]!);
      if (target === null)
        return { ecosystem: 'dotnet', refusal: `${manifest} references a project outside the repository` };
      references.push(target);
    }
    const name = basename(manifest).replace(DOTNET, '');
    const testable =
      TEST_PACKAGES.test(text) ||
      /<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(text) ||
      /[.]?Tests?$/.test(name);
    projects.set(manifest, {
      pkg: {
        ecosystem: 'dotnet',
        dir: dirname(manifest),
        name,
        manifest,
        dependsOn: [],
        testable,
        declared: false,
      },
      references,
    });
  }
  for (const project of projects.values())
    project.pkg.dependsOn = [
      ...new Set(
        project.references.flatMap(target =>
          projects.get(target) ? [packageKey(projects.get(target)!.pkg)] : [],
        ),
      ),
    ].sort();
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

const LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];
/** The package manager of one folder, from its package.json `packageManager` or its lockfile. */
function managerOf(manifest: Record<string, unknown>, dir: string, present: Set<string>) {
  const at = (file: string) => present.has(dir ? `${dir}/${file}` : file);
  const declared = typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : '';
  return (
    declared ||
    (at('pnpm-lock.yaml') || at('pnpm-workspace.yaml')
      ? 'pnpm'
      : at('yarn.lock')
        ? 'yarn'
        : at('bun.lock') || at('bun.lockb')
          ? 'bun'
          : 'npm')
  );
}

/** JS/TS packages: the root package.json `workspaces` (or pnpm-workspace.yaml `packages`) list the
 * workspace packages; any other package.json with its own lockfile (`web/`, `server/`, the root of a
 * repository without workspaces) is a standalone package. Edges are dependencies (any kind) named
 * like an in-repository package, or `file:`/`link:` paths to one. A package with a `test` script runs
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
        const local =
          typeof spec === 'string' && /^(?:file|link|portal):/.test(spec)
            ? joinPath(item.pkg.dir, spec.replace(/^\w+:/, ''))
            : null;
        const target = (local !== null && packages.get(local)?.pkg) || byName.get(name);
        if (target && target !== item.pkg) edges.add(packageKey(target));
      }
    }
    item.pkg.dependsOn = [...edges].sort();
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
