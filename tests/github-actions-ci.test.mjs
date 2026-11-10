// SPDX-License-Identifier: Apache-2.0
// Explicit Work runs write the check queue: a focused `node --test` run without the preload must still
// use a private HOME, or the real-user-state guard fails the run (friction c804f164).
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runActionsCheck } from '../scripts/github-actions-check.mjs';
import { githubActionsWorkflow } from '../dist/github-actions-workflow.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-actions-ci-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  return { root, write };
}

test('generated workflow starts static verification and test shards independently', () => {
  const workflow = githubActionsWorkflow('ubuntu-latest');
  assert.deepEqual(
    [...workflow.split('jobs:\n')[1].matchAll(/^  (\w+):/gm)].map(match => match[1]),
    ['shard', 'static'],
  );
  assert.doesNotMatch(workflow, /needs:|actions\/(?:upload|download)-artifact|forge-build/);
  assert.match(workflow, /if: \$\{\{ inputs.plan != '\[\]' \}\}/);
  assert.match(workflow, /fail-fast: false/);
  assert.equal((workflow.match(/run: node scripts\/forge-check.mjs/g) ?? []).length, 2);
  assert.doesNotMatch(workflow, /secrets\./);
});

for (const scope of ['partial', 'full'])
  test(`${scope} Actions selection builds in each job and preserves its test files`, t => {
    const { root, write } = fixture(t);
    const previous = {
      cwd: process.cwd(),
      plan: process.env.FORGE_ACTIONS_PLAN,
      shard: process.env.FORGE_ACTIONS_SHARD,
    };
    t.after(() => {
      process.chdir(previous.cwd);
      for (const [key, value] of [
        ['FORGE_ACTIONS_PLAN', previous.plan],
        ['FORGE_ACTIONS_SHARD', previous.shard],
      ])
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });
    const plan = {
      pin: 'a'.repeat(64),
      head: 'b'.repeat(64),
      standard: true,
      selection: { scope, reason: 'Fixture selection', tests: ['tests/a.test.mjs'] },
      groups: [['tests/a.test.mjs']],
    };
    write('plan.json', JSON.stringify(plan));
    process.chdir(root);
    process.env.FORGE_ACTIONS_PLAN = join(root, 'plan.json');
    const calls = [],
      execute = (command, args, options) => calls.push({ command, args, env: { ...options.env } });
    process.env.FORGE_ACTIONS_SHARD = '0';
    runActionsCheck(execute);
    assert.deepEqual(calls.at(-1).args, ['scripts/test-files.mjs', 'tests/a.test.mjs']);
    assert.equal(calls.at(-1).env.FORGE_TEST_COVERAGE_HEAD, scope === 'full' ? plan.head : undefined);
    assert.deepEqual(
      calls.slice(0, -1).map(call => call.args),
      [
        ['ci', '--ignore-scripts'],
        ['run', 'build:core'],
        ['run', 'build:web'],
      ],
    );
    calls.length = 0;
    process.env.FORGE_ACTIONS_SHARD = 'static';
    runActionsCheck(execute);
    assert.deepEqual(
      calls.map(call => call.args),
      [['ci', '--ignore-scripts'], ['scripts/verify.mjs']],
    );
    assert.deepEqual(JSON.parse(calls.at(-1).env.FORGE_SELECTED_TESTS), {
      ...plan.selection,
      tests: [],
    });
  });

test('arbitrary Actions commands get npm ci only in npm-locked projects', t => {
  const { root, write } = fixture(t);
  const previous = {
    cwd: process.cwd(),
    plan: process.env.FORGE_ACTIONS_PLAN,
    shard: process.env.FORGE_ACTIONS_SHARD,
  };
  t.after(() => {
    process.chdir(previous.cwd);
    for (const [key, value] of [
      ['FORGE_ACTIONS_PLAN', previous.plan],
      ['FORGE_ACTIONS_SHARD', previous.shard],
    ])
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  write('plan.json', JSON.stringify({ standard: false, command: ['bash', '.bench/ci.sh'], groups: [] }));
  process.chdir(root);
  process.env.FORGE_ACTIONS_PLAN = join(root, 'plan.json');
  process.env.FORGE_ACTIONS_SHARD = 'static';
  const calls = [],
    execute = (command, args) => calls.push([command, ...args]);
  write('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
  runActionsCheck(execute);
  assert.deepEqual(calls, [['bash', '.bench/ci.sh']]);
  calls.length = 0;
  write('package-lock.json', '{"lockfileVersion":3}');
  runActionsCheck(execute);
  assert.deepEqual(calls, [
    ['npm', 'ci', '--ignore-scripts'],
    ['bash', '.bench/ci.sh'],
  ]);
});

test('a docs-only plan for an arbitrary command runs no command and no install', t => {
  const { root, write } = fixture(t);
  const previous = {
    cwd: process.cwd(),
    plan: process.env.FORGE_ACTIONS_PLAN,
    shard: process.env.FORGE_ACTIONS_SHARD,
  };
  t.after(() => {
    process.chdir(previous.cwd);
    for (const [key, value] of [
      ['FORGE_ACTIONS_PLAN', previous.plan],
      ['FORGE_ACTIONS_SHARD', previous.shard],
    ])
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  write('package-lock.json', '{"lockfileVersion":3}');
  process.chdir(root);
  process.env.FORGE_ACTIONS_PLAN = join(root, 'plan.json');
  process.env.FORGE_ACTIONS_SHARD = 'static';
  const calls = [],
    execute = (command, args) => calls.push([command, ...args]);
  const plan = selection => ({ standard: false, command: ['bash', '.bench/ci.sh'], groups: [], selection });
  write(
    'plan.json',
    JSON.stringify(plan({ scope: 'docs', reason: 'Every changed path matches', tests: [] })),
  );
  runActionsCheck(execute);
  assert.deepEqual(calls, []);
  // Any other scope, or a plan with no selection, still runs the whole command.
  write('plan.json', JSON.stringify(plan({ scope: 'full', reason: 'Exact configured command', tests: [] })));
  runActionsCheck(execute);
  assert.deepEqual(calls, [
    ['npm', 'ci', '--ignore-scripts'],
    ['bash', '.bench/ci.sh'],
  ]);
});
