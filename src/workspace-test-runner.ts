// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveTestRunner, type TestRunnerResolution } from './project-test-runner.js';

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

/** The project test runner of a checked-out workspace (its package.json, its lockfile and the test
 * files at hand), for running semantic union tests there. Reads two small files, runs nothing. */
export function workspaceTestRunner(directory: string, tests: string[]): TestRunnerResolution {
  let packageJson: string | undefined;
  try {
    packageJson = readFileSync(join(directory, 'package.json'), 'utf8');
  } catch {
    /* No manifest: only the file rule applies. */
  }
  return resolveTestRunner(packageJson, () => [
    ...tests,
    ...LOCKFILES.filter(file => existsSync(join(directory, file))),
  ]);
}
