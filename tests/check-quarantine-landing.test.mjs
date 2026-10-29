// SPDX-License-Identifier: Apache-2.0
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { checkEnvironment } from '../dist/check-environment.js';
import { checkQuarantineResult, checkQuarantine, fixQuarantinedTest } from '../dist/check-quarantine.js';
import { quarantineHistory, quarantineList } from '../dist/check-quarantine-history.js';
import { nativeQuarantine } from '../dist/check-native-quarantine.js';
import { modalPlan, validateModalPlan } from '../dist/modal-plan.js';
import { githubActionsRecipe } from '../dist/github-actions-workflow.js';
import { compactCheckText, CompactCheckWriter } from '../dist/check-compact-output.js';
import { testReports } from '../dist/check-test-report.js';
import { validatePassingPrefix } from '../dist/landing-diagnosis.js';
import { passingCheckExit } from '../dist/check-backend.js';
import { runReceipt } from '../dist/agent-receipts.js';
v8.setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');
const file = 'tests/check-log-cleanup-paged.test.mjs';
const name = `${file} :: dogfood-shaped synthetic inventory`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-landing-quarantine-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  for (const [path, content] of Object.entries({
    'src/cleanup.ts': 'export const value = 1;',
    'src/other.ts': 'export const value = 1;',
    [file]: "import '../dist/cleanup.js';",
    'tests/other.test.mjs': "import '../dist/other.js';",
  })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const { head } = initNative(root);
  const store = new WorkStore(root),
    source = new NativeSource(root);
  const run = {
    id: randomUUID(),
    viewId: randomUUID(),
    head,
    base: head,
    comparisonBase: head,
    inputs: [],
    dependencies: [],
    check: {
      id: randomUUID(),
      name: 'verify',
      executable: process.execPath,
      args: ['scripts/forge-check.mjs'],
      environmentLabel: 'synthetic',
      definition: 'a'.repeat(64),
      at: new Date().toISOString(),
    },
    environment: checkEnvironment(),
    status: 'running',
    startedAt: new Date().toISOString(),
    runner: { pid: process.pid, host: hostname() },
    details: '',
    backend: { requested: 'local', actual: 'local' },
  };
  function next() {
    const current = { ...run, id: randomUUID() };
    mkdirSync(join(store.directory, `check-${current.id}`));
    store.locked(() => {
      const tx = store.records();
      tx.append('runs', current);
      store.commitRecords(tx);
    });
    return current;
  }
  function save(current, assessment) {
    store.locked(() => {
      const tx = store.records();
      tx.replace('runs', tx.find('runs', current.id).position, {
        ...current,
        status: assessment.blocked ? 'failed' : 'passed',
        endedAt: new Date().toISOString(),
        backend: { ...current.backend, ...assessment },
      });
      store.commitRecords(tx);
    });
  }
  return { root, store, source, run, next, save };
}
function outcome(current, { passed = true, retry = true, staticCode = 0, names = [name] } = {}) {
  const tests = names.map(test => ({ name: test.split(' :: ')[1], passed }));
  return {
    kind: 'result',
    pin: '',
    head: current.head,
    definition: current.check.definition,
    exitCode: passed ? staticCode : 1,
    estimatedCostUsd: 0,
    executions: [
      {
        executionId: current.id,
        index: 0,
        attempt: 0,
        exitCode: passed ? 0 : 1,
        tests: {
          [file]: {
            file,
            complete: true,
            results: tests,
            ...(retry
              ? { retry: { complete: true, results: tests.map(item => ({ ...item, passed: false })) } }
              : {}),
          },
        },
      },
      { executionId: `${current.id}:static`, index: 1, attempt: 0, exitCode: staticCode },
    ],
  };
}
const assess = (store, current, options) =>
  checkQuarantineResult(store, current, outcome(current, options), [[file]], new Date().toISOString());

