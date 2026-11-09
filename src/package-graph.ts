// SPDX-License-Identifier: Apache-2.0
import { digestChunks } from './portable-hash.js';
import { manifestNames } from './ecosystems.js';
import { documentationPath } from './prose-paths.js';
import { moduleEcosystem, moduleNarrowing } from './module-selection.js';
import { applyPackageFlags, type PackageFlagSource } from './package-command-flags.js';
import type { ModuleGraph } from './module-graph-types.js';
import { cargoGraph, goGraph } from './package-graph-go-rust.js';
import { pythonGraph, pythonManifest } from './package-graph-python.js';
import { gradleGraph, jvmManifest, mavenGraph } from './package-graph-jvm.js';
import { dotnetGraph, dotnetImport, dotnetManifest, jsWorkspaceGraph } from './package-graph-dotnet-js.js';
import { parseForgeJson } from './project-config.js';
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
 * no unambiguous test command) makes the selection full, with the reason. When unsure it widens,
 * never narrows: a package with a reference the graph cannot place is selected by every change, and
 * in a repository with more than one ecosystem a change selects every package of the others unless
 * forge.json declares the cross-ecosystem edges (`packages.edges`). */

/** At most this many manifests are read for one head; more means an unknown (full) layout. */
export const PACKAGE_GRAPH_MAX_MANIFESTS = 2000;
/** Total manifest bytes read for one head. */
export const PACKAGE_GRAPH_MAX_BYTES = 16 * 1024 * 1024;

const HIDDEN = (path: string) =>
  path.split('/').some(part => part.startsWith('.') || part === 'node_modules');
/** Exact manifest names from the ecosystem registry (src/ecosystems.ts); patterned names stay with
 * their readers (pythonManifest, jvmManifest, dotnetManifest). */
const MANIFESTS = manifestNames();
/** Whether `path` is a manifest the graph reads (paths alone answer everything else). */
export function packageManifestPath(path: string) {
  if (HIDDEN(path)) return false;
  const name = basename(path);
  return (
    MANIFESTS.has(name) ||
    path === 'forge.json' ||
    (pythonManifest(path) && name !== 'setup.py') ||
    jvmManifest(path) ||
    dotnetManifest(path) ||
    dotnetImport(path)
  );
}
export const packageManifestPaths = (allPaths: Iterable<string>) =>
  [...allPaths].filter(packageManifestPath).sort();

export type PackageGraph =
  | {
      status: 'available';
      ecosystems: EcosystemGraph[];
      packages: GraphPackage[];
      /** `declared`: forge.json `packages.edges` lists every edge between ecosystems. */
      crossEcosystem?: 'declared';
    }
  | { status: 'unknown'; reason: string };

/** forge.json `packages.edges`: a list of `{from, to}` package names (`python:.`, `cargo:crates/core`);
 * `from` depends on `to`. Declaring the list (even empty) says it holds every edge between ecosystems; each edge must
 * name a package of the graph, or the graph is unknown (a typo never narrows a run). */
function declaredEdges(packages: GraphPackage[], read: ManifestReader): string | null | 'declared' {
  const config = parseForgeJson(read('forge.json'))?.packages;
  if (!config || typeof config !== 'object' || !('edges' in config)) return null;
  const edges = (config as { edges: unknown }).edges;
  if (!Array.isArray(edges)) return 'forge.json packages.edges must be a list of {from, to}';
  const byKey = new Map(packages.map(pkg => [label(pkg), pkg]));
  for (const edge of edges) {
    const { from, to } = (edge ?? {}) as { from?: unknown; to?: unknown };
    const source = typeof from === 'string' ? byKey.get(from) : undefined;
    const target = typeof to === 'string' ? byKey.get(to) : undefined;
    if (!source || !target)
      return `forge.json packages.edges: ${JSON.stringify(edge).slice(0, 120)} names no package (use ecosystem:dir, . for the root)`;
    if (source !== target) source.dependsOn = [...new Set([...source.dependsOn, packageKey(target)])].sort();
  }
  return 'declared';
}

