// SPDX-License-Identifier: Apache-2.0
import {
  basename,
  dirname,
  joinPath,
  packageKey,
  type EcosystemResult,
  type GraphPackage,
  type ManifestReader,
} from './package-graph-types.js';
import { nonSourceDirPattern } from './ecosystems.js';

/** Build output, other people's packages and dot folders (`.dart_tool/`) hold no repository package. */
const OUTSIDE = nonSourceDirPattern();
const SECTIONS = ['dependencies', 'dev_dependencies', 'dependency_overrides'];
const unquote = (value: string) => value.trim().replace(/^(["'])(.*)\1$/, '$2');

type Pubspec = {
  name?: string;
  /** Dependency name → its `path`, or null for a hosted, git or SDK dependency. */
  dependencies: Map<string, string | null>;
  flutter: boolean;
  workspace: string[];
  computed?: string;
};

/** The parts of a pubspec.yaml the graph needs, from its block layout (the form `dart pub` writes and
 * documents): top-level `name`, the dependency sections with each entry's `path` (block or `{path: …}`
 * flow form), an `sdk: flutter` dependency, and the `workspace` list. Anything else is ignored. */
export function readPubspec(text: string): Pubspec {
  const out: Pubspec = { dependencies: new Map(), flutter: false, workspace: [] };
  let section = '',
    entry = '',
    entryIndent = -1;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 0) {
      const [key, ...rest] = body.split(':');
      const value = unquote(rest.join(':'));
      section = key!.trim();
      entry = '';
      entryIndent = -1;
      if (section === 'name' && value) out.name = value;
      continue;
    }
    if (section === 'workspace') {
      const item = /^-\s*(.+)$/.exec(body)?.[1];
      if (item) out.workspace.push(unquote(item));
      continue;
    }
    if (!SECTIONS.includes(section)) continue;
    const pair = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(body);
    if (!pair) continue;
    if (entryIndent < 0 || indent <= entryIndent) {
      entry = pair[1]!;
      entryIndent = indent;
      const flow = /^\{(.*)\}$/.exec(pair[2]!.trim())?.[1];
      const path = flow ? /(?:^|,)\s*path\s*:\s*([^,]+)/.exec(flow)?.[1] : undefined;
      if (flow && /(?:^|,)\s*sdk\s*:\s*flutter\b/.test(flow)) out.flutter = true;
      out.dependencies.set(entry, path ? unquote(path) : null);
      continue;
    }
    if (pair[1] === 'path') out.dependencies.set(entry, unquote(pair[2]!));
    if (pair[1] === 'sdk' && unquote(pair[2]!) === 'flutter' && section !== 'dependency_overrides')
      out.flutter = true;
  }
  if ([...out.dependencies.values(), ...out.workspace].some(value => value?.includes('$')))
    out.computed = 'a path with a variable';
  return out;
}

/** Dart and Flutter (pub): every pubspec.yaml outside build output is a package. Edges come from
 * `path` dependencies (and overrides) and from dependencies named like an in-repository package (a
 * published copy is over-, never under-selected); a path with no pubspec.yaml Forge read marks the
 * package unresolved. A root `workspace:` lists its members (declared). A package with test files
 * under `test/` runs `flutter test` when it depends on the Flutter SDK, `dart test` otherwise, in its
 * own folder; `integration_test/` needs a device and runs under neither. pub runs no install
 * scripts; build hooks (`hook/build.dart`) are repository code that the check runs like any build. */
export function pubGraph(paths: string[], read: ManifestReader): EcosystemResult {
  const manifests = paths.filter(path => basename(path) === 'pubspec.yaml' && !OUTSIDE.test(path));
  if (!manifests.length) return null;
  const packages = new Map<string, { pkg: GraphPackage; spec: Pubspec }>();
  for (const manifest of manifests) {
    const text = read(manifest);
    if (text === undefined) return { ecosystem: 'pub', refusal: `${manifest} is unreadable` };
    const spec = readPubspec(text);
    const dir = dirname(manifest);
    if (spec.computed) return { ecosystem: 'pub', refusal: `${manifest} names ${spec.computed}` };
    packages.set(dir, {
      spec,
      pkg: {
        ecosystem: 'pub',
        dir,
        name: spec.name ?? (dir || 'pubspec.yaml'),
        manifest,
        dependsOn: [],
        testable: false,
        declared: false,
      },
    });
  }
  for (const { pkg, spec } of packages.values())
    for (const member of spec.workspace) {
      const there = packages.get(joinPath(pkg.dir, member) ?? '\0');
      if (there && there.pkg !== pkg) there.pkg.declared = true;
      else
        pkg.unresolved ??= `${pkg.manifest} lists the workspace member ${member}, which has no pubspec.yaml Forge read`;
    }
  const byName = new Map([...packages.values()].map(item => [item.pkg.name, item.pkg]));
  for (const { pkg, spec } of packages.values()) {
    const keys = new Set<string>();
    for (const [name, path] of spec.dependencies) {
      if (path !== null) {
        const dir = joinPath(pkg.dir, path);
        if (dir === null) continue;
        const there = packages.get(dir);
        if (there) keys.add(packageKey(there.pkg));
        else
          pkg.unresolved ??= `${pkg.manifest} takes ${name} from ${dir || '.'}, which has no pubspec.yaml Forge read`;
      } else if (byName.has(name)) keys.add(packageKey(byName.get(name)!));
    }
    keys.delete(packageKey(pkg));
    pkg.dependsOn = [...keys].sort();
  }
  const owner = (path: string) =>
    [...packages.values()]
      .map(item => item.pkg)
      .filter(pkg => !pkg.dir || path.startsWith(`${pkg.dir}/`))
      .sort((a, b) => b.dir.length - a.dir.length)[0];
  for (const path of paths) {
    const pkg = /_test\.dart$/.test(path) ? owner(path) : undefined;
    if (!pkg) continue;
    const below = path.slice(pkg.dir ? pkg.dir.length + 1 : 0);
    if (below.startsWith('test/')) pkg.testable = true;
  }
  return {
    ecosystem: 'pub',
    packages: [...packages.values()].map(item => item.pkg),
    commands: selected =>
      selected
        .map(pkg => ({
          ecosystem: 'pub' as const,
          cwd: pkg.dir,
          argv: [packages.get(pkg.dir)?.spec.flutter ? 'flutter' : 'dart', 'test'],
          packages: [packageKey(pkg)],
        }))
        .sort((a, b) => a.cwd.localeCompare(b.cwd)),
  };
}
