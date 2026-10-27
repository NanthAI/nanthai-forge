// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  contractProposal,
  confirmTestContract,
  candidateTestContract,
  intentTestContractSchema,
} from '../dist/intent-test-contract.js';
import { ContractTimingReader } from '../dist/contract-test-timings.js';
import { intentContractSelection } from '../dist/intent-contract-selection.js';
const a = 'tests/leaf.test.mjs',
  b = 'tests/extra.test.mjs',
  head = 'a'.repeat(64);
const input = overrides => ({
  command: { operationId: randomUUID(), runId: randomUUID(), expectedHead: head, expectedVersion: 0 },
  candidateId: randomUUID(),
  head,
  required: [a],
  available: [a, b],
  timings: { [a]: 1200, [b]: 800 },
  version: 0,
  request: 'b'.repeat(64),
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});
test('proposal uses real timings and explicitly reports unknown measurements', () => {
  assert.deepEqual(contractProposal([a, b], { [a]: 1234 }).missingTimings, [b]);
  assert.equal(contractProposal([a, b], { [a]: 1234 }).totalMs, null);
  assert.equal(contractProposal([a, b, a], { [a]: 1234, [b]: 500 }).totalMs, 1734);
});
test('confirm and edit retain proposed tests, exact source/run pins and contract versions', () => {
  const original = input(),
    first = confirmTestContract(original);
  assert.equal(first.totalMs, 1200);
  assert.equal(first.measuredOn, head);
  assert.equal(first.runId, original.command.runId);
  const edited = confirmTestContract({
    ...original,
    command: { ...original.command, expectedVersion: 1, tests: [b] },
    version: 1,
  });
  assert.equal(edited.version, 2);
  assert.deepEqual(
    edited.tests.map(t => t.path),
    [b],
  );
  assert.deepEqual(edited.proposedTests, [a]);
});
test('budget is strictly under 90 seconds and refusal includes measured time and slowest tests', () => {
  assert.equal(confirmTestContract(input({ timings: { [a]: 89999 } })).totalMs, 89999);
  assert.throws(
    () => confirmTestContract(input({ timings: { [a]: 90000 } })),
    e => e.code === 'CONTRACT_OVER_BUDGET' && /90000 ms/.test(e.message) && e.message.includes(a),
  );
  const original = input();
  assert.throws(
    () =>
      confirmTestContract({
        ...original,
        command: { ...original.command, tests: [a, b] },
        timings: { [a]: 50000, [b]: 80000 },
      }),
    e =>
      e.code === 'CONTRACT_OVER_BUDGET' &&
      /130000 ms/.test(e.message) &&
      e.message.indexOf(b) < e.message.indexOf(a),
  );
});
test('missing timing, stale source/version and absent tests cannot become confirmed measurements', () => {
  assert.throws(() => confirmTestContract(input({ timings: {} })), { code: 'CONTRACT_TIMING_MISSING' });
  const original = input();
  assert.throws(() => confirmTestContract({ ...original, head: 'c'.repeat(64) }), { code: 'VIEW_STALE' });
  assert.throws(() => confirmTestContract({ ...original, version: 1 }), { code: 'WORK_STALE' });
  assert.throws(
    () =>
      confirmTestContract({
        ...original,
        command: { ...original.command, tests: ['tests/missing.test.mjs'] },
      }),
    { code: 'BAD_ARGUMENT' },
  );
});
test('complete machine timing reports survive chunk boundaries; truncated or invalid reports remain unknown', () => {
  const parser = new ContractTimingReader(),
    line = '__FORGE_TESTS__' + JSON.stringify({ file: a, complete: true, durationMs: 1200 }) + '\n';
  parser.accept('2026-01-01T00:00:00.000Z ' + line.slice(0, 25));
  parser.accept(line.slice(25));
  parser.accept('__FORGE_TESTS__{"file":"tests/extra.test.mjs","complete":true,"durationMs":500}');
  assert.deepEqual(parser.timings, { [a]: 1200 });
  parser.accept('\n__FORGE_TESTS__{"file":"bad","complete":false,"durationMs":100}\n');
  parser.accept('__FORGE_TESTS__{"file":"zero","complete":true,"durationMs":0}\n');
  assert.equal(parser.timings[b], 500);
  assert.equal(parser.timings.bad, undefined);
  assert.equal(parser.timings.zero, undefined);
});
test('proposal includes newly added tests and the derived import impact set', () => {
  const files = new Map([
    ['src/leaf.ts', 'export const leaf = 1'],
    [a, "import '../dist/leaf.js';"],
    [b, "import 'node:assert';"],
    ['tests/new.test.mjs', "import 'node:assert';"],
  ]);
  const result = intentContractSelection(files, ['src/leaf.ts', 'tests/new.test.mjs']);
  assert.ok(result.tests.includes(a));
  assert.ok(result.tests.includes('tests/new.test.mjs'));
  assert.ok(!result.tests.includes(b));
});

test('review binds contracts to their Candidate/head and imported totals must match measured tests', () => {
  const contract = confirmTestContract(input());
  assert.deepEqual(
    candidateTestContract({ testContracts: [contract] }, contract.candidateId, head),
    contract,
  );
  assert.equal(candidateTestContract({ testContracts: [contract] }, randomUUID(), head), null);
  assert.equal(
    candidateTestContract({ testContracts: [contract] }, contract.candidateId, 'c'.repeat(64)),
    null,
  );
  assert.equal(intentTestContractSchema.safeParse({ ...contract, totalMs: 1 }).success, false);
});
