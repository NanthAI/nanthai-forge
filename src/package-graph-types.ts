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
};

/** One argv to run in `cwd` (relative to the repository root) for the named package keys. */
export type PackageCommand = { ecosystem: Ecosystem; cwd: string; argv: string[]; packages: string[] };

export type EcosystemGraph = {
  ecosystem: Ecosystem;
  packages: GraphPackage[];
  /** A finer owner for one changed path than its enclosing package (Go test-only folders). */
  leafOwner?: (path: string) => GraphPackage | undefined;
  /** The commands that test `selected` (non-empty, testable, all of this ecosystem), or why there is
   * no unambiguous default command. `changed` are the changed paths, for test-only narrowing. */
  commands: (selected: GraphPackage[], changed: string[]) => PackageCommand[] | { refusal: string };
};

/** What one ecosystem reader returns: nothing found, a graph, or why the layout is not readable. */
export type EcosystemResult = null | EcosystemGraph | { ecosystem: Ecosystem; refusal: string };

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