test('incident replay: quarantined single failures can pass, but fail-twice always fails', t => {
  const { store, run, next, save } = fixture(t);
  for (let i = 0; i < 2; i++) {
    const current = next();
    const result = assess(store, current);
    assert.equal(result.blocked, false);
    assert.equal(result.verdict, 'flake');
    assert.equal(result.testVerdicts[0].recovery, 'unchanged-source');
    assert.equal(result.testVerdicts[0].head, current.head);
    assert.deepEqual(
      result.testVerdicts[0].attempts.map(item => item.passed),
      [false, true],
    );
    save(current, result);
  }
  assert.equal(checkQuarantine(store).needsYou.length, 1);
  const current = next(),
    result = assess(store, current, { passed: false, retry: false });
  assert.equal(result.blocked, false);
  assert.equal(result.verdict, 'quarantined');
  assert.match(result.details, /Ignored quarantined test: tests\/check-log-cleanup-paged/);
  assert.deepEqual(result.ignoredTests, [name]);
  assert.deepEqual(runReceipt({ ...current, backend: { ...run.backend, ...result } }).backend.ignoredTests, [
    name,
  ]);
  const replay = assess(store, current, { passed: false, retry: false });
  assert.deepEqual(replay, result, 'replaying the same result cannot change its verdict');
  assert.throws(
    () => assess(store, current, { retry: true }),
    error => error.code === 'EVIDENCE_CHANGED',
  );
  const persistent = assess(store, next(), { passed: false, retry: true });
  assert.equal(persistent.blocked, true);
  assert.equal(persistent.verdict, 'failed');
  assert.deepEqual(persistent.ignoredTests, []);
  assert.deepEqual(
    persistent.testVerdicts[0].attempts.map(item => item.passed),
    [false, false],
  );
  const providerRun = next();
  const provider = outcome(providerRun, { passed: false, retry: false });
  provider.executions.splice(1, 0, {
    ...provider.executions[0],
    executionId: `${providerRun.id}:retry`,
    attempt: 1,
  });
  const providerFailure = checkQuarantineResult(
    store,
    providerRun,
    provider,
    [[file]],
    new Date().toISOString(),
  );
  assert.equal(providerFailure.blocked, true);
  assert.equal(providerFailure.verdict, 'failed');
  assert.deepEqual(providerFailure.ignoredTests, []);
  const events = store.records().manifest.collections.frictionEvents.count;
  assert.equal(events, 1, 'new quarantine records one retry-safe friction item');
});

test('same-check passing retries are flakes even for changed paths; persistent failures stay failed', t => {
  const { root, store, source, run, next } = fixture(t);
  let current = next();
  assert.equal(assess(store, current, { passed: false }).blocked, true);
  writeFileSync(join(root, 'src/cleanup.ts'), 'export const value = 2;');
  run.head = source.writeState(
    source.capture(root, true),
    [run.base],
    'change dependency',
    new Date().toISOString(),
  );
  current = next();
  const result = assess(store, current);
  assert.equal(result.blocked, false);
  assert.equal(result.testVerdicts[0].verdict, 'flake');
  assert.equal(result.testVerdicts[0].recovery, 'unchanged-source');
  run.base = run.comparisonBase = '0'.repeat(64);
  assert.equal(assess(store, next()).blocked, false);
});

test('more than ten quarantines and every static failure block', t => {
  const { store, next, save } = fixture(t);
  const names = Array.from({ length: 11 }, (_, i) => `${file} :: flaky ${i}`);
  const first = next(),
    firstResult = assess(store, first, { names });
  save(first, firstResult);
  const second = assess(store, next(), { names });
  assert.equal(second.blocked, true);
  assert.match(second.details, /Too many flaky tests/);
  assert.deepEqual(second.ignoredTests, []);
  for (const staticCode of [1, 2, 137]) assert.equal(assess(store, next(), { staticCode }).blocked, true);
});

test('twenty clean observations release without new clean-run ledger writes; explicit fix and late terminal runs work', t => {
  const { store, next, save } = fixture(t);
  for (let i = 0; i < 2; i++) {
    const current = next();
    save(current, assess(store, current));
  }
  const ledger = join(store.directory, 'check-quarantine-ledger.json');
  const before = readFileSync(ledger, 'utf8');
  for (let i = 0; i < 20; i++) {
    const current = next();
    const clean = assess(store, current, { retry: false });
    save(current, clean);
  }
  assert.equal(readFileSync(ledger, 'utf8'), before);
  assert.deepEqual(checkQuarantine(store).needsYou, []);
  for (let i = 0; i < 2; i++) {
    const current = next();
    save(current, assess(store, current));
  }
  assert.equal(checkQuarantine(store).needsYou.length, 1);
  const operationId = randomUUID();
  assert.deepEqual(fixQuarantinedTest(store, operationId, name).needsYou, []);
  assert.deepEqual(fixQuarantinedTest(store, operationId, name).needsYou, []);
});

