// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertCheckContract,
  CHECK_CONTRACT_ENV,
  CHECK_CONTRACT_PROVIDED,
  CHECK_CONTRACT_REQUIRED,
  CHECK_CONTRACT_SURFACE_DIGEST,
  declaredRequirement,
  surfaceDigest,
} from '../scripts/check-contract.mjs';
import { runActionsCheck } from '../scripts/github-actions-check.mjs';

const repo = process.cwd();
const mismatch = { code: 'CHECK_CONTRACT_MISMATCH' };
const contractSource = required =>
  readFileSync(join(repo, 'scripts/check-contract.mjs'), 'utf8').replace(
    /^export const CHECK_CONTRACT_REQUIRED = \d+;/m,
    `export const CHECK_CONTRACT_REQUIRED = ${required};`,
  );

test('the guard compares what the executor provides with what the scripts require', () => {
  const plan = { FORGE_ACTIONS_PLAN: 'plan.json' };
  assert.doesNotThrow(() => assertCheckContract({ ...plan, [CHECK_CONTRACT_ENV]: '2' }, 2));
  assert.doesNotThrow(() => assertCheckContract({ ...plan, [CHECK_CONTRACT_ENV]: '3' }, 2));
  assert.throws(() => assertCheckContract({ ...plan, [CHECK_CONTRACT_ENV]: '1' }, 2), mismatch);
  // An Actions plan without the variable means an executor older than the contract.
  assert.doesNotThrow(() => assertCheckContract(plan, 0));
  assert.throws(() => assertCheckContract(plan, 1), /provides 0/);
  assert.throws(() => assertCheckContract({ ...plan, [CHECK_CONTRACT_ENV]: 'x' }, 1), /invalid value/);
  // A direct local run has no executor and nothing to disagree with.
  assert.doesNotThrow(() => assertCheckContract({}, 9));
  try {
    assertCheckContract({ ...plan, [CHECK_CONTRACT_ENV]: '1' }, 2);
  } catch (error) {
    assert.match(error.message, /No test was run\. Land the executor change on its own first/);
  }
});

test('this tree is consistent: it never requires more than its own executor provides', () => {
  assert.ok(Number.isInteger(CHECK_CONTRACT_REQUIRED) && CHECK_CONTRACT_REQUIRED >= 0);
  assert.ok(CHECK_CONTRACT_REQUIRED <= CHECK_CONTRACT_PROVIDED);
  assert.equal(declaredRequirement(repo), CHECK_CONTRACT_REQUIRED);
});

