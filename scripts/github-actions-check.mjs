// SPDX-License-Identifier: Apache-2.0
import { childEnv } from './child-env.mjs';
// Shared executor for exported Forge snapshots and benchmark Git checkouts.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runDocumentationChecks } from './check-documentation.mjs';
export function runActionsCheck(execute = execFileSync, { install = true, build = true } = {}) {
  const plan = JSON.parse(readFileSync(process.env.FORGE_ACTIONS_PLAN, 'utf8'));
  const shard = process.env.FORGE_ACTIONS_SHARD;
  const env = {
    ...childEnv({
      allow: [
        'CI',
        'FORGE_ACTIONS_PLAN',
        'FORGE_ACTIONS_SHARD',
        'FORGE_SELECTED_TESTS',
        'FORGE_TEST_COVERAGE_HEAD',
        'FORGE_TEST_TIMINGS',
        'FORGE_TEST_TIMINGS_HISTORY',
        'npm_config_cache',
        'npm_config_userconfig',
        'npm_config_globalconfig',
        'XDG_CONFIG_HOME',
        'XDG_CACHE_HOME',
        'XDG_DATA_HOME',
      ],
    }),
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
    // verify reads only scope and tests. Selection reasons can exceed Linux's 128 KiB
    // per-variable limit, which makes the child spawn fail with E2BIG.
    const { scope, domain, reason } = plan.selection;
    env.FORGE_SELECTED_TESTS = JSON.stringify({ scope, domain, reason, tests: [] });
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
    // Partial runs never claim coverage, even when the job inherits a coverage head.
    if (plan.selection.scope === 'full') env.FORGE_TEST_COVERAGE_HEAD = plan.head;
    else delete env.FORGE_TEST_COVERAGE_HEAD;
    env.FORGE_TEST_RETRY_FILES = JSON.stringify(plan.retryFiles ?? []);
    run('node', ['scripts/test-files.mjs', ...plan.groups[index]]);
  }
}