test('native checks require independent passing static evidence and preserve retry metadata through log compaction', t => {
  const { store, next } = fixture(t);
  for (const staticPassed of [true, false]) {
    const current = next(),
      report = outcome(current).executions[0].tests[file];
    const text = `__FORGE_TESTS__${JSON.stringify(report)}\n__FORGE_STATIC__${JSON.stringify({ passed: staticPassed })}\n`;
    const compact = compactCheckText(text);
    assert.deepEqual(testReports(compact.split('\n'))[file].retry, report.retry);
    const path = join(store.directory, `check-${current.id}`);
    writeFileSync(join(path, 'stdout.log'), text);
    const result = nativeQuarantine(store, current, path, staticPassed ? 0 : 1, new Date().toISOString());
    assert.equal(result.blocked, !staticPassed);
  }
});

test('pinned Actions and Modal recipes reuse exact impact selection and deny retries on affected files', async t => {
  const { root, store, source, run, next } = fixture(t);
  writeFileSync(join(root, 'src/other.ts'), 'export const value = 2;');
  run.head = source.writeState(
    source.capture(root, true),
    [run.base],
    'unrelated change',
    new Date().toISOString(),
  );
  run.mainCheck = { channel: 'main' };
  const current = next(),
    path = join(store.directory, `check-${current.id}`);
  const plan = await modalPlan(store, current, path);
  assert.ok(plan.retryFiles.includes(file));
  assert.ok(!plan.retryFiles.includes('tests/other.test.mjs'));
  assert.deepEqual(githubActionsRecipe(plan).retryFiles, plan.retryFiles);
  current.backend.pin = plan.pin;
  validateModalPlan(plan, current);
  assert.throws(() => validateModalPlan({ ...plan, retryFiles: [] }, current), /digest changed/);
});

test('dogfood ledger: 1500 runs × 500 files stream details, use zero Convex calls, and resume without rereading history', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-ledger-budget-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const now = Date.now();
  gc();
  let reads = 0,
    peak = process.memoryUsage().heapUsed;
  const startMemory = peak,
    start = performance.now();
  const store = {
    directory,
    readRecords() {
      return {
        manifest: { collections: { runs: { count: 1500 } } },
        fieldsAt(_, index) {
          reads++;
          const tests = Array.from({ length: 500 }, (_, i) => ({
            test: `tests/file-${i}.test.mjs :: result`,
            verdict: index < 2 ? 'flake' : 'passed',
            recovery: 'unchanged-source',
            evidenceRunId: `run-${index}`,
          }));
          // Peak live heap, not garbage the collector has not reached yet (runner-dependent).
          if (reads % 100 === 0) {
            gc();
            peak = Math.max(peak, process.memoryUsage().heapUsed);
          }
          return {
            record: {
              id: `run-${index}`,
              status: 'passed',
              endedAt: new Date(now - 1500 + index).toISOString(),
              backend: { testVerdicts: tests },
            },
          };
        },
      };
    },
    load() {
      throw Error('whole Work read forbidden');
    },
  };
  const history = quarantineHistory(store, []);
  assert.deepEqual(quarantineList(history.states), []);
  assert.equal(reads, 3000, 'two bounded metadata/detail passes; no per-item network call');
  history.save();
  reads = 0;
  quarantineHistory(store, []);
  assert.equal(reads, 0);
  const elapsed = performance.now() - start,
    heap = peak - startMemory;
  t.diagnostic(
    `1500x500: ${elapsed.toFixed(1)} ms, incremental peak heap ${(heap / 1048576).toFixed(2)} MiB; 3000 local record reads initially, 0 on resume; Convex calls/documents read/written 0/0/0`,
  );
  assert.ok(elapsed < 10000, 'ledger fits 10-second budget');
  assert.ok(heap < 96 * 1048576, 'ledger does not retain 750000 results');
  assert.ok(existsSync(join(directory, 'check-quarantine-ledger.json')));
});

test('clean receipts never consult history and a pending run is counted when it later completes', t => {
  const { store, next, save } = fixture(t);
  for (let i = 0; i < 2; i++) {
    const current = next();
    save(current, assess(store, current));
  }
  const late = next();
  const trigger = next();
  save(trigger, assess(store, trigger, { passed: false }));
  const clean = assess(store, late, { retry: false });
  save(late, clean);
  assert.equal(checkQuarantine(store).needsYou[0].consecutivePasses, 1);
  const current = next();
  t.mock.method(store, 'readRecords', () => {
    throw Error('clean checks must not read history');
  });
  assert.equal(assess(store, current, { retry: false }).verdict, 'clean');
});