function fixture(t, required) {
  const root = mkdtempSync(join(tmpdir(), 'forge-check-contract-'));
  const previous = {
    cwd: repo,
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
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  if (required !== undefined)
    writeFileSync(join(root, 'scripts/check-contract.mjs'), contractSource(required));
  writeFileSync(join(root, 'tests/a.test.mjs'), '');
  writeFileSync(
    join(root, 'plan.json'),
    JSON.stringify({
      standard: true,
      pin: 'a'.repeat(64),
      head: 'b'.repeat(64),
      selection: { scope: 'scoped', reason: 'Fixture', tests: ['tests/a.test.mjs'] },
      groups: [['tests/a.test.mjs']],
    }),
  );
  process.chdir(root);
  process.env.FORGE_ACTIONS_PLAN = join(root, 'plan.json');
  return root;
}

test('a Candidate whose scripts need a newer contract than the executor provides fails before install, build or tests', t => {
  const next = CHECK_CONTRACT_PROVIDED + 1;
  fixture(t, next);
  const calls = [];
  for (const shard of ['static', '0']) {
    process.env.FORGE_ACTIONS_SHARD = shard;
    assert.throws(
      () => runActionsCheck((command, args) => calls.push([command, ...args])),
      error =>
        error.code === 'CHECK_CONTRACT_MISMATCH' &&
        error.message.includes(`require check contract ${next}`) &&
        error.message.includes(`provides ${CHECK_CONTRACT_PROVIDED}`),
    );
  }
  assert.deepEqual(calls, [], 'no npm ci, build, verify or test process was started');
});

test('a Candidate that needs no newer contract, or declares none, runs normally and gets the contract env', t => {
  for (const required of [CHECK_CONTRACT_PROVIDED, 0, undefined]) {
    fixture(t, required);
    process.env.FORGE_ACTIONS_SHARD = 'static';
    const calls = [];
    runActionsCheck((command, args, options) => calls.push({ args, env: options.env }), {
      install: false,
    });
    assert.deepEqual(
      calls.map(call => call.args),
      [['scripts/verify.mjs']],
    );
    assert.equal(calls[0].env[CHECK_CONTRACT_ENV], String(CHECK_CONTRACT_PROVIDED));
  }
});

test('the Candidate declaration is read as data and is never executed', t => {
  const root = fixture(t, 0);
  writeFileSync(
    join(root, 'scripts/check-contract.mjs'),
    "process.exit(77);\nexport const CHECK_CONTRACT_REQUIRED = 0;\nthrow new Error('executed');\n",
  );
  assert.equal(declaredRequirement(root), 0);
  writeFileSync(join(root, 'scripts/check-contract.mjs'), 'garbage');
  assert.equal(declaredRequirement(root), undefined);
});

test('verify.mjs run by an executor older than the contract refuses a newer requirement in seconds', t => {
  const root = fixture(t, CHECK_CONTRACT_PROVIDED + 1);
  for (const name of [
    'verify.mjs',
    'verify-queue.mjs',
    'verify-failure-digest.mjs',
    'selection-guard.mjs',
    'prepare-convex-api.mjs',
  ])
    copyFileSync(join(repo, 'scripts', name), join(root, 'scripts', name));
  mkdirSync(join(root, 'convex'), { recursive: true });
  writeFileSync(join(root, 'scripts/test-files.mjs'), 'export const fileTimeout = () => 1000;');
  writeFileSync(join(root, 'tests/worker-budget.mjs'), 'export const workerBudget = () => 2;');
  const env = { ...process.env, FORGE_ACTIONS_SHARD: 'static' };
  delete env[CHECK_CONTRACT_ENV];
  const started = Date.now();
  const result = spawnSync(process.execPath, ['scripts/verify.mjs'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CHECK_CONTRACT_MISMATCH.*provides 0/s);
  assert.doesNotMatch(result.stdout, /Verification:/);
  assert.ok(Date.now() - started < 20_000);
  // The same tree under an executor that provides enough starts verification (no mismatch).
  const ok = spawnSync(process.execPath, ['scripts/verify.mjs'], {
    cwd: root,
    env: { ...env, [CHECK_CONTRACT_ENV]: String(CHECK_CONTRACT_PROVIDED + 1), FORGE_STATIC_WORKERS: '1' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.doesNotMatch(ok.stderr, /CHECK_CONTRACT_MISMATCH/);
  assert.match(ok.stdout, /Verification:/);
});

// Build-failing guard: the observable surface of the executor (commands and the environment it sets)
// is what check scripts depend on. Changing it without raising PROVIDED fails here, with the fix named.
function executorSurface(t) {
  const names = Object.keys(process.env).filter(name => /^FORGE_/.test(name));
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  t.after(() => Object.assign(process.env, saved));
  const surface = {};
  // Values that depend on the plan or machine are recorded as keys only.
  const variable = new Set([
    'FORGE_SELECTED_TESTS',
    'FORGE_ACTIONS_PLAN',
    'FORGE_TEST_RETRY_FILES',
    'FORGE_TEST_COVERAGE_HEAD',
    'FORGE_JUNIT_DIR',
  ]);
  // Contract 3: the fixed supervisor's private JUnit report directory reaches the check.
  process.env.FORGE_JUNIT_DIR = '/private/junit';
  for (const [mode, shard, selection, groups, standard, part] of [
    [
      'standard-static',
      'static',
      { scope: 'scoped', reason: 'x', tests: ['tests/a.test.mjs'] },
      [['tests/a.test.mjs']],
      true,
    ],
    [
      'standard-shard',
      '0',
      { scope: 'full', reason: 'x', tests: ['tests/a.test.mjs'] },
      [['tests/a.test.mjs']],
      true,
    ],
    ['docs-static', 'static', { scope: 'docs', reason: 'x', tests: [] }, [], true],
    ['command', 'static', { scope: 'full', reason: 'x', tests: [] }, [], false],
    // Contract 2: shard pool parts (kept front, then one unit with tests only).
    ...['kept', '0'].map(part => [
      `standard-shard-pool-${part}`,
      '0',
      { scope: 'full', reason: 'x', tests: ['tests/a.test.mjs', 'tests/b.test.mjs'] },
      [['tests/a.test.mjs', 'tests/b.test.mjs']],
      true,
      part,
    ]),
  ]) {
    const root = fixture(t, undefined);
    writeFileSync(
      join(root, 'plan.json'),
      JSON.stringify({
        standard,
        command: ['bash', 'ci.sh'],
        pin: 'a',
        head: 'b',
        selection,
        groups,
        ...(part ? { pool: [[1]] } : {}),
      }),
    );
    process.env.FORGE_ACTIONS_SHARD = shard;
    if (part) process.env.FORGE_ACTIONS_POOL_PART = part;
    else delete process.env.FORGE_ACTIONS_POOL_PART;
    const calls = [];
    try {
      runActionsCheck((command, args, options) => {
        const env = Object.fromEntries(
          Object.entries(options.env)
            .filter(([name]) => /^FORGE_|^NODE_OPTIONS$/.test(name))
            .map(([name, value]) => [name, variable.has(name) ? null : value])
            .sort(([a], [b]) => (a < b ? -1 : 1)),
        );
        calls.push({ command: command === process.execPath ? 'node' : command, args, env });
      });
    } catch (error) {
      if (mode !== 'docs-static') throw error;
    }
    surface[mode] = calls;
  }
  delete process.env.FORGE_ACTIONS_POOL_PART;
  delete process.env.FORGE_JUNIT_DIR;
  return surface;
}

test('the executor surface matches the digest recorded for the contract version it provides', t => {
  const surface = executorSurface(t);
  assert.equal(
    surfaceDigest(surface),
    CHECK_CONTRACT_SURFACE_DIGEST,
    'The executor changed what it runs or sets for check scripts. Raise CHECK_CONTRACT_PROVIDED and set CHECK_CONTRACT_SURFACE_DIGEST to ' +
      surfaceDigest(surface) +
      ' in scripts/check-contract.mjs, and do not depend on the change in check scripts in the same Lane (see the header there).',
  );
});

test('the control executor run against a fixture Candidate names the mismatch on stderr and starts nothing', t => {
  const root = fixture(t, CHECK_CONTRACT_PROVIDED + 1);
  const result = spawnSync(process.execPath, [join(repo, 'scripts/hosted-actions-execute.mjs')], {
    cwd: root,
    env: { ...process.env, FORGE_ACTIONS_PLAN: join(root, 'plan.json'), FORGE_ACTIONS_SHARD: 'static' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /CHECK_CONTRACT_MISMATCH: this Candidate's check scripts require check contract/,
  );
  assert.doesNotMatch(result.stdout + result.stderr, /npm|added \d+ packages|Verification:/);
});
