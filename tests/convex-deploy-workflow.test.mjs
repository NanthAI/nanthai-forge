// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { planConvexDeploy } from '../scripts/forge-deploy-ci.mjs';
import { moduleUrl } from './convex-module.mjs';

const { targets } = JSON.parse(readFileSync('.nforge/deploy-targets.json'));
const deployDispatch = await import(moduleUrl('../convex/projectDeployDispatch.ts'));
const workflow = readFileSync('.github/workflows/convex-deploy.yml', 'utf8');

test('Item 8b6efb50: dev Convex deploys from Forge workflow_dispatch and catch-up schedule on main, never mirror push', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /schedule:\n\s+- cron: '17 \*\/3 \* \* \*'/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.doesNotMatch(workflow, /pull_request/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main' && vars\.FORGE_RELEASE_PROJECT != ''/);
  assert.match(workflow, /environment: convex-dev/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version: '24\.22\.1'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /^permissions:\n {2}contents: read\n {2}id-token: write$/m);
  assert.match(workflow, /CONVEX_DEPLOY_KEY: \$\{\{ secrets\.CONVEX_DEPLOY_KEY \}\}/);
  assert.equal(workflow.match(/secrets\./g).length, 1);
});

// Convex imports shared reducers and transports from src; changes there must dispatch Convex deploys.
test('Item 8b6efb50: backend and shared source changes dispatch dev Convex deploys; docs and tests do not', () => {
  for (const path of [
    'convex/x.ts',
    'src/x.ts',
    'package.json',
    'package-lock.json',
    '.github/workflows/convex-deploy.yml',
    'scripts/forge-deploy-ci.mjs',
  ])
    assert.deepEqual(
      deployDispatch.selectDeployTargets(targets, [path]).some(target => target.name === 'convex'),
      true,
      path,
    );
  for (const path of ['docs/a.md', 'tests/b.mjs', 'web/src/app/App.tsx'])
    assert.deepEqual(
      deployDispatch.selectDeployTargets(targets, [path]).some(target => target.name === 'convex'),
      false,
      path,
    );
});

// Forge main sequence and changed-path planning replaces the old GitHub compare job and works even when the mirror stops.
test('Item 8b6efb50: Convex deploy plans via Forge OIDC, checks out Forge main State and reports outcome', () => {
  const order = [
    'scripts/forge-deploy-ci.mjs plan --target convex',
    'scripts/forge-deploy-ci.mjs checkout --target convex',
    'npm ci --ignore-scripts',
    'npx --no-install convex deploy',
    'scripts/forge-deploy-ci.mjs report',
  ].map(s => workflow.indexOf(s));
  assert(order.every(i => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]));
  const deployStep = workflow
    .split(/^      - /m)
    .find(text => text.startsWith('name: Deploy functions and schema to dev\n'));
  assert(deployStep, 'deploy step present');
  assert.doesNotMatch(workflow.replace(deployStep, ''), /\bCONVEX_DEPLOY_KEY\b/);
});

test('Item 8b6efb50: planConvexDeploy skips already-deployed or non-Convex changes and deploys on Convex or unknown changes', () => {
  const head = 'a'.repeat(64);
  assert.equal(
    planConvexDeploy({ head, sequence: 10, lastDeployed: { sequence: 10 }, changedPaths: [] }).deploy,
    false,
  );
  assert.equal(
    planConvexDeploy({
      head,
      sequence: 11,
      lastDeployed: { sequence: 10 },
      changedPaths: ['docs/a.md', 'tests/b.mjs', 'web/src/a.tsx'],
    }).deploy,
    false,
  );
  for (const path of [
    'convex/x.ts',
    'src/a.ts',
    'package.json',
    'package-lock.json',
    '.github/workflows/convex-deploy.yml',
  ])
    assert.equal(
      planConvexDeploy({ head, sequence: 11, lastDeployed: { sequence: 10 }, changedPaths: [path] }).deploy,
      true,
      path,
    );
  assert.equal(
    planConvexDeploy({ head, sequence: 11, lastDeployed: { sequence: 10 }, changedPaths: null }).deploy,
    true,
  );
  assert.equal(planConvexDeploy({ head, sequence: 1, lastDeployed: null, changedPaths: null }).deploy, true);
});

// The exit bench's own deployment (Issue 2e1f5fbd): deployed code may move only when the lead
// dispatches it, from a commit on main, with a key that reaches no other deployment.
test('bench Convex deploys only on dispatch, from a main commit, inside its own environment', () => {
  const bench = readFileSync('.github/workflows/convex-bench-deploy.yml', 'utf8');
  const on = bench.slice(bench.indexOf('\non:'), bench.indexOf('\npermissions:'));
  assert.match(on, /workflow_dispatch:/);
  assert.doesNotMatch(on, /push:|pull_request|schedule:|workflow_run/);
  assert.match(bench, /environment: convex-bench/);
  assert.doesNotMatch(bench, /environment: convex-dev/);
  assert.equal(bench.match(/secrets\./g).length, 1);
  assert.match(bench, /persist-credentials: false/);
  assert.match(bench, /cancel-in-progress: false/);
  assert.match(bench, /compare\/\$REF\.\.\.main/);
  // The guard runs before the checkout and the deploy.
  assert(bench.indexOf('Refuse a commit that is not on main') < bench.indexOf('actions/checkout'));
});

// Execute only the audited deploy step with a fake npx; no deployment or package script runs.
function deployArgs(script) {
  const result = spawnSync('bash', ['-c', `npx() { printf '%s\\n' "$@"; }\n${script}`], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n');
}

test('dev CI completes guard-approved large-index removals without an interactive confirmation', () => {
  const command = workflow.match(/run: (npx --no-install convex deploy[^\n]+)/)[1];
  assert.deepEqual(deployArgs(command), [
    '--no-install',
    'convex',
    'deploy',
    '--typecheck',
    'enable',
    '--allow-deleting-large-indexes',
  ]);
});

test('bench large-index deletion is default-off and only the explicit true dispatch input enables it', () => {
  const bench = readFileSync('.github/workflows/convex-bench-deploy.yml', 'utf8');
  assert.match(
    bench,
    /allow_deleting_large_indexes:\n\s+description:[^\n]+\n\s+required: false\n\s+type: boolean\n\s+default: false/,
  );
  const script = bench
    .match(/Deploy functions and schema to the bench deployment\n\s+run: \|\n((?:          .*\n)+)/)[1]
    .replace(/^ {10}/gm, '');
  for (const value of ['', 'false', 'true']) {
    const args = deployArgs(script.replaceAll('${{ inputs.allow_deleting_large_indexes }}', value));
    assert.deepEqual(args, [
      '--no-install',
      'convex',
      'deploy',
      '--typecheck',
      'enable',
      ...(value === 'true' ? ['--allow-deleting-large-indexes'] : []),
    ]);
  }
});
