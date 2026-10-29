// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { recordCheckTimings } from '../dist/check-test-timings.js';
import { recoverRuns } from '../dist/work-run.js';
import { createRunReceipt } from '../dist/work-run-receipt.js';
import { readTimingHistory } from '../scripts/test-timings-file.mjs';

const a = 'tests/a.test.mjs',
  b = 'tests/b.test.mjs';
const report = (file, durationMs, complete = true) => ({
  file,
  durationMs,
  complete,
  results: [{ name: 'synthetic', passed: true }],
});
const marker = value => `__FORGE_TESTS__${JSON.stringify(value)}\n`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-test-timings-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  mkdirSync(join(root, 'tests'));
  for (const file of [a, b]) writeFileSync(join(root, file), '// Synthetic source\n');
  initNative(root);
  const store = new WorkService(root).store;
  const run = {
    id: randomUUID(),
    head: store.load().nativeHead,
    status: 'passed',
    endedAt: '2026-01-01T00:00:00Z',
    checkSelection: { scope: 'full', reason: 'Synthetic', tests: [a, b] },
  };
  const directory = join(store.directory, `check-${run.id}`);
  mkdirSync(directory);
  const historyPath = join(store.directory, 'test-timings.json');
  return { store, run, directory, historyPath };
}

test('completed local receipts learn only complete, selected whole-file durations', t => {
  const f = fixture(t);
  writeFileSync(
    join(f.directory, 'stdout.log'),
    marker(report(a, 100)) +
      marker(report(b, 999, false)) +
      marker(report('tests/unselected.test.mjs', 1000)) +
      marker(report(b, -1)) +
      '__FORGE_TESTS__{truncated\n',
  );
  const receipt = createRunReceipt({
    status: 'passed',
    endedAt: f.run.endedAt,
    checkSelection: f.run.checkSelection,
    exitCode: 0,
    signal: null,
    details: 'Synthetic local completion',
  });
  writeFileSync(join(f.directory, 'result.json'), JSON.stringify(receipt));
  const run = { ...f.run, status: 'running' };
  assert.equal(recoverRuns(f.store, { runs: [run] }), true);
  assert.equal(run.status, 'passed');
  const history = readTimingHistory(f.historyPath);
  assert.deepEqual(Object.keys(history.files), [a]);
  assert.equal(history.files[a].durationMs, 100);
  assert.deepEqual(history.runs, [run.id]);
});

test('Actions timestamped shard logs use latest complete attempt and survive reconciliation retries', t => {
  const f = fixture(t);
  const shards = join(f.directory, 'shards');
  mkdirSync(shards);
  writeFileSync(join(shards, '0.log'), `2026-01-01T00:00:00.000Z ${marker(report(a, 100))}`);
  writeFileSync(join(shards, '0.attempt-2.log'), marker(report(a, 200)) + marker(report(b, 100)));
  writeFileSync(join(shards, '0.attempt-3.log'), marker(report(a, 999, false)));
  writeFileSync(join(shards, 'static.log'), marker(report(a, 9999)));
  assert.equal(recordCheckTimings(f.store, f.run, f.directory), true);
  const bytes = readFileSync(f.historyPath, 'utf8');
  assert.equal(readTimingHistory(f.historyPath).files[a].durationMs, 200);
  assert.equal(readTimingHistory(f.historyPath).files[b].durationMs, 100);
  assert.equal(recordCheckTimings(f.store, f.run, f.directory), true);
  assert.equal(readFileSync(f.historyPath, 'utf8'), bytes);
  // A crash after publishing history but before its per-run marker must not add another EWMA sample.
  rmSync(join(f.directory, 'test-timings-recorded'));
  writeFileSync(join(shards, '0.attempt-2.log'), marker(report(a, 400)));
  assert.equal(recordCheckTimings(f.store, f.run, f.directory), true);
  assert.equal(readFileSync(f.historyPath, 'utf8'), bytes);
});

test('Modal execution reports preserve durations, prefer retries, and include completed failures', t => {
  const f = fixture(t);
  f.run.status = 'failed';
  writeFileSync(
    join(f.directory, 'modal-shard-logs.json'),
    JSON.stringify([
      { attempt: 1, tests: { [a]: report(a, 250), [b]: report(b, 500, false) } },
      { attempt: 0, tests: { [a]: report(a, 100), [b]: report(b, 300) } },
    ]),
  );
  assert.equal(recordCheckTimings(f.store, f.run, f.directory), true);
  const history = readTimingHistory(f.historyPath);
  assert.equal(history.files[a].durationMs, 250);
  assert.equal(history.files[b].durationMs, 300);
});

test('active, interrupted and cancelled checks do not train history', t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'stdout.log'), marker(report(a, 100)));
  for (const status of ['queued', 'running', 'interrupted', 'cancelled'])
    assert.equal(recordCheckTimings(f.store, { ...f.run, status }, f.directory), false);
  assert.equal(existsSync(f.historyPath), false);
});

test('a newer completion settles a crashed history/marker publication before updating the EWMA', t => {
  for (const published of [false, true]) {
    const f = fixture(t);
    const pending = {
      version: 1,
      files: { [a]: { durationMs: 100, updatedAt: f.run.endedAt } },
      runs: [f.run.id],
    };
    writeFileSync(
      join(f.store.directory, 'test-timings-pending.json'),
      JSON.stringify({ runId: f.run.id, history: pending }),
    );
    if (published) writeFileSync(f.historyPath, JSON.stringify(pending));
    const next = { ...f.run, id: randomUUID(), endedAt: '2026-01-02T00:00:00Z' };
    const directory = join(f.store.directory, `check-${next.id}`);
    mkdirSync(directory);
    writeFileSync(join(directory, 'stdout.log'), marker(report(a, 200)));
    assert.equal(recordCheckTimings(f.store, next, directory), true);
    assert.equal(readTimingHistory(f.historyPath).files[a].durationMs, 130);
    assert.equal(readFileSync(join(f.directory, 'test-timings-recorded'), 'utf8'), f.run.id);
    assert.equal(existsSync(join(f.store.directory, 'test-timings-pending.json')), false);
    const bytes = readFileSync(f.historyPath, 'utf8');
    assert.equal(recordCheckTimings(f.store, f.run, f.directory), true);
    assert.equal(readFileSync(f.historyPath, 'utf8'), bytes);
  }
});

test('malformed and very long log lines cannot hide later complete timing reports', t => {
  const f = fixture(t);
  writeFileSync(
    join(f.directory, 'stdout.log'),
    'x'.repeat(2 * 1024 * 1024) + '\n' + marker(report(a, 150)) + marker(report(b, 200)).trimEnd(),
  );
  assert.equal(recordCheckTimings(f.store, f.run, f.directory), true);
  const history = readTimingHistory(f.historyPath);
  assert.equal(history.files[a].durationMs, 150);
  assert.equal(history.files[b], undefined);
});
