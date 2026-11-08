// SPDX-License-Identifier: Apache-2.0
export { selectionSourcePath } from '../scripts/test-impact.mjs';
import { advisorySelection } from '../scripts/test-impact.mjs';
import { contractTestPath, standardTestPath } from './intent-test-contract.js';
import {
  resolveTestRunner,
  runnerCommand,
  runnerLabel,
  runnerSelection,
  type TestRunnerResolution,
} from './project-test-runner.js';

const shellWord = (value: string) =>
  /^[A-Za-z0-9_./=@:{}-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
/** One shell line that runs `tests` with the project's runner (null when there are none). */
export const runnerShellCommand = (runner: { command: string[] }, tests: string[]) =>
  tests.length ? runnerCommand(runner, tests).map(shellWord).join(' ') : null;

/** The project's runner from the selector inventory (`files` holds package.json) and every path. */
export const contractRunner = (
  files: Map<string, string>,
  allPaths: Iterable<string>,
): TestRunnerResolution => resolveTestRunner(files.get('package.json'), () => allPaths);

/** Same conservative selector as checks, including newly added and changed tests, for Forge's Node
 * layout; any other project runner selects by path (src/project-test-runner.ts); without a runner,
 * the proposal is `unavailable` with the reason, never Forge's layout. `allPaths` is every path of
 * the head (the selector inventory `files` holds only the source domains it reads). */
export function intentContractSelection(
  files: Map<string, string>,
  paths: string[],
  allPaths: Iterable<string> = files.keys(),
) {
  const resolved = contractRunner(files, allPaths);
  if (resolved.status === 'unavailable')
    return {
      scope: 'unavailable',
      reason: `tests unavailable: ${resolved.reason}`,
      tests: [] as string[],
      available: [] as string[],
      runner: resolved,
    };
  const { runner } = resolved;
  if (runner.layout !== 'forge-node') {
    const selection = runnerSelection(runner, allPaths, paths);
    const available = selection.available.filter(path => contractTestPath.safeParse(path).success);
    const tests = selection.tests.filter(path => available.includes(path));
    return {
      scope: selection.scope,
      reason: selection.reason,
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