test('bootstrap reads only recent detail, and reused receipts never invent new observations', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-ledger-window-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  let reads = 0;
  const store = {
    directory,
    readRecords: () => ({
      manifest: { collections: { runs: { count: 1500 } } },
      fieldsAt(_, index) {
        reads++;
        return {
          record: {
            id: `old-${index}`,
            status: 'passed',
            endedAt: '2020-01-01',
            backend: {
              quarantine: [],
              get testVerdicts() {
                throw Error('old test detail must not be read');
              },
            },
          },
        };
      },
    }),
  };
  assert.deepEqual(quarantineList(quarantineHistory(store, []).states), []);
  assert.equal(reads, 1500);
  store.readRecords = () => ({
    manifest: { collections: { runs: { count: 1 } } },
    fieldsAt: () => ({
      record: {
        id: 'reused',
        status: 'passed',
        endedAt: new Date().toISOString(),
        reusedFrom: { runId: 'original' },
        backend: {
          get testVerdicts() {
            throw Error('reuse cannot count as a new pass or flake');
          },
        },
      },
    }),
  });
  assert.deepEqual(quarantineList(quarantineHistory(store, []).states), []);
});

test('the actual landing prefix gate accepts explicit quarantine evidence while keeping the failing exit code', t => {
  const { store, next, save } = fixture(t);
  for (let i = 0; i < 2; i++) {
    const current = next();
    save(current, assess(store, current));
  }
  const current = next(),
    assessment = assess(store, current, { passed: false, retry: false });
  const run = {
    ...current,
    status: 'passed',
    exitCode: 1,
    endedAt: new Date().toISOString(),
    backend: { ...current.backend, ...assessment },
  };
  const work = {
    store: {
      select(collection) {
        if (collection === 'runs') return run;
        if (collection === 'checks') return run.check;
        if (collection === 'views') return { inputs: [], dependencies: [] };
        if (collection === 'landingEntries')
          return {
            checkId: run.check.id,
            definition: run.check.definition,
            environment: run.environment.fingerprint,
          };
      },
    },
  };
  const batch = { entryIds: ['entry'], base: run.base };
  const prefix = { runId: run.id, viewId: run.viewId, head: run.head };
  validatePassingPrefix(work, batch, prefix);
  assert.equal(run.exitCode, 1);
  run.backend.ignoredTests = [];
  assert.throws(
    () => validatePassingPrefix(work, batch, prefix),
    error => error.code === 'EVIDENCE_CHANGED',
  );
  assert.equal(passingCheckExit({ exitCode: 137, backend: assessment }), false);
});

test('failed-job diagnostic tails never duplicate a complete structured test report', t => {
  const { store, next } = fixture(t);
  const current = next(),
    report = outcome(current, { passed: false }).executions[0].tests[file];
  const path = join(store.directory, `check-${current.id}`, 'compact.evidence');
  const writer = new CompactCheckWriter(path);
  writer.append(`__FORGE_TESTS__${JSON.stringify(report)}\n`);
  writer.finish(true);
  const reports = testReports(readFileSync(path, 'utf8').split('\n'));
  assert.equal(reports[file].complete, true);
  assert.equal(reports[file].results[0].passed, false);
});

test('the ten-test guard also applies to clean checks without adding ledger writes, and twenty passes release it', t => {
  const { store, next, save } = fixture(t);
  const names = Array.from({ length: 11 }, (_, i) => `${file} :: excess ${i}`);
  for (let i = 0; i < 2; i++) {
    const current = next();
    save(current, assess(store, current, { names }));
  }
  const ledger = join(store.directory, 'check-quarantine-ledger.json'),
    before = readFileSync(ledger, 'utf8');
  for (let i = 0; i < 20; i++) {
    const current = next(),
      result = assess(store, current, { names, retry: false });
    assert.equal(result.blocked, i < 19);
    if (i < 19) assert.match(result.details, /Too many flaky tests/);
    save(current, result);
  }
  assert.equal(readFileSync(ledger, 'utf8'), before);
  assert.deepEqual(checkQuarantine(store).needsYou, []);
});

test('a pinned older observation ignores a quarantine cache from a later Work revision', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-quarantine-snapshot-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(
    join(directory, 'check-quarantine-ledger.json'),
    JSON.stringify({
      revision: 10,
      count: 1,
      pending: [],
      fixes: [],
      states: [[name, { flakes: [], quarantined: true, consecutivePasses: 0 }]],
    }),
  );
  const store = {
    directory,
    readRecords: () => ({
      revision: 9,
      manifest: { collections: { runs: { count: 0 } } },
      fieldsAt() {
        throw Error('future cached positions cannot be read');
      },
    }),
  };
  assert.deepEqual(quarantineList(quarantineHistory(store, []).states), []);
});
