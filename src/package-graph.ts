// SPDX-License-Identifier: Apache-2.0
import { digestChunks } from './portable-hash.js';
import { moduleEcosystem, moduleNarrowing } from './module-selection.js';
import type { ModuleGraph } from './module-graph-types.js';
import { cargoGraph, goGraph } from './package-graph-go-rust.js';
import { pythonGraph, pythonManifest } from './package-graph-python.js';
import { gradleGraph, jvmManifest, mavenGraph } from './package-graph-jvm.js';
import { dotnetGraph, dotnetManifest, jsWorkspaceGraph } from './package-graph-dotnet-js.js';
import {
  basename,
  packageKey,
  type EcosystemGraph,
  type GraphPackage,
  type ManifestReader,
  type PackageCommand,
} from './package-graph-types.js';
export type { Ecosystem, GraphPackage, PackageCommand } from './package-graph-types.js';

/** Manifest-level package graph for affected tests in any ecosystem (Go, Rust, Python, Gradle,
 * Maven, .NET, JS/TS workspaces). It reads manifests only, never runs repository code, and is a
 * selector, not an independence proof: a changed path maps to its owning package, which runs with
 * every package that depends on it. Anything it cannot place (a root file, an unreadable manifest,
 * no unambiguous test command) makes the selection full, with the reason. */

/** At most this many manifests are read for one head; more means an unknown (full) layout. */
export const PACKAGE_GRAPH_MAX_MANIFESTS = 2000;
/** Total manifest bytes read for one head. */
export const PACKAGE_GRAPH_MAX_BYTES = 16 * 1024 * 1024;

const HIDDEN = (path: string) =>
  path.split('/').some(part => part.startsWith('.') || part === 'node_modules');
/** Whether `path` is a manifest the graph reads (paths alone answer everything else). */
export function packageManifestPath(path: string) {
  if (HIDDEN(path)) return false;
  const name = basename(path);
  return (
    name === 'go.mod' ||
    name === 'Cargo.toml' ||
    name === 'package.json' ||
    name === 'pnpm-workspace.yaml' ||
    (pythonManifest(path) && name !== 'setup.py') ||
    jvmManifest(path) ||
    dotnetManifest(path)
  );
}
export const packageManifestPaths = (allPaths: Iterable<string>) =>
  [...allPaths].filter(packageManifestPath).sort();

export type PackageGraph =
  | { status: 'available'; ecosystems: EcosystemGraph[]; packages: GraphPackage[] }
  | { status: 'unknown'; reason: string };

const READERS = [goGraph, cargoGraph, pythonGraph, gradleGraph, mavenGraph, dotnetGraph, jsWorkspaceGraph];

/** The graph of one head: `allPaths` are its file paths, `read` returns a manifest's text. */
export function buildPackageGraph(allPaths: Iterable<string>, read: ManifestReader): PackageGraph {
  const paths = [...allPaths].filter(path => !HIDDEN(path)).sort();
  const manifests = paths.filter(packageManifestPath);
  if (manifests.length > PACKAGE_GRAPH_MAX_MANIFESTS)
    return {
      status: 'unknown',
      reason: `${manifests.length} manifests exceed the package graph limit of ${PACKAGE_GRAPH_MAX_MANIFESTS}`,
    };
  let bytes = 0;
  const texts = new Map<string, string | undefined>();
  const bounded: ManifestReader = path => {
    if (!texts.has(path)) {
      const text = read(path);
      bytes += text?.length ?? 0;
      texts.set(path, text);
    }
    if (bytes > PACKAGE_GRAPH_MAX_BYTES)
      throw new RangeError('manifest bytes exceed the package graph limit');
    return texts.get(path);
  };
  const ecosystems: EcosystemGraph[] = [];
  const unplaced: string[] = [];
  try {
    for (const reader of READERS) {
      const result = reader(paths, bounded);
      if (!result) continue;
      if ('refusal' in result) return { status: 'unknown', reason: `${result.ecosystem}: ${result.refusal}` };
      if ('unplaced' in result) unplaced.push(`${result.ecosystem}: ${result.unplaced}`);
      else if (result.packages.length) ecosystems.push(result);
    }
  } catch (error) {
    return { status: 'unknown', reason: (error as Error).message.slice(0, 200) };
  }
  if (!ecosystems.length)
    return {
      status: 'unknown',
      reason: manifests.length
        ? `no package in the manifests Forge read (${manifests.slice(0, 4).join(', ')}${manifests.length > 4 ? ', …' : ''})${unplaced.length ? `: ${unplaced.join('; ')}` : ''}`.slice(
            0,
            400,
          )
        : 'no package manifests Forge can read (go.mod, Cargo.toml, pyproject.toml, settings.gradle, pom.xml, *.csproj, package.json)',
    };
  return { status: 'available', ecosystems, packages: ecosystems.flatMap(item => item.packages) };
}

