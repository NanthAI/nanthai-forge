// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveTestRunner, type TestRunner, type TestRunnerResolution } from './project-test-runner.js';
import { checkoutPackageGraph } from './package-graph-checkout.js';
import type { PackageGraph } from './package-graph.js';
import { packageTestSelection } from './package-test-selection.js';
import { PROJECT_LOCKFILES } from './project-lockfile.js';
import { STANDARD_CHECK_ENTRY } from './standard-check.js';

/** The project test runner of a checked-out workspace (its package.json or forge.json, its lockfile, Forge's check entry and
 * the test files at hand), for running semantic union tests there. Reads three small files, runs nothing. */
export function workspaceTestRunner(directory: string, tests: string[]): TestRunnerResolution {
  let packageJson: string | undefined;
  try {
    packageJson = readFileSync(join(directory, 'package.json'), 'utf8');
  } catch {
    /* No manifest: only the file rule applies. */
  }
  let forgeJson: string | undefined;
  try {
    forgeJson = readFileSync(join(directory, 'forge.json'), 'utf8');
  } catch {
    /* No language-neutral declaration. */
  }
  let graph: PackageGraph | undefined;
  const packages = () => (graph ??= checkoutPackageGraph(directory));
  const resolved = resolveTestRunner(
    packageJson,
    () => [
      ...tests,
      ...[...PROJECT_LOCKFILES, STANDARD_CHECK_ENTRY].filter(file => existsSync(join(directory, file))),
    ],
    { forgeJson, packages },
  );
  if (resolved.status !== 'available' || resolved.runner.layout !== 'packages') return resolved;
  // No per-file runner: an uncovered union file reruns as its package's own command (the whole
  // package, a superset of the file), or is unavailable with the reason the selection gives.
  const fileCommands: NonNullable<TestRunner['fileCommands']> = {};
  for (const test of tests) {
    const selection = packageTestSelection(packages(), [test]);
    fileCommands[test] = selection.command
      ? ['sh', '-c', selection.command]
      : { unavailable: selection.reason };
  }
  return { status: 'available', runner: { ...resolved.runner, fileCommands } };
}
