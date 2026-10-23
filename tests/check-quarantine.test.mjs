// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { testFlakeEvidence } from '../dist/check-flake-evidence.js';
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
  tests: [
    {
      test: name,
      verdict,
      ...(verdict === 'flake' ? { recovery: 'unchanged-source', evidenceRunId: 'supporting-run' } : {}),
    },
  ],
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

test('pass-after-fail names the recovered test without claiming a flake; missing, partial and foreign reports cannot exonerate failure', () => {
  assert.deepEqual(modalTestVerdicts(result(), groups).verdicts, [{ test: name, verdict: 'recovered' }]);
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
  // No prior evidence: a recovery is not an established flake or a clean check.
  const first = modalQuarantine(store, { id: randomUUID() }, result(), groups, at);
  const failure = modalQuarantine(store, { id: randomUUID() }, result(false), groups, at);
  assert.equal(failure.verdict, 'failed');
  assert.equal(failure.blocked, true);
  assert.deepEqual(failure.quarantine, []);
  assert.equal(first.verdict, 'recovered');
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

function evidenceFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-flake-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries({
    'src/synthetic.ts': 'export const value = 1;',
    'src/unrelated.ts': 'export const unrelated = 1;',
    'tests/synthetic.test.mjs': "import { value } from '../dist/synthetic.js';",
    'tests/unrelated.test.mjs': "import { unrelated } from '../dist/unrelated.js';",
  })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  const { head: base } = initNative(root);
  const store = new WorkStore(root),
    source = new NativeSource(root);
  const run = {
    id: randomUUID(),
    base,
    head: base,
    check: { definition: 'definition' },
    backend: { runtime: 'synthetic' },
  };
  const change = (file, text) => {
    writeFileSync(join(root, file), text);
    return source.writeState(
      source.capture(root, true),
      [base],
      'Synthetic change',
      new Date().toISOString(),
    );
  };
  const history = (verdict, head = base, recovery) => [
    {
      id: 'previous',
      at: '2026-01-01',
      source: { head, definition: 'definition', runtime: 'synthetic' },
      tests: [{ test: name, verdict, ...(recovery ? { recovery } : {}) }],
    },
  ];
  return { root, store, source, base, run, change, history };
}

test('one recovery on unchanged source is observed; a separate failure on the same bytes supports a flake', t => {
  const { store, run, history } = evidenceFixture(t);
  assert.deepEqual(testFlakeEvidence(store, run, []).recovery(name), {
    test: name,
    verdict: 'recovered',
    recovery: 'unchanged-source',
  });
  for (const verdict of ['failed', 'recovered']) {
    assert.deepEqual(testFlakeEvidence(store, run, history(verdict)).recovery(name), {
      test: name,
      verdict: 'flake',
      recovery: 'unchanged-source',
      evidenceRunId: 'previous',
    });
  }
  assert.equal(testFlakeEvidence(store, run, history('passed')).recovery(name).verdict, 'recovered');
  const otherDefinition = history('failed');
  otherDefinition[0].source.definition = 'different';
  assert.equal(testFlakeEvidence(store, run, otherDefinition).recovery(name).verdict, 'recovered');
  const otherRuntime = history('failed');
  otherRuntime[0].source.runtime = 'different';
  assert.equal(testFlakeEvidence(store, run, otherRuntime).recovery(name).verdict, 'recovered');
});

test('test or transitive source changes stay recovered, related change despite existing history', t => {
  for (const file of ['src/synthetic.ts', 'tests/synthetic.test.mjs']) {
    const { store, run, change, history } = evidenceFixture(t);
    run.head = change(file, file.startsWith('src/') ? 'export const value = 2;' : '// changed test');
    const evidence = testFlakeEvidence(store, run, history('recovered', run.head));
    assert.deepEqual(evidence.recovery(name), {
      test: name,
      verdict: 'recovered',
      recovery: 'related-change',
    });
    assert.equal(evidence.canQuarantine(name), false);
  }
});

test('repeated recoveries across unrelated source changes establish a flake', t => {
  const { store, run, change, history } = evidenceFixture(t);
  const first = change('src/unrelated.ts', 'export const unrelated = 2;');
  run.head = first;
  assert.deepEqual(testFlakeEvidence(store, run, []).recovery(name), {
    test: name,
    verdict: 'recovered',
    recovery: 'unrelated-change',
  });
  run.base = first;
  run.head = change('src/unrelated.ts', 'export const unrelated = 3;');
  assert.deepEqual(
    testFlakeEvidence(store, run, history('recovered', first, 'unrelated-change')).recovery(name),
    {
      test: name,
      verdict: 'flake',
      recovery: 'unrelated-change',
      evidenceRunId: 'previous',
    },
  );
  assert.equal(
    testFlakeEvidence(store, run, history('recovered', first, 'related-change')).recovery(name).verdict,
    'recovered',
  );
  assert.equal(
    testFlakeEvidence(store, run, history('recovered', first, 'unchanged-source')).recovery(name).verdict,
    'flake',
  );
});

test('unknown source or impact, related history and explicit fixes cannot establish flakiness', t => {
  const { store, run, change, history } = evidenceFixture(t);
  run.head = change('src/synthetic.ts', 'export const value = 2;');
  const relatedHead = run.head;
  run.base = relatedHead;
  run.head = change('src/unrelated.ts', 'export const unrelated = 2;');
  assert.equal(testFlakeEvidence(store, run, history('recovered')).recovery(name).verdict, 'recovered');
  run.base = '0'.repeat(64);
  assert.deepEqual(testFlakeEvidence(store, run, history('failed', run.head)).recovery(name), {
    test: name,
    verdict: 'recovered',
    recovery: 'unknown',
  });
  assert.equal(testFlakeEvidence(store, run, []).canQuarantine(name), false);
  run.base = run.head;
  const fixed = [
    ...history('failed', run.head),
    { id: 'fix', at: '2026-01-02', tests: [{ test: name, verdict: 'fixed' }] },
  ];
  assert.equal(testFlakeEvidence(store, run, fixed).recovery(name).verdict, 'recovered');
  run.head = change('unclassified.data', 'unknown impact');
  run.base = relatedHead;
  assert.equal(testFlakeEvidence(store, run, []).recovery(name).recovery, 'unknown');
});

test('recoveries and legacy flake labels cannot populate quarantine', () => {
  for (const verdict of ['recovered', 'flake']) {
    assert.deepEqual(
      quarantineLedger([
        { id: 'first', at: '2026-01-01', tests: [{ test: name, verdict }] },
        { id: 'second', at: '2026-01-02', tests: [{ test: name, verdict }] },
      ]),
      [],
    );
  }
});

test('a partial or foreign failed report cannot establish a named flake', () => {
  for (const change of [
    report => {
      report.complete = false;
    },
    report => {
      report.file = 'foreign';
    },
  ]) {
    const event = result();
    change(event.executions[0].tests['tests/synthetic.test.mjs']);
    const observed = modalTestVerdicts(event, groups);
    assert.deepEqual(observed.verdicts, [{ test: name, verdict: 'passed' }]);
    assert.equal(observed.unknownFailure, true);
  }
});

test('source-byte equality supports unchanged-source history across different State identities', t => {
  const { store, source, run, history } = evidenceFixture(t);
  run.head = source.writeState(
    source.state(run.base).files,
    [run.base],
    'Same bytes, new State',
    new Date().toISOString(),
  );
  assert.deepEqual(testFlakeEvidence(store, run, history('failed')).recovery(name), {
    test: name,
    verdict: 'flake',
    recovery: 'unchanged-source',
    evidenceRunId: 'previous',
  });
});

test('clean check receipts do not read source impact evidence', t => {
  const { store, run } = evidenceFixture(t);
  let reads = 0;
  t.mock.method(NativeSource.prototype, 'state', () => {
    reads++;
    throw new Error('Unexpected source read');
  });
  const event = result();
  event.executions = [event.executions[1], { ...event.executions[2], attempt: 0 }];
  const assessment = modalQuarantine(store, run, event, groups, new Date().toISOString());
  assert.equal(assessment.blocked, false);
  assert.equal(assessment.verdict, 'clean');
  assert.equal(reads, 0);
});
