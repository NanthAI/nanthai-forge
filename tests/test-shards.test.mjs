// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  partitionTests,
  shardDuration,
  testDuration,
  updateTimingHistory,
  timingHistoryLimits,
} from '../scripts/test-shards.mjs';
import { readTimingHistory } from '../scripts/test-timings-file.mjs';

test('LPT is deterministic with stable ties and exact-once whole-file coverage', () => {
  const files = Array.from({ length: 97 }, (_, i) => `tests/${String(i).padStart(3, '0')}.test.mjs`);
  const durations = Object.fromEntries(files.slice(0, 80).map((file, i) => [file, ((i % 9) + 1) * 1000]));
  for (const count of [1, 4, 16, 100]) {
    const plan = partitionTests(files, count, durations);
    assert.equal(plan.length, Math.min(files.length, count));
    assert.ok(plan.every(group => group.length));
    assert.deepEqual(plan.flat().sort(), files);
    assert.deepEqual(
      partitionTests([...files].reverse(), count, Object.fromEntries(Object.entries(durations).reverse())),
      plan,
    );
    assert.deepEqual(partitionTests([...files, files[0]], count, durations), plan);
  }
  assert.deepEqual(partitionTests([], 4, durations), []);
});

test('no usable history preserves sorted round-robin and unchanged shard counts', () => {
  const files = ['e', 'c', 'b', 'd', 'a'];
  for (const history of [{}, { a: 0, b: -1, c: NaN, d: Infinity }])
    assert.deepEqual(partitionTests(files, 2, history), [
      ['a', 'c', 'e'],
      ['b', 'd'],
    ]);
  for (const count of [0, -1, 1.5, Infinity]) assert.throws(() => partitionTests(files, count));
});

test('new files use historical nearest-rank p75, with a one-second empty-history default', () => {
  const history = { a: 10, b: 20, c: 30, d: 100, invalid: 0 };
  assert.equal(testDuration('new', history), 30);
  assert.equal(testDuration('d', history), 100);
  assert.equal(testDuration('new'), 1000);
  assert.deepEqual(
    partitionTests(['a', 'b', 'c', 'd', 'new'], 2, history),
    partitionTests(['a', 'b', 'c', 'd', 'new'], 2, { ...history, new: 30 }),
  );
});

test('packing and estimates account for one or two concurrent supervisor workers', () => {
  const durations = { a: 100, b: 90, c: 80, d: 70, e: 60, f: 50, g: 40, h: 30 };
  const files = Object.keys(durations);
  assert.equal(shardDuration(['a', 'b', 'c'], durations, 1), 270);
  assert.equal(shardDuration(['a', 'b', 'c'], durations, 2), 170);
  for (const workers of [1, 2]) {
    const old = partitionTests(files, 2);
    const next = partitionTests(files, 2, durations, workers);
    assert.ok(
      Math.max(...next.map(group => shardDuration(group, durations, workers))) <
        Math.max(...old.map(group => shardDuration(group, durations, workers))),
    );
  }
});

test('history EWMA updates once per run, prunes deleted files and ignores invalid observations', () => {
  const a = 'tests/a.test.mjs',
    b = 'tests/b.test.mjs';
  let history = { version: 1, files: {}, runs: [] };
  const update = (runId, files, durations) =>
    updateTimingHistory(history, { runId, files, durations, endedAt: '2026-01-01T00:00:00Z' });
  history = update('first', [a, b], { [a]: 100, [b]: 50, 'tests/unselected.test.mjs': 100 });
  assert.deepEqual(Object.keys(history.files).sort(), [a, b]);
  const next = update('second', [a], { [a]: 200, [b]: 100, '../outside': 100 });
  assert.equal(next.files[a].durationMs, 130);
  assert.equal(next.files[b], undefined);
  assert.equal(updateTimingHistory(next, { runId: 'second', files: [], durations: {}, endedAt: '' }), next);
  history = next;
  assert.equal(update('third', [a], { [a]: Infinity }).files[a].durationMs, 130);
});

test('history bounds file count, serialized bytes and run ledger without omitting tests from plans', () => {
  for (const length of [10, 980]) {
    const files = Array.from(
      { length: timingHistoryLimits.files + 20 },
      (_, i) => `tests/${String(i).padStart(5, '0')}${'x'.repeat(length)}.test.mjs`,
    );
    const history = updateTimingHistory(
      { version: 1, files: {}, runs: Array.from({ length: 128 }, (_, i) => String(i)) },
      {
        runId: 'new',
        endedAt: '2026-01-01',
        files,
        durations: Object.fromEntries(files.map(file => [file, 100])),
      },
    );
    assert.ok(Object.keys(history.files).length <= timingHistoryLimits.files);
    assert.ok(Buffer.byteLength(JSON.stringify(history)) <= timingHistoryLimits.bytes);
    assert.equal(history.runs.length, timingHistoryLimits.runs);
    assert.equal(history.runs.at(-1), 'new');
    const durations = Object.fromEntries(
      Object.entries(history.files).map(([file, item]) => [file, item.durationMs]),
    );
    assert.deepEqual(partitionTests(files, 4, durations).flat().sort(), files);
  }
});

test('missing, corrupt, oversized and invalid history reads fall back to round-robin', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-shard-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'history.json');
  const empty = { version: 1, files: {}, runs: [] };
  assert.deepEqual(readTimingHistory(path), empty);
  for (const content of ['{', JSON.stringify({ version: 2 }), ' '.repeat(timingHistoryLimits.bytes + 1)]) {
    writeFileSync(path, content);
    assert.deepEqual(readTimingHistory(path), empty);
  }
  const file = 'tests/a.test.mjs';
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      files: { [file]: { durationMs: 100, updatedAt: '2026-01-01' }, bad: { durationMs: 10 } },
      runs: [],
    }),
  );
  assert.equal(readTimingHistory(path).files[file].durationMs, 100);
  assert.equal(readTimingHistory(path).files.bad, undefined);
  assert.ok(readFileSync(path).length < timingHistoryLimits.bytes);
});
