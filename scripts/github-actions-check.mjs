// SPDX-License-Identifier: Apache-2.0
import { childEnv } from './child-env.mjs';
// Shared executor for exported Forge snapshots and benchmark Git checkouts.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runDocumentationChecks } from './check-documentation.mjs';
import { checkPhases } from './check-phases.mjs';
import { keptFiles, poolUnits, validPool } from './shard-pool.mjs';
import {
  assertCheckContract,
  declaredRequirement,
  CHECK_CONTRACT_ENV,
  CHECK_CONTRACT_PROVIDED,
} from './check-contract.mjs';
export function runActionsCheck(execute = execFileSync, { install = true, build = true } = {}) {
  // First, before install or build: the Candidate's scripts must not need more than this executor provides.
  assertCheckContract(
    { ...process.env, [CHECK_CONTRACT_ENV]: String(CHECK_CONTRACT_PROVIDED) },
    declaredRequirement(),
  );
  const plan = JSON.parse(readFileSync(process.env.FORGE_ACTIONS_PLAN, 'utf8'));
  const shard = process.env.FORGE_ACTIONS_SHARD;
  // Shard pool part, set only by the fixed supervisor (src/hosted-actions-job-run.ts): `kept` runs
  // the front of this shard's group; a unit number runs that pool unit's files, tests only, after
  // the kept part has installed and built. Unset runs the whole group (the static plan).
  const part = process.env.FORGE_ACTIONS_POOL_PART;
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
        'FORGE_SOURCE_CACHE_DIR',
        // Fresh private directory for the check's JUnit XML reports (src/junit-report.ts).
        'FORGE_JUNIT_DIR',
        'npm_config_cache',
        'npm_config_userconfig',
        'npm_config_globalconfig',
        'XDG_CONFIG_HOME',
        'XDG_CACHE_HOME',
        'XDG_DATA_HOME',
      ],
    }),
    [CHECK_CONTRACT_ENV]: String(CHECK_CONTRACT_PROVIDED),
    FORGE_TEST_WORKERS: '2',
    FORGE_MAX_CONCURRENT_CHECKS: '2',
    FORGE_TEST_EVENTS: '1',
    FORGE_STATIC_WORKERS: '2',
    FORGE_GIT_TIMEOUT_MS: '240000',
    NODE_OPTIONS: '--max-old-space-size=3072',
  };
  const phases = checkPhases();
  const run = (executable, args) => execute(executable, args, { env, stdio: 'inherit' });
  const npm = (...args) => run('npm', args);
  // A project's own check command owns its setup (pnpm, Vite+, ...); only Forge's
  // recipe and npm-locked projects get the npm install.
  const npmLocked = existsSync('package-lock.json') || existsSync('npm-shrinkwrap.json');
  const unitPart = part !== undefined && part !== 'kept';
  try {
    // A docs-only change to an opaque command (its check's docsPaths) runs nothing, so no install either.
    const skipsCommand = !plan.standard && plan.selection?.scope === 'docs';
    if (install && !unitPart && !skipsCommand && (plan.standard || npmLocked))
      phases.time('install', () => npm('ci', '--ignore-scripts'));
    if (!plan.standard) {
      if (shard !== 'static') throw new Error('Arbitrary commands have only a static job.');
      if (skipsCommand)
        console.log(`Command not run: ${plan.selection.reason}. Set the check's docsPaths to change this.`);
      else phases.time('command', () => run(plan.command[0], plan.command.slice(1)));
    } else if (shard === 'static') {
      // verify reads only scope and tests. Selection reasons can exceed Linux's 128 KiB
      // per-variable limit, which makes the child spawn fail with E2BIG.
      const { scope, domain, reason } = plan.selection;
      // Tests run in the shard jobs. A standard code check with no shard has no test job at all.
      if (plan.standard && !['docs', 'partial'].includes(scope) && !plan.groups.length)
        throw new Error('ZERO_SELECTION: the plan has no test shard for a code change; no test would run.');
      env.FORGE_SELECTED_TESTS = JSON.stringify({ scope, domain, reason, tests: [] });
      if (plan.selection.scope === 'docs')
        runDocumentationChecks({ npm, node: script => run('node', [script]), interaction: plan.interaction });
      else phases.time('verify', () => run('node', ['scripts/verify.mjs']));
    } else {
      const index = Number(shard);
      if (!Number.isInteger(index) || !plan.groups[index]) throw new Error('Unselected Actions shard.');
      if (!plan.groups[index].length) throw new Error('ZERO_SELECTION: this shard has no test file.');
      const files = poolPart(plan, index, part);
      if (part !== undefined && part !== 'kept') {
        // A unit runs after this job's kept part: dependencies and build are already in place.
        if (plan.selection.scope === 'full') env.FORGE_TEST_COVERAGE_HEAD = plan.head;
        else delete env.FORGE_TEST_COVERAGE_HEAD;
        env.FORGE_TEST_RETRY_FILES = JSON.stringify(plan.retryFiles ?? []);
        phases.time('pool', () => run('node', ['scripts/test-files.mjs', ...files]));
        return;
      }
      if (build) {
        phases.time('build', () => {
          npm('run', 'build:core');
          npm('run', 'build:web');
        });
      } else {
        // Shared build artifacts omit ignored declarations; restore the API types
        // before tests invoke the deployment compiler directly.
        run('node', ['scripts/prepare-convex-api.mjs']);
      }
      // Partial runs never claim coverage, even when the job inherits a coverage head.
      if (plan.selection.scope === 'full') env.FORGE_TEST_COVERAGE_HEAD = plan.head;
      else delete env.FORGE_TEST_COVERAGE_HEAD;
      env.FORGE_TEST_RETRY_FILES = JSON.stringify(plan.retryFiles ?? []);
      phases.time('tests', () => run('node', ['scripts/test-files.mjs', ...files]));
    }
  } finally {
    phases.report();
  }
}

/** Files of one shard pool part, always taken from the pinned plan (never from the caller). */
function poolPart(plan, index, part) {
  if (part === undefined) return plan.groups[index];
  if (!validPool(plan.groups, plan.pool))
    throw new Error('Shard pool part requested without a valid pinned pool.');
  if (part === 'kept') return keptFiles(plan.groups, plan.pool, index);
  const unit = /^\d+$/.test(part) ? poolUnits(plan.groups, plan.pool)[Number(part)] : undefined;
  if (!unit) throw new Error('Unselected shard pool unit.');
  return unit.files;
}
