// SPDX-License-Identifier: Apache-2.0
// Shared executor for exported Forge snapshots and benchmark Git checkouts.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runDocumentationChecks } from './check-documentation.mjs';
export function runActionsCheck(execute = execFileSync, { install = true, build = true } = {}) {
  const plan = JSON.parse(readFileSync(process.env.FORGE_ACTIONS_PLAN, 'utf8'));
  const shard = process.env.FORGE_ACTIONS_SHARD;
  const env = {
    ...process.env,
    FORGE_TEST_WORKERS: '2',
    FORGE_MAX_CONCURRENT_CHECKS: '2',
    FORGE_TEST_EVENTS: '1',
    FORGE_STATIC_WORKERS: '2',
    FORGE_GIT_TIMEOUT_MS: '240000',
    NODE_OPTIONS: '--max-old-space-size=3072',
  };
  const run = (executable, args) => execute(executable, args, { env, stdio: 'inherit' });
  const npm = (...args) => run('npm', args);
  if (install) npm('ci', '--ignore-scripts');
  if (!plan.standard) {
    if (shard !== 'static') throw new Error('Arbitrary commands have only a static job.');
    run(plan.command[0], plan.command.slice(1));
  } else if (shard === 'static') {
    env.FORGE_SELECTED_TESTS = JSON.stringify({ ...plan.selection, tests: [] });
    if (plan.selection.scope === 'docs')
      runDocumentationChecks({ npm, node: script => run('node', [script]), interaction: plan.interaction });
    else run('node', ['scripts/verify.mjs']);
  } else {
    const index = Number(shard);
    if (!Number.isInteger(index) || !plan.groups[index]) throw new Error('Unselected Actions shard.');
    if (build) {
      npm('run', 'build:core');
      npm('run', 'build:web');
    }
    if (plan.selection.scope === 'full') env.FORGE_TEST_COVERAGE_HEAD = plan.head;
    run('node', ['scripts/test-files.mjs', ...plan.groups[index]]);
  }
}
