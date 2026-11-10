// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { NativeSource } from './native-source.js';
import { resolveTestRunner, runnerCommand, runnerTestPath, type TestRunner } from './project-test-runner.js';
import { isStandardForgeCheck } from './standard-check.js';
import { workGit } from './work-git.js';
import { workspaceTestRunner } from './workspace-test-runner.js';
import type { WorkStore } from './work-store.js';

type StoreAccess = Pick<WorkStore, 'native' | 'root'>;

type Check = { executable: string; args: readonly string[] };
/** Forge's standard check runs explicit files through its own runner, which reads only this layout. */
const forgeTestFile = (path: string) => path.startsWith('tests/') && path.endsWith('.test.mjs');

/** Validate an explicit `run {tests}` list against the check at `head`. Forge's standard check takes
 * its own `tests/*.test.mjs` files; any other check takes the project test runner's test files
 * (src/project-test-runner.ts), present at that head. Reads the head's path list and package.json;
 * runs nothing. Returns the runner for a non-standard check. */
export function explicitTestsRunner(
  store: StoreAccess,
  check: Check,
  head: string,
  tests: readonly string[],
): TestRunner | undefined {
  if (isStandardForgeCheck(check, process.execPath)) {
    const wrong = tests.find(test => !forgeTestFile(test));
    invariant(
      !wrong,
      'BAD_ARGUMENT',
      `Forge's standard check runs tests/*.test.mjs files; ${wrong} is not one.`,
    );
    return undefined;
  }
  let paths: string[], packageJson: string | undefined;
  if (store.native) {
    const source = new NativeSource(store.root),
      files = source.state(head).files;
    paths = files.map(file => file.path);
    const manifest = files.find(file => file.path === 'package.json');
    packageJson = manifest ? source.object(manifest.blob).toString('utf8') : undefined;
  } else {
    paths = workGit(store.root, ['ls-tree', '-r', '-z', '--name-only', head]).split('\0').filter(Boolean);
    packageJson = paths.includes('package.json')
      ? workGit(store.root, ['cat-file', 'blob', `${head}:package.json`])
      : undefined;
  }
  const resolved = resolveTestRunner(packageJson, () => paths);
  invariant(
    resolved.status === 'available',
    'BAD_ARGUMENT',
    `Explicit test files need the project test runner, and it is unavailable: ${resolved.status === 'unavailable' ? resolved.reason : ''}`,
  );
  const present = new Set(paths);
  const wrong = tests.find(test => !present.has(test) || !runnerTestPath(resolved.runner, test));
  invariant(
    !wrong,
    'BAD_ARGUMENT',
    `${wrong} is not a test file of the project runner (${resolved.runner.globs.join(', ')}) at this head.`,
  );
  return resolved.runner;
}

/** The argv a partial run executes in its workspace: the check itself for Forge's standard check
 * (forge-check reads FORGE_SELECTED_TESTS), else the project runner over exactly `tests`. */
export function explicitTestsCommand(check: Check, workspace: string, tests: string[]): string[] | undefined {
  if (isStandardForgeCheck(check, process.execPath)) return undefined;
  const resolved = workspaceTestRunner(workspace, tests);
  invariant(
    resolved.status === 'available',
    'BAD_ARGUMENT',
    `Explicit test files need the project test runner, and it is unavailable: ${resolved.status === 'unavailable' ? resolved.reason : ''}`,
  );
  return runnerCommand(resolved.runner, tests);
}
