// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { getDocumentSize } from 'convex/values';
import { updateHostedTimingHistory, parseTimingHistory } from '../dist/hosted-test-timings.js';
import { emptyHistory, timingHistoryLimits } from '../scripts/test-shards.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { recordHostedTestTimings, hostedTimingHistory, decodeTimingHistoryRow, encodeTimingHistoryRow } =
  await import(moduleUrl('../convex/projectHostedTestTimings.ts'));

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

test('timing rows preserve canonical v1 bytes and ignore corrupt or oversized gzip', () => {
  const text = JSON.stringify({
    version: 1,
    generation: 'exact',
    sample: 128,
    files: {
      'tests/é.test.mjs': { durationMs: 1.23456789012345, updatedAt: '2026-11-26', sourceRun: 128, n: 3 },
    },
    runs: ['first', 'second'],
  });
  const row = encodeTimingHistoryRow(text);
  assert.equal(row.history, '');
  assert.deepEqual(row, encodeTimingHistoryRow(text));
  assert.equal(gunzipSync(row.compressed).toString('utf8'), text);
  assert.equal(JSON.stringify(decodeTimingHistoryRow(row)), text);
  assert.equal(JSON.stringify(decodeTimingHistoryRow({ history: text })), text);

  const corrupt = (offset, mutate) => {
    const bytes = new Uint8Array(row.compressed.slice(0));
    mutate(new DataView(bytes.buffer), bytes.length + offset);
    return bytes.buffer;
  };
  for (const bytes of [
    row.compressed.slice(0, 17),
    new ArrayBuffer(timingHistoryLimits.bytes + 1),
    corrupt(-4, (view, at) => view.setUint32(at, timingHistoryLimits.bytes + 1, true)),
    corrupt(-4, (view, at) => view.setUint32(at, 1, true)),
    corrupt(-8, (view, at) => view.setUint8(at, view.getUint8(at) ^ 1)),
    corrupt(-row.compressed.byteLength + 3, (view, at) => view.setUint8(at, 8)),
  ]) {
    assert.deepEqual(decodeTimingHistoryRow({ history: text, compressed: bytes }), emptyHistory());
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
  const first = [...s.tables.projectHostedTestTimings.values()][0];
  await record(run);
  assert.deepEqual([...s.tables.projectHostedTestTimings.values()][0], first);
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
  assert.equal(s.scheduled.length, 0);
  const meters = s.counts.filter(row => row.name === 'record');
  assert(meters.every(row => row.documents <= 3 && row.writes <= 1));
  t.diagnostic(
    JSON.stringify({
      files: 600,
      documentsPerWarmCompletion: 1,
      documentsPerColdCompletion: 3,
      writesPerCompletion: 1,
      timingRowBytes: getDocumentSize(first),
      plainTimingRowBytes: getDocumentSize({
        ...first,
        compressed: undefined,
        history: JSON.stringify(decodeTimingHistoryRow(first)),
      }),
      addedFunctionCalls: 0,
      idleCalls: s.scheduled.length,
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
  const timingId = f.insert('projectHostedTestTimings', { projectId, history: before });
  const { history: legacy } = await f.transaction(
    'read-before-upgrade',
    { _handler: ctx => hostedTimingHistory(ctx, projectId) },
    {},
  );
  assert(JSON.stringify(legacy) === JSON.stringify(parseTimingHistory(before)));
  assert.equal(f.counts.at(-1).writes, 0);
  assert.equal(f.tables.projectHostedTestTimings.get(timingId).compressed, undefined);
  const run = { id: randomUUID(), status: 'passed', endedAt };
  const record = (durations, final) =>
    f.transaction(
      'timing-expiry',
      {
        _handler: ctx => recordHostedTestTimings(ctx, projectId, run, durations, final),
      },
      {},
    );
  const read = () => f.tables.projectHostedTestTimings.get(timingId);
  const legacyRow = read();
  await record({ [file(0)]: 200 }, false);
  assert.equal(read().history, '');
  assert(read().compressed instanceof ArrayBuffer);
  assert.equal(Object.keys(decodeTimingHistoryRow(read()).files).length, 4096);
  await record({ [file(4095)]: 200 }, true);
  const after = read();
  const { files, generation, sample, runs } = decodeTimingHistoryRow(after);
  assert.equal(Object.keys(files).length, 1481);
  assert.equal(files[file(0)].durationMs, 130);
  assert.equal(files[file(4095)].durationMs, 130, 'a late page can still refresh a dormant weight');
  assert.deepEqual(files[file(1478)], original.files[file(1478)], 'one millisecond inside the window stays');
  assert.deepEqual(files[file(1479)], original.files[file(1479)], 'a weight at the cutoff stays');
  assert.equal(files[file(1480)], undefined, 'one millisecond outside the window is pruned');
  assert.deepEqual([generation, sample, runs], [original.generation, original.sample, ['previous', run.id]]);
  await record({}, true);
  assert.deepEqual(read(), after, 'replay of a completed run keeps identical history');
  assert(
    f.counts.filter(row => row.name === 'timing-expiry').every(row => row.documents === 1 && row.writes <= 1),
  );
  const plainAfter = {
    ...after,
    compressed: undefined,
    history: JSON.stringify(decodeTimingHistoryRow(after)),
  };
  t.diagnostic(
    JSON.stringify({
      beforePruning: getDocumentSize(legacyRow),
      afterPruningPlain: getDocumentSize(plainAfter),
      afterPruningGzip: getDocumentSize(after),
    }),
  );
  assert(getDocumentSize(plainAfter) < getDocumentSize(legacyRow) * 0.4);
  assert.equal(f.tables.projectHostedTestTimings.size, 1);
  assert.equal(f.scheduled.length, 0);
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
  const history = decodeTimingHistoryRow([...f.tables.projectHostedTestTimings.values()][0]);
  assert.equal(stamps[0].generation, stamps[1].generation);
  assert.notEqual(stamps[0].sequence, stamps[1].sequence);
  assert.equal(history.files['tests/first.test.mjs'].sourceRun, stamps[0].sequence);
  assert.equal(history.files['tests/second.test.mjs'].sourceRun, stamps[1].sequence);
  assert.equal(typeof history.files['tests/second.test.mjs'].sourceRun, 'number');
});

test('dogfood and capped histories fit their document budgets without changing per-call timing row I/O counts', async t => {
  const names = readdirSync(new URL('./', import.meta.url)).filter(name => name.endsWith('.test.mjs'));
  const updatedAt = '2026-11-26T12:00:00.000Z';
  for (const [count, ceiling] of [
    [1480, 40_000],
    [timingHistoryLimits.files, 60_000],
  ]) {
    const f = lanesFixture();
    const projectId = f.insert('hostedProjects', {
      owner: 'synthetic',
      key: 'scale',
      name: 'Synthetic timing scale',
      currentBackup: null,
      revision: 0,
    });
    const files = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `tests/${names[i] ?? `synthetic-project-check-file-${i}.test.mjs`}`,
        { durationMs: (i + 1) * 13.191, updatedAt, sourceRun: 128, n: 3 },
      ]),
    );
    const history = JSON.stringify({
      version: 1,
      generation: 'synthetic',
      sample: 128,
      files,
      runs: Array.from({ length: 128 }, (_, i) => `run-${i}`),
    });
    const run = {
      id: 'warm-completion',
      status: 'passed',
      endedAt: updatedAt,
      contractReports: { [Object.keys(files)[0]]: { durationMs: 32 } },
    };
    const read = () =>
      f.transaction('session-timing-read', { _handler: ctx => hostedTimingHistory(ctx, projectId) }, {});
    const complete = () =>
      f.transaction(
        'timing-completion',
        { _handler: ctx => recordHostedTestTimings(ctx, projectId, structuredClone(run)) },
        {},
      );
    const id = f.insert('projectHostedTestTimings', { projectId, history });
    const legacy = f.tables.projectHostedTestTimings.get(id);
    assert.equal(JSON.stringify((await read()).history), history);
    await complete();
    const transitioned = f.tables.projectHostedTestTimings.get(id);
    const updated = updateHostedTimingHistory(history, run);
    assert.equal(JSON.stringify(decodeTimingHistoryRow(transitioned)), updated);

    const plainOutput = { ...legacy, history: updated };
    const compressedInput = { ...legacy, ...encodeTimingHistoryRow(history) };
    f.tables.projectHostedTestTimings.set(id, compressedInput);
    assert.equal(JSON.stringify((await read()).history), history);
    await complete();
    const compressedOutput = f.tables.projectHostedTestTimings.get(id);
    assert.deepEqual(compressedOutput, transitioned);
    assert(getDocumentSize(compressedInput) < ceiling);
    assert(getDocumentSize(compressedOutput) < ceiling);

    const [plainRead, upgrade, compressedRead, compressedWrite] = f.counts;
    for (const meter of [plainRead, upgrade, compressedRead, compressedWrite]) {
      assert.equal(meter.readDocumentsByTable.projectHostedTestTimings, 1);
      assert.equal(meter.ranges, 1);
      assert.equal(meter.writes, meter.name === 'timing-completion' ? 1 : 0);
    }
    assert(compressedRead.readBytesByTable.projectHostedTestTimings >= compressedInput.compressed.byteLength);
    assert(
      compressedWrite.writeBytesByTable.projectHostedTestTimings >= compressedOutput.compressed.byteLength,
    );
    assert.equal(f.counts.length, 4);
    assert.equal(f.scheduled.length, 0);
    t.diagnostic(
      JSON.stringify({
        files: count,
        rowBytesPerRead: { before: getDocumentSize(legacy), after: getDocumentSize(compressedInput) },
        rowBytesPerWrite: { before: getDocumentSize(plainOutput), after: getDocumentSize(compressedOutput) },
        rowBytesPerWarmCompletion: {
          before: getDocumentSize(legacy) + getDocumentSize(plainOutput),
          upgrade: getDocumentSize(legacy) + getDocumentSize(compressedOutput),
          after: getDocumentSize(compressedInput) + getDocumentSize(compressedOutput),
        },
        perRead: { calls: 1, reads: 1, writes: 0 },
        perCompletion: { calls: 1, reads: 1, writes: 1 },
        idleCalls: 0,
      }),
    );
  }
});
