// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { updateHostedTimingHistory, parseTimingHistory } from '../dist/hosted-test-timings.js';
import { timingHistoryLimits } from '../scripts/test-shards.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { recordHostedTestTimings, hostedTimingHistory } = await import(
  moduleUrl('../convex/projectHostedTestTimings.ts')
);

test('hosted history uses the native EWMA, ignores malformed observations and bounds files, runs and document bytes', () => {
  const file = 'tests/example.test.mjs';
  const run = {
    id: randomUUID(),
    endedAt: '2026-01-01T00:00:00Z',
    contractReports: {
      [file]: { durationMs: 100 },
      '../outside': { durationMs: 100 },
      'tests/invalid.test.mjs': { durationMs: -1 },
    },
  };
  const first = updateHostedTimingHistory('', run);
  assert.deepEqual(Object.keys(parseTimingHistory(first).files), [file]);
  assert.equal(updateHostedTimingHistory(first, run), first);
  const next = updateHostedTimingHistory(first, {
    ...run,
    id: randomUUID(),
    contractReports: { [file]: { durationMs: 200 } },
  });
  assert.equal(parseTimingHistory(next).files[file].durationMs, 130);
  for (const pathLength of [10, 980]) {
    const reports = Object.fromEntries(
      Array.from({ length: 6000 }, (_, i) => [
        `tests/${String(i).padStart(5, '0')}${'x'.repeat(pathLength)}.test.mjs`,
        { durationMs: i + 1 },
      ]),
    );
    const previous = JSON.stringify({
      version: 1,
      files: {},
      runs: Array.from({ length: 128 }, (_, i) => String(i)),
    });
    const text = updateHostedTimingHistory(previous, { ...run, contractReports: reports });
    const history = parseTimingHistory(text);
    assert(Object.keys(history.files).length <= timingHistoryLimits.files);
    assert(Buffer.byteLength(text) <= timingHistoryLimits.bytes);
    assert(Buffer.byteLength(JSON.stringify({ history: text })) <= timingHistoryLimits.bytes - 2048);
    assert.equal(history.runs.length, timingHistoryLimits.runs);
    assert.equal(history.runs.at(-1), run.id);
  }
});

test('600-file completed hosted results train one indexed document inside the result transaction, with no extra calls', async t => {
  const s = lanesFixture(),
    projectId = s.insert('hostedProjects', {
      owner: 'synthetic',
      key: randomUUID(),
      name: 'Synthetic timing history',
      currentBackup: null,
      revision: 0,
    });
  const run = {
    id: randomUUID(),
    status: 'passed',
    endedAt: '2026-01-01T00:00:00Z',
    contractReports: Object.fromEntries(
      Array.from({ length: 600 }, (_, i) => [`tests/synthetic-${i}.test.mjs`, { durationMs: i + 1 }]),
    ),
  };
  const record = run =>
    s.transaction('record', { _handler: ctx => recordHostedTestTimings(ctx, projectId, run) }, {});
  for (const status of ['running', 'cancelled', 'interrupted']) await record({ ...run, status });
  assert.equal(s.tables.projectHostedTestTimings.size, 0);
  await record(run);
  const first = [...s.tables.projectHostedTestTimings.values()][0].history;
  await record(run);
  assert.equal([...s.tables.projectHostedTestTimings.values()][0].history, first);
  const second = {
    ...run,
    id: randomUUID(),
    contractReports: { 'tests/synthetic-0.test.mjs': { durationMs: 11 } },
  };
  await record(second);
  const { history } = await s.transaction(
    'read',
    { _handler: ctx => hostedTimingHistory(ctx, projectId) },
    {},
  );
  assert.equal(Object.keys(history.files).length, 600);
  assert.equal(history.files['tests/synthetic-0.test.mjs'].durationMs, 4);
  assert.deepEqual(history.runs, [run.id, second.id]);
  const meters = s.counts.filter(row => row.name === 'record');
  assert(meters.every(row => row.documents <= 3 && row.writes <= 1));
  t.diagnostic(
    JSON.stringify({
      files: 600,
      documentsPerWarmCompletion: 1,
      documentsPerColdCompletion: 3,
      writesPerCompletion: 1,
      historyBytes: Buffer.byteLength(first),
      addedFunctionCalls: 0,
      idleCalls: 0,
    }),
  );
});

