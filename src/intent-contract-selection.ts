// SPDX-License-Identifier: Apache-2.0
export { selectionSourcePath } from '../scripts/test-impact.mjs';
import { advisorySelection } from '../scripts/test-impact.mjs';
import { contractTestPath, standardTestPath } from './intent-test-contract.js';
import {
  resolveTestRunner,
  runnerCommand,
  runnerLabel,
  runnerSelection,
  type TestRunner,
  type TestRunnerResolution,
} from './project-test-runner.js';
import {
  PACKAGE_GRAPH_MAX_MANIFESTS,
  cachedPackageGraph,
  packageGraphFor,
  packageManifestPaths,
} from './package-graph.js';
import { packageRunnerTests, packageTestSelection } from './package-test-selection.js';
import { declaredPackageFlags } from './package-command-flags.js';

const shellWord = (value: string) =>
  /^[A-Za-z0-9_./=@:{}-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
/** One shell line that runs `tests` with the project's runner (null when there are none). */
export const runnerShellCommand = (runner: Pick<TestRunner, 'command' | 'parts'>, tests: string[]) =>
  tests.length ? runnerCommand(runner, tests).map(shellWord).join(' ') : null;

/** The project's runner from the selector inventory (`files` holds package.json, forge.json and,
 * when the caller read them, the package manifests) and every path. `graphKey` names the head
 * (src/package-graph.ts packageGraphKey) so the graph is built once per head. */
export const contractRunner = (
  files: Map<string, string>,
  allPaths: Iterable<string>,
  graphKey?: string,
): TestRunnerResolution =>
  resolveTestRunner(files.get('package.json'), () => allPaths, {
    forgeJson: files.get('forge.json'),
    packages: () => packageGraphFor(graphKey, allPaths, path => files.get(path)),
  });

/** The package manifests a caller must add to `files` before selecting: none for Forge's own Node
 * layout (its import graph needs none) or when this head's graph is cached; else every manifest. */
export function contractManifestPaths(files: Map<string, string>, allPaths: string[], graphKey?: string) {
  const plain = resolveTestRunner(files.get('package.json'), () => allPaths, {
    forgeJson: files.get('forge.json'),
  });
  if (plain.status === 'available' && plain.runner.layout === 'forge-node') return [];
  if (cachedPackageGraph(graphKey)) return [];
  const manifests = packageManifestPaths(allPaths);
  // Past the limit the graph is unknown from paths alone: read nothing.
  return manifests.length > PACKAGE_GRAPH_MAX_MANIFESTS ? [] : manifests.filter(path => !files.has(path));
}

/** Same conservative selector as checks, including newly added and changed tests, for Forge's Node
 * layout; any other project runner selects by path (src/project-test-runner.ts); without a runner,
 * the proposal is `unavailable` with the reason, never Forge's layout. `allPaths` is every path of
 * the head (the selector inventory `files` holds only the source domains it reads). */
export function intentContractSelection(
  files: Map<string, string>,
  paths: string[],
  allPaths: Iterable<string> = files.keys(),
  graphKey?: string,
) {
  const every = [...allPaths];
  const resolved = contractRunner(files, every, graphKey);
  if (resolved.status === 'unavailable')
    return {
      scope: 'unavailable',
      reason: `tests unavailable: ${resolved.reason}`,
      tests: [] as string[],
      available: [] as string[],
      runner: resolved,
    };
  const { runner } = resolved;
  const graph = () => packageGraphFor(graphKey, every, path => files.get(path));
  if (runner.layout === 'packages') {
    // Package commands, not test files: no per-file contract applies.
    const selection = packageTestSelection(
      graph(),
      paths,
      undefined,
      declaredPackageFlags(files.get('forge.json')),
    );
    return {
      scope: selection.scope,
      reason: selection.reason,
      tests: [] as string[],
      available: [] as string[],
      packages: selection.packages,
      commands: selection.commands,
      runner: { status: 'available' as const, label: runnerLabel(runner), command: runner.command },
      command: selection.command,
    };
  }
  if (runner.layout !== 'forge-node') {
    const selection = runnerSelection(runner, every, paths);
    const available = selection.available.filter(path => contractTestPath.safeParse(path).success);
    const inPackages = packageRunnerTests(runner, graph(), every, paths);
    const tests = [...new Set([...selection.tests, ...inPackages.tests])].filter(path =>
      available.includes(path),
    );
    return {
      scope: selection.scope === 'none' && tests.length ? 'scoped' : selection.scope,
      reason: inPackages.reason ? `${selection.reason}; ${inPackages.reason}` : selection.reason,
      tests,
      available,
      runner: { status: 'available' as const, label: runnerLabel(runner), command: runner.command },
      command: runnerShellCommand(runner, tests),
    };
  }
  const selection = advisorySelection({ files, paths, env: { FORGE_CHECK_SCOPED: '1' } });
  const available = [...files.keys()].filter(standardTestPath);
  const required = [
    ...new Set([...selection.tests, ...paths.filter(path => available.includes(path))]),
  ].sort();
  return { ...selection, tests: required, available };
}