/** Graph cache per head: the key covers every path and every manifest's content id, so a hit is the
 * same graph. Small and process-local (a CLI run, a server action instance). */
const cache = new Map<string, PackageGraph>();
const CACHE_ENTRIES = 16;
export const packageGraphKey = (files: Iterable<{ path: string; blob: string }>) =>
  digestChunks(
    (function* () {
      for (const file of files) yield `${file.path}\0${packageManifestPath(file.path) ? file.blob : ''}\n`;
    })(),
  );
export const cachedPackageGraph = (key: string | undefined) => (key ? cache.get(key) : undefined);
export function packageGraphFor(key: string | undefined, allPaths: Iterable<string>, read: ManifestReader) {
  const hit = cachedPackageGraph(key);
  if (hit) return hit;
  const graph = buildPackageGraph(allPaths, read);
  // Only a readable graph is kept: an unknown one may come from bytes a caller has not read yet.
  if (key && graph.status === 'available') {
    cache.set(key, graph);
    if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  }
  return graph;
}

export type SelectedPackage = { ecosystem: string; dir: string; name: string; why: 'changed' | 'dependent' };
export type PackageSelection =
  | { scope: 'scoped' | 'none'; reason: string; packages: SelectedPackage[]; commands: PackageCommand[] }
  | { scope: 'full'; reason: string };

const DOCUMENTATION = /\.(?:md|mdx|txt|rst|adoc)$/i;
const label = (pkg: GraphPackage) => `${pkg.ecosystem}:${pkg.dir || '.'}`;
const within = (dir: string, path: string) => !dir || path.startsWith(`${dir}/`);

/** The packages that own `path`: its deepest enclosing package(s) and, for a package found only by its
 * manifest inside another one, the enclosing packages too (their tests, or packages that depend on
 * them, may read it; one with neither has nothing that could). Empty: outside every package. */
export function enclosingPackages(graph: Extract<PackageGraph, { status: 'available' }>, path: string) {
  const enclosing = graph.packages.filter(pkg => within(pkg.dir, path));
  const deepest = Math.max(-1, ...enclosing.map(pkg => pkg.dir.length));
  const owning = enclosing.filter(pkg => pkg.dir.length === deepest);
  if (!owning.some(pkg => !pkg.declared)) return owning;
  const depended = new Set(graph.packages.flatMap(pkg => pkg.dependsOn));
  return [
    ...owning,
    ...enclosing.filter(pkg => pkg.dir.length < deepest && (pkg.testable || depended.has(packageKey(pkg)))),
  ];
}

/** Reverse-dependent query: `keys` plus every package that depends on one of them, transitively. */
export function withDependents(
  graph: Extract<PackageGraph, { status: 'available' }>,
  keys: Iterable<string>,
) {
  const dependents = new Map<string, string[]>();
  for (const pkg of graph.packages)
    for (const key of pkg.dependsOn) dependents.set(key, [...(dependents.get(key) ?? []), packageKey(pkg)]);
  const selected = new Set(keys);
  const queue = [...selected];
  while (queue.length)
    for (const key of dependents.get(queue.shift()!) ?? [])
      if (!selected.has(key)) {
        selected.add(key);
        queue.push(key);
      }
  return selected;
}

/** Changed paths → owning packages → those plus every package that depends on them, and the
 * per-ecosystem commands that test them. Repository docs outside every package change nothing.
 * With the head's module graph (src/module-graph.ts), a changed package whose changes it fully reads
 * runs only the test units that reach them (src/module-selection.ts), the root package included;
 * dependent packages still run whole. */
