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

/** JS/TS workspaces: the root package.json `workspaces` (or pnpm-workspace.yaml `packages`) list the
 * packages. Edges are dependencies (any kind) named like a workspace package, or `file:`/`link:`
 * paths to one. A package with a `test` script runs it through the package manager:
 * `pnpm --filter ./DIR run test`, `npm run test --workspace=DIR`, `yarn workspace NAME run test`. */
export function jsWorkspaceGraph(paths: string[], read: ManifestReader): EcosystemResult {
  if (!paths.includes('package.json')) return null;
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(read('package.json') ?? '');
    root = record(parsed) ? parsed : {};
  } catch {
    return { ecosystem: 'js', refusal: 'package.json is not JSON' };
  }
  const declared = record(root.workspaces) ? strings(root.workspaces.packages) : strings(root.workspaces);
  const present = new Set(paths);
  const globs = present.has('pnpm-workspace.yaml') ? pnpmGlobs(read('pnpm-workspace.yaml') ?? '') : declared;
  if (!globs.length) return null;
  const include = globs
    .filter(glob => !glob.startsWith('!'))
    .map(glob => globRegExp(glob.replace(/^\.\//, '').replace(/\/$/, '')));
  const exclude = globs
    .filter(glob => glob.startsWith('!'))
    .map(glob => globRegExp(glob.slice(1).replace(/^\.\//, '').replace(/\/$/, '')));
  const packages = new Map<string, { pkg: GraphPackage; manifest: Record<string, unknown> }>();
  for (const path of paths) {
    if (basename(path) !== 'package.json' || path === 'package.json' || /(?:^|\/)node_modules\//.test(path))
      continue;
    const dir = dirname(path);
    if (!include.some(glob => glob.test(dir)) || exclude.some(glob => glob.test(dir))) continue;
    let manifest: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(read(path) ?? '');
      manifest = record(parsed) ? parsed : {};
    } catch {
      return { ecosystem: 'js', refusal: `${path} is not JSON` };
    }
    const scripts = record(manifest.scripts) ? manifest.scripts : {};
    const test = typeof scripts.test === 'string' && !NO_TEST.test(scripts.test.trim());
    packages.set(dir, {
      pkg: {
        ecosystem: 'js',
        dir,
        name: typeof manifest.name === 'string' ? manifest.name : dir,
        manifest: path,
        dependsOn: [],
        testable: test,
        declared: true,
      },
      manifest,
    });
  }
  if (!packages.size) return null;
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
  const manager = typeof root.packageManager === 'string' ? root.packageManager.split('@')[0] : '';
  const tool =
    manager ||
    (present.has('pnpm-lock.yaml') || present.has('pnpm-workspace.yaml')
      ? 'pnpm'
      : present.has('yarn.lock')
        ? 'yarn'
        : present.has('bun.lock') || present.has('bun.lockb')
          ? 'bun'
          : 'npm');
  return {
    ecosystem: 'js',
    packages: [...packages.values()].map(item => item.pkg),
    commands(selected): PackageCommand[] | { refusal: string } {
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
    },
  };
}
