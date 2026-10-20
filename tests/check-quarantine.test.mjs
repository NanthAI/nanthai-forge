// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import {
  quarantineLedger,
  modalTestVerdicts,
  modalQuarantine,
  checkQuarantine,
  fixQuarantinedTest,
} from '../dist/check-quarantine.js';
const name = 'tests/synthetic.test.mjs :: intermittent result';
const observation = (id, day, verdict) => ({
  id,
  at: new Date(Date.UTC(2026, 0, day)).toISOString(),
  tests: [{ test: name, verdict }],
});

test('two flakes within seven days quarantine; duplicate replay and older flakes do not count', () => {
  const first = observation('first', 1, 'flake');
  assert.deepEqual(quarantineLedger([first, first]), []);
  assert.deepEqual(quarantineLedger([first, observation('second', 9, 'flake')]), []);
  assert.deepEqual(quarantineLedger([first, observation('second', 8, 'flake')]), [
    { test: name, consecutivePasses: 0 },
  ]);
});

test('quarantine requires twenty consecutive passes or an explicit fix, failures reset the streak', () => {
  const flakes = [observation('first', 1, 'flake'), observation('second', 2, 'flake')];
  const passes = Array.from({ length: 20 }, (_, i) => observation(`pass-${i}`, i + 3, 'passed'));
  assert.equal(quarantineLedger([...flakes, ...passes.slice(0, 19)])[0].consecutivePasses, 19);
  assert.deepEqual(quarantineLedger([...flakes, ...passes]), []);
  assert.equal(
    quarantineLedger([
      ...flakes,
      ...passes.slice(0, 10),
      observation('fail', 13, 'failed'),
      ...passes.slice(11),
    ]).length,
    1,
  );
  assert.deepEqual(quarantineLedger([...flakes, observation('fix', 3, 'fixed')]), []);
  assert.deepEqual(
    quarantineLedger([...flakes, observation('fix', 3, 'fixed'), observation('new-flake', 4, 'flake')]),
    [],
  );
});

const report = passed => ({
  'tests/synthetic.test.mjs': {
    file: 'tests/synthetic.test.mjs',
    complete: true,
    results: [{ name: 'intermittent result', passed }],
  },
});
const result = (passed = true) => ({
  kind: 'result',
  pin: 'synthetic',
  head: 'head',
  definition: 'definition',
  exitCode: passed ? 0 : 1,
  estimatedCostUsd: 0,
  executions: [
    { executionId: 'first', index: 0, attempt: 0, exitCode: 1, tests: report(false) },
    { executionId: 'static', index: 1, attempt: 0, exitCode: 0 },
    { executionId: 'retry', index: 0, attempt: 1, exitCode: passed ? 0 : 1, tests: report(passed) },
  ],
});
const groups = [['tests/synthetic.test.mjs']];

test('pass-after-fail names the test and records a flake; missing, partial and foreign reports cannot exonerate failure', () => {
  assert.deepEqual(modalTestVerdicts(result(), groups).verdicts, [{ test: name, verdict: 'flake' }]);
  for (const change of [
    event => {
      delete event.executions[2].tests;
    },
    event => {
      event.executions[2].tests['tests/synthetic.test.mjs'].complete = false;
    },
    event => {
      event.executions[2].tests['tests/synthetic.test.mjs'].file = 'unselected';
    },
  ]) {
    const event = result();
    change(event);
    assert.equal(modalTestVerdicts(event, groups).unknownFailure, true);
    assert.equal(modalTestVerdicts(event, groups).recoveredFailure, true);
  }
});

test('only named quarantined failures become nonblocking, static and unrelated failures still block', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-quarantine-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'synthetic.txt'), 'fixture');
  initNative(root);
  const store = new WorkStore(root);
  const at = new Date().toISOString();
  // No prior verdicts: a flake is not a clean passing check.
  const first = modalQuarantine(store, { id: randomUUID() }, result(), groups, at);
  const failure = modalQuarantine(store, { id: randomUUID() }, result(false), groups, at);
  assert.equal(failure.verdict, 'failed');
  assert.equal(failure.blocked, true);
  assert.deepEqual(failure.quarantine, []);
  assert.equal(first.verdict, 'flake');
  assert.equal(first.blocked, true);
  assert.deepEqual(checkQuarantine(store), { needsYou: [] });
  const operationId = randomUUID();
  assert.equal(fixQuarantinedTest(store, operationId, name).test, name);
  assert.deepEqual(fixQuarantinedTest(store, operationId, name).needsYou, []);
  assert.throws(
    () => fixQuarantinedTest(store, operationId, 'different test'),
    error => error.code === 'EVIDENCE_CHANGED',
  );
});

test('quarantine receipts feed Needs you and an empty later snapshot clears attention', async () => {
  const { moduleUrl } = await import('./convex-module.mjs');
  const { quarantineDecisions } = await import(moduleUrl('../web/src/cockpit/attention.ts'));
  const old = {
    id: 'old',
    viewId: 'view',
    status: 'passed',
    endedAt: '2026-01-01',
    checkQuarantine: [{ test: name, consecutivePasses: 19 }],
  };
  const items = quarantineDecisions([old]);
  assert.equal(items.length, 1);
  assert.match(items[0].title, /intermittent result/);
  assert.match(items[0].body, /19\/20/);
  assert.deepEqual(
    quarantineDecisions([old, { ...old, id: 'new', endedAt: '2026-01-02', checkQuarantine: [] }]),
    [],
  );
});
