// SPDX-License-Identifier: Apache-2.0
// Forge's own check is one predicate; its settings and extra inputs never reach other projects.
// The literal guard for the whole product is tests/forge-only-rules.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { isStandardForgeCheck } from '../dist/standard-check.js';
import {
  checkEntryPaths,
  firstCheckRisk,
  firstCheckRiskPaths,
  sharedSequenceFolders,
} from '../dist/first-check-risk.js';
import { runActionsCheck } from '../scripts/github-actions-check.mjs';

const forgeCheck = { executable: 'node', args: ['scripts/forge-check.mjs'] };
const benchCheck = { executable: 'bash', args: ['.bench/ci.sh'] };
const forgeEnv = [
  'NODE_OPTIONS',
  'FORGE_TEST_WORKERS',
  'FORGE_MAX_CONCURRENT_CHECKS',
  'FORGE_TEST_EVENTS',
  'FORGE_STATIC_WORKERS',
  'FORGE_GIT_TIMEOUT_MS',
];

test('one predicate names Forge standard check and nothing else', () => {
  for (const executable of ['node', '/usr/local/bin/node'])
    assert.equal(isStandardForgeCheck({ ...forgeCheck, executable }), true, executable);
  assert.equal(isStandardForgeCheck({ ...forgeCheck, executable: '/opt/n24' }, '/opt/n24'), true);
  for (const check of [
    benchCheck,
    { executable: '/opt/n24', args: ['scripts/forge-check.mjs'] },
    { executable: 'bun', args: ['scripts/forge-check.mjs'] },
    { executable: 'node', args: ['scripts/forge-check.mjs', '--full'] },
    { executable: 'node', args: ['scripts/test-cached.ts'] },
    { executable: 'nodejs', args: ['scripts/forge-check.mjs'] },
  ])
    assert.equal(isStandardForgeCheck(check), false, JSON.stringify(check));
});

function actionsRun(t, plan, { npmLocked = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-standard-env-'));
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
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  writeFileSync(join(root, 'plan.json'), JSON.stringify(plan));
  if (npmLocked) writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  process.chdir(root);
  process.env.FORGE_ACTIONS_PLAN = join(root, 'plan.json');
  return shard => {
    process.env.FORGE_ACTIONS_SHARD = shard;
    const calls = [];
    runActionsCheck((command, args, options) => calls.push({ command, args, env: options.env }));
    return calls;
  };
}

test('a configured non-Forge command and its install get no Forge environment', t => {
  const run = actionsRun(
    t,
    { standard: false, command: ['bash', '.bench/ci.sh'], groups: [] },
    { npmLocked: true },
  );
  const calls = run('static');
  assert.deepEqual(
    calls.map(call => [call.command, ...call.args]),
    [
      ['npm', 'ci', '--ignore-scripts'],
      ['bash', '.bench/ci.sh'],
    ],
  );
  for (const call of calls) for (const name of forgeEnv) assert.equal(call.env[name], undefined, name);
});

test('Forge standard check keeps its suite environment on static and shard jobs', t => {
  const run = actionsRun(t, {
    standard: true,
    pin: 'a'.repeat(64),
    head: 'b'.repeat(64),
    selection: { scope: 'scoped', reason: 'Fixture', tests: ['tests/a.test.mjs'] },
    groups: [['tests/a.test.mjs']],
  });
  for (const shard of ['static', '0']) {
    const calls = run(shard);
    assert(calls.length > 1, shard);
    for (const call of calls) {
      assert.equal(call.env.NODE_OPTIONS, '--max-old-space-size=3072', shard);
      assert.equal(call.env.FORGE_TEST_WORKERS, '2', shard);
      assert.equal(call.env.FORGE_STATIC_WORKERS, '2', shard);
    }
  }
});

// The list Forge's check had as a global rule for every repository (first-check-risk-v1).
const previousForgeRule =
  /^(?:scripts\/(?:forge-check|verify|verify-queue|github-actions-check|check-contract|check-path-scopes|check-foundation|test-[^/]+)\.(?:[cm]?[jt]s|d\.m?ts)|tests\/(?:check-runtime|worker-budget)\.mjs)$/;
const samplePaths = [
  ...['forge-check', 'verify', 'verify-queue', 'github-actions-check', 'check-contract']
    .concat(['check-path-scopes', 'check-foundation', 'test-files', 'test-cached', 'test-impact.lib'])
    .flatMap(name =>
      ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts', 'd.ts', 'd.mts', 'json', 'sh'].map(
        ext => `scripts/${name}.${ext}`,
      ),
    ),
  'scripts/sub/test-a.mjs',
  'scripts/verify2.mjs',
  'scripts/test.mjs',
  'tools/scripts/verify.mjs',
  'tests/check-runtime.mjs',
  'tests/worker-budget.mjs',
  'tests/check-runtime.ts',
  'tests/worker-budget.test.mjs',
  'src/a.ts',
];

test('Forge own check inputs are global-risk exactly as before, for its check only', () => {
  const entries = checkEntryPaths(forgeCheck);
  for (const path of samplePaths) {
    const was = previousForgeRule.test(path);
    assert.equal(firstCheckRisk(path, entries) !== null, was, path);
  }
  assert.deepEqual(
    firstCheckRiskPaths(['scripts/test-files.mjs', 'src/a.ts', 'tests/check-runtime.mjs'], entries),
    ['scripts/test-files.mjs', 'tests/check-runtime.mjs'],
  );
});

test("Forge's own files keep their v1 decisions under first-check-risk-v2", () => {
  const entries = checkEntryPaths(forgeCheck);
  const own = ['src', 'tests', 'scripts', 'docs', 'convex', 'web/src', 'evals', 'skills', 'models'].flatMap(
    dir =>
      existsSync(dir)
        ? readdirSync(dir, { recursive: true }).map(path => `${dir}/${path}`.split(sep).join('/'))
        : [],
  );
  assert(own.length > 500, 'walked the repository');
  for (const path of [...own, ...samplePaths, 'package.json', 'web/package.json'])
    assert.equal(
      firstCheckRisk(path, entries, 'first-check-risk-v2'),
      firstCheckRisk(path, entries, 'first-check-risk-v1'),
      path,
    );
  assert.equal(sharedSequenceFolders(own, own).length, 0, 'no sequence folder in Forge');
});

test('a non-Forge repository keeps its own scripts/test-*.ts reusable', () => {
  const entries = checkEntryPaths(benchCheck);
  assert.deepEqual(entries, ['.bench/ci.sh']);
  for (const path of [
    'scripts/test-cached.ts',
    'scripts/verify.mjs',
    'scripts/forge-check.mjs',
    'scripts/check-contract.ts',
    'tests/check-runtime.mjs',
  ]) {
    assert.equal(firstCheckRisk(path, entries), null, path);
    assert.equal(firstCheckRisk(path), null, path);
  }
  assert.equal(firstCheckRisk('.bench/ci.sh', entries), 'check script or check contract');
  // Forge's Actions executor reads this file from every Candidate, so it stays global.
  assert.equal(firstCheckRisk('scripts/check-contract.mjs', entries), 'check script or check contract');
});
