// SPDX-License-Identifier: Apache-2.0
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
