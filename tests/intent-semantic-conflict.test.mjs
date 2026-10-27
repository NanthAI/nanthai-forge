import { canonicalPayload } from '../dist/hosted-source-operation.js';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { semanticVerdict, semanticTests, semanticConflictMessage } from '../dist/intent-semantic-conflict.js';
import { semanticPayload } from '../dist/semantic-payload.js';
import { semanticPlanSchema } from '../dist/intent-semantic-conflict.js';
import { semanticCheckCommand } from '../dist/semantic-check-command.js';
import { ContractTimingReader } from '../dist/contract-test-timings.js';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { standardSelection } from '../scripts/test-impact.mjs';

export const pair = (outcome = 'Synthetic own', tests = ['tests/prove.test.mjs']) => {
  const primaryIntentId = randomUUID();
  return {
    primaryIntentId,
    members: [primaryIntentId, randomUUID()].map((intentId, i) => ({
      intentId,
      outcome: i ? 'Synthetic peer' : outcome,
      version: 1,
      tests: tests.map(path => ({ path, durationMs: 10 })),
    })),
  };
};
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
const pins = () => ({ candidateId: randomUUID(), head: 'a'.repeat(64), runId: randomUUID() });

// Synthetic reductions of the four clashes in the read-only Phase 3 corpus.
const fixtures = [
  {
    name: 'duplicate import',
    base: "import {readFile} from 'node:fs';\n\nexport const value = 1;\n\nexport const other = 2;\n",
    left: "import {readFile,writeFile} from 'node:fs';\n\nexport const value = 1;\n\nexport const other = 2;\n",
    right:
      "import {readFile} from 'node:fs';\n\nexport const value = 1;\n\nimport {writeFile} from 'node:fs';\nexport const other = 2;\n",
    assertion: 'assert.equal(value,1)',
  },
  {
    name: 'cleanup helper',
    base: 'export const helper = arg => arg === undefined ? 1 : 2;\n\nexport const value = helper();\n',
    left: 'export const helper = arg => arg === undefined ? 1 : 0;\n\nexport const value = helper();\n',
    right: 'export const helper = arg => arg === undefined ? 1 : 2;\n\nexport const value = helper(true);\n',
    assertion: 'assert.ok(value>0)',
  },
  {
    name: 'batching default',
    base: 'export const checks = undefined;\n\nexport const value = checks?.batch ?? false;\n',
    left: 'export const checks = {};\n\nexport const value = checks?.batch ?? false;\n',
    right: 'export const checks = undefined;\n\nexport const value = checks !== undefined;\n',
    assertion: 'assert.equal(value,false)',
  },
  {
    name: 'OOM verdict',
    base: 'export const memory = 8;\n\nexport const value = memory >= 8;\n',
    left: 'export const memory = 16;\n\nexport const value = memory >= 8;\n',
    right: 'export const memory = 8;\n\nexport const value = memory === 8;\n',
    assertion: 'assert.equal(value,true)',
  },
];
for (const fixture of fixtures)
  test(`clean source merge replays ${fixture.name} as a named contract conflict`, () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-semantic-replay-'));
    try {
      initNative(root);
      const source = new NativeSource(root),
        at = '2026-01-01T00:00:00.000Z';
      const testSource = `import test from 'node:test';import assert from 'node:assert/strict';import {value} from '../model.mjs';test('contract',()=>{${fixture.assertion}});`;
      const state = (text, parents) =>
        source.writeState(
          [
            { path: 'model.mjs', mode: 'file', blob: source.put(Buffer.from(text)) },
            { path: 'tests/prove.test.mjs', mode: 'file', blob: source.put(Buffer.from(testSource)) },
          ],
          parents,
          'Synthetic',
          at,
        );
      const base = state(fixture.base, []),
        left = state(fixture.left, [base]),
        right = state(fixture.right, [base]);
      const merged = source.compose(left, right, 'Synthetic pair', at);
      assert(merged.head, 'the real source composer merged the edits cleanly');
      const run = head => {
        const directory = join(root, randomUUID());
        source.materialize(head, directory, false);
        const plan = pair(fixture.name);
        const command = semanticCheckCommand([process.execPath, '-e', ''], plan, process.execPath);
        const result = spawnSync(command[0], command.slice(1), {
          cwd: directory,
          encoding: 'utf8',
          env: childEnv,
        });
        const reader = new ContractTimingReader();
        reader.accept(result.stdout);
        return { result, verdict: semanticVerdict(plan, reader.reports, { ...pins(), head }) };
      };
      assert.equal(run(left).result.status, 0, 'left contract passes alone');
      assert.equal(run(right).result.status, 0, 'right contract passes alone');
      const { result, verdict } = run(merged.head);
      assert.equal(
        result.status,
        1,
        result.stdout +
          result.stderr +
          source
            .object(source.state(merged.head).files.find(file => file.path === 'model.mjs').blob)
            .toString(),
      );
      assert.equal(verdict.conflicts.length, 1);
      assert.equal(verdict.conflicts[0].intents.length, 2);
      assert.match(semanticConflictMessage(verdict.conflicts), new RegExp(fixture.name));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test('complete clean evidence raises nothing; missing evidence and contract-less pairs keep existing behavior', () => {
  const plan = pair();
  assert.deepEqual(
    semanticVerdict(plan, { 'tests/prove.test.mjs': { durationMs: 5, failed: false } }, pins()).conflicts,
    [],
  );
  assert.deepEqual(semanticVerdict(plan, {}, pins()).conflicts, []);
  assert.deepEqual(semanticVerdict(undefined, {}, pins()).conflicts, []);
  assert.deepEqual(semanticCheckCommand(['node', 'custom']), ['node', 'custom']);
});

test('measured union deduplicates files and refuses the B2.1 budget without blaming a pair', () => {
  const plan = pair();
  assert.deepEqual(semanticTests(plan), ['tests/prove.test.mjs']);
  plan.members[0].tests[0].durationMs = 50_000;
  plan.members[1].tests[0].durationMs = 50_000;
  assert.equal(
    semanticVerdict(plan, { 'tests/prove.test.mjs': { durationMs: 50_000, failed: false } }, pins())
      .overBudget,
    undefined,
  );
  const verdict = semanticVerdict(
    plan,
    { 'tests/prove.test.mjs': { durationMs: 90_001, failed: true } },
    pins(),
  );
  assert.equal(verdict.overBudget.measuredMs, 90_001);
  assert.deepEqual(verdict.conflicts, []);
  plan.members[0].tests.push({ path: 'tests/extra.test.mjs', durationMs: 50_000 });
  assert.doesNotThrow(
    () => semanticCheckCommand(['node', 'custom'], plan),
    'old measurements cannot refuse a new composed source before it runs',
  );
});

test('already checked union never launches the same test again; extra generic failure is not a semantic conflict', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-semantic-reuse-'));
  try {
    const plan = pair();
    const report = {
      file: 'tests/prove.test.mjs',
      complete: true,
      durationMs: 1,
      results: [{ passed: true }],
    };
    const original = [
      process.execPath,
      '-e',
      `console.log(${JSON.stringify('__FORGE_TESTS__' + JSON.stringify(report))});process.exitCode=1`,
    ];
    const command = semanticCheckCommand(original, plan, process.execPath);
    const result = spawnSync(command[0], command.slice(1), { cwd: root, encoding: 'utf8', env: childEnv });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /Could not find|not ok/);
    assert.equal(result.stdout.split('__FORGE_TESTS__').length - 1, 1);
    const reader = new ContractTimingReader();
    reader.accept(result.stdout);
    assert.deepEqual(semanticVerdict(plan, reader.reports, pins()).conflicts, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scoped and documentation selection include the contract union once', () => {
  const tests = ['tests/peer.test.mjs', 'tests/own.test.mjs'];
  const files = new Map(tests.map(path => [path, '']));
  const result = standardSelection({
    files,
    paths: ['docs/example.md'],
    semanticTests: [...tests, tests[0]],
    env: { FORGE_CHECK_SCOPED: '1' },
  });
  assert.equal(result.scope, 'scoped');
  assert.deepEqual(result.tests, [...tests].sort());
  assert.throws(
    () => standardSelection({ files, paths: ['docs/example.md'], semanticTests: ['tests/missing.test.mjs'] }),
    /absent/,
  );
});

test('accepted history predating the Intent base does not expand its contract union', () => {
  const plan = pair();
  plan.afterSequence = 5;
  plan.members[1].acceptedSequence = 5;
  assert.deepEqual(semanticTests(plan), []);
  assert.deepEqual(
    semanticVerdict(plan, { 'tests/prove.test.mjs': { durationMs: 1, failed: true } }, pins()).conflicts,
    [],
  );
  plan.members[1].acceptedSequence = 6;
  assert.deepEqual(semanticTests(plan), ['tests/prove.test.mjs']);
  assert.deepEqual(semanticCheckCommand(['node', 'custom'], plan, 'node', ['tests/prove.test.mjs']), [
    'node',
    'custom',
  ]);
});

test('hosted path dictionary preserves exact measurements and rejects invalid references', () => {
  const plan = pair();
  plan.members[0].tests[0].durationMs = 1.23456789;
  const encoded = semanticPayload({ semanticPlan: plan });
  const compact = JSON.parse(encoded).semanticPlan;
  assert.equal(compact.paths.length, 1);
  assert.deepEqual(semanticPlanSchema.parse(compact), plan);
  compact.members[0].tests[0][0] = 1;
  assert.equal(semanticPlanSchema.safeParse(compact).success, false);
  assert.equal(semanticPayload({ a: 1 }), '{"a":1}');
});

test('semantic storage keeps canonical JSON bytes and rejects unsupported nested values', () => {
  const value = { z: [1.23456789, null, true, 'quoted " \u2028'], a: { b: -0, a: 'first' } };
  assert.equal(canonicalPayload(value, true), canonicalPayload(value));
  for (const invalid of [undefined, NaN, Infinity, 1n, () => 0, new Date()]) {
    assert.throws(() => semanticPayload({ nested: [invalid] }));
  }
});

test('a complete failed union report cannot be overridden by a zero command exit', () => {
  const plan = pair();
  const report = {
    file: 'tests/prove.test.mjs',
    complete: true,
    durationMs: 1,
    results: [{ passed: false }],
  };
  const command = semanticCheckCommand(
    [process.execPath, '-e', `console.log(${JSON.stringify('__FORGE_TESTS__' + JSON.stringify(report))})`],
    plan,
    process.execPath,
  );
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', env: childEnv });
  assert.equal(result.status, 1);
});