export function packageSelection(
  graph: PackageGraph,
  changed: string[],
  modules?: () => ModuleGraph | undefined,
): PackageSelection {
  if (graph.status === 'unknown') return { scope: 'full', reason: `package graph unknown: ${graph.reason}` };
  const full = (reason: string): PackageSelection => ({ scope: 'full', reason: `package graph: ${reason}` });
  const byKey = new Map(graph.packages.map(pkg => [packageKey(pkg), pkg]));
  const owners = new Map<string, GraphPackage>();
  for (const path of changed) {
    const leaf = graph.ecosystems.map(item => item.leafOwner?.(path)).find(Boolean);
    if (leaf) {
      owners.set(packageKey(leaf), byKey.get(packageKey(leaf)) ?? leaf);
      continue;
    }
    const owning = enclosingPackages(graph, path);
    if (!owning.length || (owning.every(pkg => !pkg.dir) && DOCUMENTATION.test(path))) {
      if (DOCUMENTATION.test(path)) continue;
      return full(`${path} is outside every package`);
    }
    for (const pkg of owning) owners.set(packageKey(pkg), pkg);
  }
  if (!owners.size)
    return {
      scope: 'none',
      reason: 'package graph: only repository docs changed',
      packages: [],
      commands: [],
    };
  const selected = new Map(owners);
  for (const key of withDependents(graph, owners.keys()))
    if (!selected.has(key)) selected.set(key, byKey.get(key)!);
  // Built only when a changed package could be narrowed: reading sources costs more than manifests.
  const narrowable = [...owners.values()].some(pkg => !pkg.leaf && moduleEcosystem(pkg.ecosystem));
  const narrowing =
    modules && narrowable
      ? moduleNarrowing(
          modules(),
          changed,
          owners,
          path => enclosingPackages(graph, path),
          key => [...owners.keys()].some(other => other !== key && withDependents(graph, [other]).has(key)),
        )
      : undefined;
  const narrowed = narrowing?.units ?? new Map<string, string[]>();
  const root = [...selected.values()].find(pkg => !pkg.dir && !narrowed.has(packageKey(pkg)));
  if (root)
    return full(
      `root package ${root.name} (${root.ecosystem}) is affected` +
        (narrowing?.whole.has(packageKey(root))
          ? ` (module graph: ${narrowing.whole.get(packageKey(root))})`
          : ''),
    );
  const commands: PackageCommand[] = [];
  for (const ecosystem of graph.ecosystems) {
    const mine = [...selected.values()].filter(
      pkg =>
        pkg.ecosystem === ecosystem.ecosystem && pkg.testable && narrowed.get(packageKey(pkg))?.length !== 0,
    );
    if (!mine.length) continue;
    const result = ecosystem.commands(mine, changed, narrowed);
    if ('refusal' in result) return full(`${ecosystem.ecosystem}: ${result.refusal}`);
    commands.push(...result);
  }
  const packages = [...selected.values()]
    .map(pkg => ({
      ecosystem: pkg.ecosystem,
      dir: pkg.dir,
      name: pkg.name,
      why: owners.has(packageKey(pkg)) ? ('changed' as const) : ('dependent' as const),
    }))
    .sort((a, b) => `${a.ecosystem}:${a.dir}`.localeCompare(`${b.ecosystem}:${b.dir}`));
  const names = [...selected.values()].map(label).sort();
  const shown = names.length > 8 ? `${names.slice(0, 8).join(', ')}, …` : names.join(', ');
  const reason =
    `package graph (${graph.ecosystems.map(item => item.ecosystem).join(', ')}): ${owners.size} changed and ` +
    `${selected.size - owners.size} dependent package(s) of ${graph.packages.length} (${shown})` +
    (narrowed.size
      ? `; module graph: ${[...narrowed].map(([key, units]) => `${key.replace(/:$/, ':.')} runs ${units.length} test unit(s) that reach the change`).join(', ')}`
      : '') +
    (commands.length ? '' : '; none has tests to run');
  return { scope: commands.length ? 'scoped' : 'none', reason, packages, commands };
}

/** One shell line per command; a command in a package folder runs in a subshell, `(cd DIR && …)`,
 * so lines can be joined with `&&`. */
export const packageCommandLine = (command: PackageCommand, quote: (word: string) => string) =>
  command.cwd
    ? `(cd ${quote(command.cwd)} && ${command.argv.map(quote).join(' ')})`
    : command.argv.map(quote).join(' ');
/** A stable id for one command, used where a plan names its units. */
export const packageCommandUnit = (command: PackageCommand) =>
  `package:${command.cwd || '.'}:${command.argv.join(' ')}`;