test('final timing pages prune only dormant weights and shrink the capped history on its existing write', async t => {
  const f = lanesFixture();
  const projectId = f.insert('hostedProjects', {
    owner: 'synthetic',
    key: randomUUID(),
    name: 'Timing expiry',
    currentBackup: null,
    revision: 0,
  });
  const endedAt = '2026-03-03T00:00:00.000Z';
  const past = '2026-02-01T23:59:59.999Z';
  const cutoff = '2026-02-01T00:00:00.000Z';
  const file = i => `tests/synthetic-check-file-${String(i).padStart(4, '0')}.test.mjs`;
  const original = {
    version: 1,
    generation: randomUUID(),
    sample: 99,
    runs: ['previous'],
    files: Object.fromEntries(
      Array.from({ length: 4096 }, (_, i) => [
        file(i),
        {
          durationMs: 100,
          updatedAt: i < 1480 ? '2026-03-02T00:00:00.000Z' : '2026-01-01T00:00:00.000Z',
          sourceRun: 99,
        },
      ]),
    ),
  };
  original.files[file(1478)].updatedAt = '2026-02-01T00:00:00.001Z';
  original.files[file(1479)].updatedAt = cutoff;
  original.files[file(1480)].updatedAt = '2026-01-31T23:59:59.999Z';
  original.files[file(0)].updatedAt = past;
  const before = JSON.stringify(original);
  f.insert('projectHostedTestTimings', { projectId, history: before });
  const run = { id: randomUUID(), status: 'passed', endedAt };
  const record = (durations, final) =>
    f.transaction(
      'timing-expiry',
      {
        _handler: ctx => recordHostedTestTimings(ctx, projectId, run, durations, final),
      },
      {},
    );
  const read = () => [...f.tables.projectHostedTestTimings.values()][0].history;
  await record({ [file(0)]: 200 }, false);
  assert.equal(Object.keys(parseTimingHistory(read()).files).length, 4096);
  await record({ [file(4095)]: 200 }, true);
  const after = read();
  const { files, generation, sample, runs } = parseTimingHistory(after);
  assert.equal(Object.keys(files).length, 1481);
  assert.equal(files[file(0)].durationMs, 130);
  assert.equal(files[file(4095)].durationMs, 130, 'a late page can still refresh a dormant weight');
  assert.deepEqual(files[file(1478)], original.files[file(1478)], 'one millisecond inside the window stays');
  assert.deepEqual(files[file(1479)], original.files[file(1479)], 'a weight at the cutoff stays');
  assert.equal(files[file(1480)], undefined, 'one millisecond outside the window is pruned');
  assert.deepEqual([generation, sample, runs], [original.generation, original.sample, ['previous', run.id]]);
  await record({}, true);
  assert.equal(read(), after, 'replay of a completed run keeps identical history');
  assert(
    f.counts.filter(row => row.name === 'timing-expiry').every(row => row.documents === 1 && row.writes <= 1),
  );
  const storedBytes = history => Buffer.byteLength(JSON.stringify({ projectId, history }));
  t.diagnostic(JSON.stringify({ before: storedBytes(before), after: storedBytes(after) }));
  assert(storedBytes(after) < storedBytes(before) * 0.4);
});

test('R2 timing stamps distinguish same-millisecond runs without repeating a long identity on every file', async () => {
  const f = lanesFixture();
  const projectId = f.insert('hostedProjects', {
    owner: 'synthetic',
    key: randomUUID(),
    name: 'Synthetic stamps',
    currentBackup: null,
    revision: 0,
  });
  const { useObjectReports, objectReportTransport } = await import(
    moduleUrl('../convex/projectHostedCheckReports.ts')
  );
  const { checkReportPointer } = await import('../dist/check-file-summary.js');
  const stamps = [];
  for (const [file, duration] of [
    ['tests/first.test.mjs', 10],
    ['tests/second.test.mjs', 20],
  ]) {
    const run = {
      id: randomUUID(),
      status: 'passed',
      endedAt: '2026-01-01T00:00:00.000Z',
      reportPointer: checkReportPointer({ [file]: { failed: false, durationMs: duration } }),
    };
    useObjectReports(run);
    await f.transaction(
      'objectTiming',
      { _handler: ctx => recordHostedTestTimings(ctx, projectId, run, { [file]: duration }) },
      {},
    );
    stamps.push(objectReportTransport(run).timingStamp);
  }
  const history = parseTimingHistory([...f.tables.projectHostedTestTimings.values()][0].history);
  assert.equal(stamps[0].generation, stamps[1].generation);
  assert.notEqual(stamps[0].sequence, stamps[1].sequence);
  assert.equal(history.files['tests/first.test.mjs'].sourceRun, stamps[0].sequence);
  assert.equal(history.files['tests/second.test.mjs'].sourceRun, stamps[1].sequence);
  assert.equal(typeof history.files['tests/second.test.mjs'].sourceRun, 'number');
});