/** A folder a manifest claims (`GraphPackage.claims`) resolves to its own ecosystem's package there
 * (the reader's edge), else to every package of another ecosystem there (an edge across ecosystems),
 * else the claiming package is unresolved. */
function linkClaims(packages: GraphPackage[]) {
  const byDir = new Map<string, GraphPackage[]>();
  for (const pkg of packages) byDir.set(pkg.dir, [...(byDir.get(pkg.dir) ?? []), pkg]);
  for (const pkg of packages)
    for (const dir of pkg.claims ?? []) {
      const there = (byDir.get(dir) ?? []).filter(other => other !== pkg);
      if (there.some(other => other.ecosystem === pkg.ecosystem)) continue;
      if (!there.length)
        pkg.unresolved ??= `${pkg.manifest} takes a dependency from ${dir || '.'}, which has no package Forge read`;
      else pkg.dependsOn = [...new Set([...pkg.dependsOn, ...there.map(packageKey)])].sort();
    }
}

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
  linkClaims(ecosystems.flatMap(item => item.packages));
  let declared: string | null | 'declared' = null;
  if (paths.includes('forge.json') && ecosystems.length)
    try {
      declared = declaredEdges(
        ecosystems.flatMap(item => item.packages),
        bounded,
      );
    } catch (error) {
      return { status: 'unknown', reason: (error as Error).message.slice(0, 200) };
    }
  if (declared && declared !== 'declared') return { status: 'unknown', reason: declared };
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
  return {
    status: 'available',
    ecosystems,
    packages: ecosystems.flatMap(item => item.packages),
    ...(declared === 'declared' ? { crossEcosystem: 'declared' as const } : {}),
  };
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

const label = (pkg: GraphPackage) => `${pkg.ecosystem}:${pkg.dir || '.'}`;
const within = (dir: string, path: string) => !dir || path.startsWith(`${dir}/`);

/** The packages that own `path`: its deepest enclosing package(s) and, for a package found only by its
 * manifest inside another one or for an enclosing package of another ecosystem (a JS or Python
 * package that builds the crate inside it), the enclosing packages too: their tests, or packages that
 * depend on them, may read it; one with neither has nothing that could. An enclosing package that
 * builds nothing (`virtual`) reads a nested package only through a dependency it declares on it.
 * Empty: outside every package. */
export function enclosingPackages(graph: Extract<PackageGraph, { status: 'available' }>, path: string) {
  const enclosing = graph.packages.filter(pkg => within(pkg.dir, path));
  const deepest = Math.max(-1, ...enclosing.map(pkg => pkg.dir.length));
  const owning = enclosing.filter(pkg => pkg.dir.length === deepest);
  const ecosystems = new Set(owning.map(pkg => pkg.ecosystem));
  const undeclared = owning.some(pkg => !pkg.declared);
  const declares = (pkg: GraphPackage) =>
    owning.some(owner => pkg.dependsOn.includes(packageKey(owner)) || pkg.claims?.includes(owner.dir));
  const outer = enclosing.filter(
    pkg =>
      pkg.dir.length < deepest &&
      (undeclared || !ecosystems.has(pkg.ecosystem)) &&
      (!pkg.virtual || declares(pkg)),
  );
  if (!outer.length) return owning;
  const depended = new Set(graph.packages.flatMap(pkg => pkg.dependsOn));
  return [
    ...owning,
    ...outer.filter(pkg => pkg.testable || pkg.hiddenTests || depended.has(packageKey(pkg))),
  ];
}

const ecosystemOf = (key: string) => key.slice(0, key.indexOf(':'));
/** Packages a non-empty change may reach although no edge names them, with why: every package with
 * a reference the graph cannot place, and (unless forge.json declares the cross-ecosystem edges) in
 * a repository with more than one ecosystem every package of an ecosystem the change is not in that
 * has tests (each one is widened on its own, so one without tests adds nothing) and whose manifest
 * does not name its inputs from other ecosystems (`foreignDeclared`). */
