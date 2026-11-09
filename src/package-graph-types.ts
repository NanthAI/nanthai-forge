// SPDX-License-Identifier: Apache-2.0
/** Shared shapes of the manifest-level package graph (src/package-graph.ts). */
export type Ecosystem = 'go' | 'cargo' | 'python' | 'gradle' | 'maven' | 'dotnet' | 'js';

export type GraphPackage = {
  ecosystem: Ecosystem;
  /** Folder of the package; `''` is the repository root (selecting it means a full run). */
  dir: string;
  name: string;
  manifest: string;
  /** Keys (`ecosystem:dir`) of in-repository packages this one depends on. */
  dependsOn: string[];
  /** False when the manifest shows the package has nothing to test (no test script, not a test project). */
  testable: boolean;
  /** Listed by a workspace (Cargo members, JS workspaces, Gradle includes, Maven modules, uv members).
   * A package found only by its manifest that sits inside another package's folder may be read by
   * that package's build or tests, so a change to it selects the enclosing packages too. */
  declared: boolean;
  /** A Go package folder that owns only test files: nothing imports it, so it has no dependents. */
  leaf?: true;
  /** Why this package may depend on something the graph cannot name (a reference it cannot place, a
   * convention plugin or imported build file it does not read). Every change then selects it. */
  unresolved?: string;
  /** A test file below this package that no per-package command runs (it has none of its own): the
   * repository runs it some other way, so selecting this package makes the selection full. */
  hiddenTests?: string;
  /** Builds nothing from its folder (a Python project with uv `package = false`, or no build system):
   * it reads a nested package's files only through a dependency it declares (`claims`), so it owns
   * only the files no nested package claims. */
  virtual?: true;
  /** Folders the manifest names as its dependencies or members (paths, workspace members, the crate
   * a maturin build compiles). A package of another ecosystem there is an edge; none is unresolved. */
  claims?: string[];
  /** Its manifest names every input it takes from another ecosystem (`claims`), so a change there
   * reaches it through edges, not through the cross-ecosystem widening. */
  foreignDeclared?: true;
};

/** One argv to run in `cwd` (relative to the repository root) for the named package keys. */
export type PackageCommand = {
  ecosystem: Ecosystem;
  cwd: string;
  argv: string[];
  packages: string[];
  /** Where the project's own test flags in `argv` came from (src/package-command-flags.ts). */
  flagsFrom?: 'forge.json' | 'ci';
};

export type EcosystemGraph = {
  ecosystem: Ecosystem;
  packages: GraphPackage[];
  /** A finer owner for one changed path than its enclosing package (Go test-only folders). */
  leafOwner?: (path: string) => GraphPackage | undefined;
  /** The root package's command tests that package only (`cargo test -p NAME`), so a root selected
   * only as a dependent is one more package, not a full run. */
  rootScoped?: true;
  /** The commands that test `selected` (non-empty, testable, all of this ecosystem), or why there is
   * no unambiguous default command. `changed` are the changed paths, for test-only narrowing.
   * `narrowed` maps a package key to the only test units to run for it (src/module-selection.ts):
   * pytest files, Go package folders, Cargo test targets or JVM test classes; never empty. */
  commands: (
    selected: GraphPackage[],
    changed: string[],
    narrowed?: ReadonlyMap<string, string[]>,
  ) => PackageCommand[] | { refusal: string };
};

/** What one ecosystem reader returns: nothing found, a graph, why the layout is not readable, or
 * (`unplaced`) why its manifests place no package (named in the graph's reason when nothing reads). */
export type EcosystemResult =
  | null
  | EcosystemGraph
  | { ecosystem: Ecosystem; refusal: string }
  | { ecosystem: Ecosystem; unplaced: string };

export type ManifestReader = (path: string) => string | undefined;

export const packageKey = (pkg: Pick<GraphPackage, 'ecosystem' | 'dir'>) => `${pkg.ecosystem}:${pkg.dir}`;
export const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** `base/../x` style joins, null when the result leaves the repository. */
export function joinPath(base: string, relative: string): string | null {
  const parts = base ? base.split('/') : [];
  for (const part of relative.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}
