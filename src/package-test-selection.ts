// SPDX-License-Identifier: Apache-2.0
import {
  packageCommandLine,
  packageCommandUnit,
  packageSelection,
  type PackageCommand,
  type PackageGraph,
  type SelectedPackage,
} from './package-graph.js';
import type { ModuleGraph } from './module-graph-types.js';
import { runnerTestPath, type TestRunner } from './project-test-runner.js';

const shellWord = (value: string) =>
  /^[A-Za-z0-9_./=@:,{}-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

export type PackageTestSelection = {
  scope: 'scoped' | 'none' | 'full' | 'docs';
  reason: string;
  packages: SelectedPackage[];
  commands: PackageCommand[];
  /** One stable unit id per command (what preflight queues and its receipt counts). */
  units: string[];
  /** Every command as one shell line, or null when nothing runs. */
  command: string | null;
};

const DOCS = /\.(?:md|mdx|txt|rst|adoc)$/i;

/** The package-command selection for `layout: 'packages'` runners (src/project-test-runner.ts rule
 * 4): owning packages of the changed paths plus their dependents, each run with its ecosystem's
 * command; with the head's module graph, a changed package runs only the test units that reach the
 * change. A full selection runs nothing here: the landing check runs everything. */
export function packageTestSelection(
  graph: PackageGraph,
  changed: string[],
  modules?: () => ModuleGraph | undefined,
): PackageTestSelection {
  if (changed.length && changed.every(path => DOCS.test(path)))
    return {
      scope: 'docs',
      reason: 'docs-only change',
      packages: [],
      commands: [],
      units: [],
      command: null,
    };
  const selection = packageSelection(graph, changed, modules);
  if (selection.scope === 'full')
    return {
      scope: 'full',
      reason: `${selection.reason}; the landing check runs every package`,
      packages: [],
      commands: [],
      units: [],
      command: null,
    };
  return {
    scope: selection.scope,
    reason: selection.reason,
    packages: selection.packages,
    commands: selection.commands,
    units: selection.commands.map(packageCommandUnit),
    command: selection.commands.length
      ? selection.commands.map(command => packageCommandLine(command, shellWord)).join(' && ')
      : null,
  };
}

/** A path-selecting runner's test files inside the packages a change affects, dependents included
 * (empty when the graph cannot place the change). Adds coverage to the changed/named tests. */
export function packageRunnerTests(
  runner: TestRunner,
  graph: PackageGraph,
  allPaths: Iterable<string>,
  changed: string[],
): { tests: string[]; reason: string | null } {
  if (graph.status === 'unknown') return { tests: [], reason: null };
  const selection = packageSelection(graph, changed);
  if (selection.scope === 'full' || !selection.packages.length) return { tests: [], reason: null };
  const dirs = selection.packages.map(pkg => pkg.dir).filter(Boolean);
  const tests = [...new Set(allPaths)]
    .filter(path => dirs.some(dir => path.startsWith(`${dir}/`)) && runnerTestPath(runner, path))
    .sort();
  return {
    tests,
    reason: `${tests.length} test file(s) in ${selection.packages.length} affected package(s) (${selection.reason})`,
  };
}