export function widenedPackages(
  graph: Extract<PackageGraph, { status: 'available' }>,
  keys: Iterable<string>,
): Map<string, string> {
  const changed = new Set([...keys].map(ecosystemOf));
  const widened = new Map<string, string>();
  if (!changed.size) return widened;
  const mixed =
    graph.crossEcosystem !== 'declared' && new Set(graph.packages.map(pkg => pkg.ecosystem)).size > 1;
  for (const pkg of graph.packages)
    if (pkg.unresolved) widened.set(packageKey(pkg), pkg.unresolved);
    else if (
      mixed &&
      !changed.has(pkg.ecosystem) &&
      !pkg.foreignDeclared &&
      (pkg.testable || pkg.hiddenTests)
    )
      widened.set(
        packageKey(pkg),
        `a ${pkg.ecosystem} package may consume a ${[...changed].sort().join('/')} change (no forge.json packages.edges)`,
      );
  return widened;
}

/** Reverse-dependent query: `keys` plus every package that depends on one of them, transitively,
 * widened by `widenedPackages`. */
export function withDependents(
  graph: Extract<PackageGraph, { status: 'available' }>,
  keys: Iterable<string>,
) {
  const dependents = new Map<string, string[]>();
  for (const pkg of graph.packages)
    for (const key of pkg.dependsOn) dependents.set(key, [...(dependents.get(key) ?? []), packageKey(pkg)]);
  const selected = new Set(keys);
  for (const key of widenedPackages(graph, selected).keys()) selected.add(key);
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
  flags?: PackageFlagSource | { refusal: string },
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
    if (!owning.length || (owning.every(pkg => !pkg.dir) && documentationPath(path))) {
      if (documentationPath(path)) continue;
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
  const hidden = [...selected.values()].find(pkg => !pkg.testable && pkg.hiddenTests);
  if (hidden)
    return full(
      `${label(hidden)} has test files (${hidden.hiddenTests}) but no test command of its own, so the repository runs them another way`,
    );
  // A root package the change reaches only as a dependent is one more package where its command
  // tests just that package (Cargo `-p`); a root that encloses a changed path stays full.
  const scopedRoot = new Set(graph.ecosystems.filter(item => item.rootScoped).map(item => item.ecosystem));
  const root = [...selected.values()].find(
    pkg =>
      !pkg.dir &&
      !narrowed.has(packageKey(pkg)) &&
      (owners.has(packageKey(pkg)) || !scopedRoot.has(pkg.ecosystem)),
  );
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
    const generated = ecosystem.commands(mine, changed, narrowed);
    if ('refusal' in generated) return full(`${ecosystem.ecosystem}: ${generated.refusal}`);
    // The project's own test flags (forge.json template, else the declared check's), or a refusal.
    const result =
      flags && 'refusal' in flags ? flags : applyPackageFlags(ecosystem.ecosystem, generated, flags);
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
  const widened = [...widenedPackages(graph, owners.keys())].filter(([key]) => !owners.has(key));
  const names = [...selected.values()].map(label).sort();
  const shown = names.length > 8 ? `${names.slice(0, 8).join(', ')}, …` : names.join(', ');
  const reason =
    `package graph (${graph.ecosystems.map(item => item.ecosystem).join(', ')}): ${owners.size} changed and ` +
    `${selected.size - owners.size} dependent package(s) of ${graph.packages.length} (${shown})` +
    (widened.length
      ? `; widened to ${widened.length} package(s) no edge names: ${widened
          .slice(0, 3)
          .map(([key, why]) => `${key.replace(/:$/, ':.')} (${why})`)
          .join(', ')}${widened.length > 3 ? ', …' : ''}`
      : '') +
    (narrowed.size
      ? `; module graph: ${[...narrowed].map(([key, units]) => `${key.replace(/:$/, ':.')} runs ${units.length} test unit(s) that reach the change`).join(', ')}`
      : '') +
    (commands.length ? '' : '; none has tests to run') +
    (commands.some(command => command.flagsFrom)
      ? `; test flags from ${[...new Set(commands.flatMap(command => (command.flagsFrom ? [command.flagsFrom === 'ci' ? "the check's own text" : 'forge.json packages.commands'] : [])))].join(' and ')}`
      : '');
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
