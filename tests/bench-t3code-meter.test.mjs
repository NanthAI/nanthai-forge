// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ImportBenchmarkMonitor, failureCode } from '../scripts/benchmark-import-monitor.mjs';
import { convexMeter, costUsd } from '../scripts/bench-t3code/meter.mjs';

// Synthetic values; field names/types match a bounded provider Completion capture.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/benchmark/completions.json', import.meta.url)));
const action = () => structuredClone(fixtures.action);
const monitor = () => new ImportBenchmarkMonitor({ projectId: 'p', name: 'n', since: 0 });
const closeTo = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
function metered(events) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let spawns = 0;
  child.kill = () => {
    child.stdout.end();
    child.stderr.end();
  };
  const meter = convexMeter({
    deployment: 'synthetic',
    projectId: 'p',
    name: 'n',
    cwd: '.',
    spawnLogs: () => {
      spawns++;
      return child;
    },
  });
  const timestamp = Date.now() / 1000 + 1;
  for (const event of events) child.stdout.write(JSON.stringify({ ...event, timestamp }) + '\n');
  return { ...meter.stop(), spawns };
}

test('Completion seconds and legacy milliseconds produce the same nonzero action GB-hours', () => {
  for (const fixture of Object.values(fixtures)) {
    const m = monitor();
    m.observe(fixture);
    closeTo(m.report().actionGbHours, 0.001);
    assert.deepEqual(m.report().missingUsageFields, {});
    assert.deepEqual(m.report().usage, { databaseReadDocuments: 3, databaseWriteDocuments: 2 });
  }
  // Memory and time aliases are independent; prefer the actual provider fields when both exist.
  for (const fields of [
    { executionTime: 7.2, executionTimeMs: 7200000 },
    { executionTime: null, executionTimeMs: 7200 },
  ]) {
    const m = monitor();
    m.observe({ ...action(), ...fields });
    closeTo(m.actionGbHours, 0.001);
  }
});

test('query/mutation memory is not billed as action compute; HTTP actions and failures are', () => {
  for (const udfType of ['Query', 'Mutation', 'Action', 'HttpAction']) {
    const e = { ...action(), udfType, error: 'synthetic failure' };
    const m = monitor();
    m.observe(e);
    m.observe(e); // transport replay is not billed twice
    assert.equal(m.total, 1);
    assert.equal(m.failures, 1);
    closeTo(m.actionGbHours, udfType.includes('Action') ? 0.001 : 0);
    m.observe({ ...e, occInfo: { retryCount: 1 } });
    assert.equal(m.total, 2, 'OCC attempts still count');
  }
});

test('missing, malformed, negative and nonfinite compute fields are flagged and remain unknown', () => {
  for (const value of [undefined, null, '512', -1, NaN, Infinity]) {
    for (const field of ['memoryUsedMb', 'executionTime']) {
      const e = action();
      if (field === 'memoryUsedMb') e.usageStats.memoryUsedMb = value;
      else e.executionTime = value;
      const m = monitor();
      m.observe(e);
      m.observe({ ...action(), requestId: 'second', executionId: 'second', timestamp: 102 });
      assert.equal(m.report().actionGbHours, null);
      assert.equal(Object.keys(m.report().missingUsageFields).length, 1);
    }
  }
  for (const udfType of [undefined, null, 'unknown']) {
    const m = monitor();
    m.observe({ ...action(), udfType });
    assert.equal(m.actionGbHours, null);
    assert.deepEqual(m.report().missingUsageFields, { udfType: 1 });
  }
  const zero = action();
  zero.executionTime = 0;
  const m = monitor();
  m.observe(zero);
  assert.equal(m.actionGbHours, 0, 'an explicit measured zero is valid');
  assert.deepEqual(m.report().missingUsageFields, {});
});

test('unattributed and pre-window missing fields cannot poison attributed usage; delayed attribution can', () => {
  const m = monitor();
  const e = { ...action(), usageStats: {}, logLines: [] };
  m.observe({ ...e, timestamp: -1 });
  m.observe({ ...action(), kind: 'Progress' });
  assert.deepEqual(m.report().missingUsageFields, {});
  m.observe({ ...e, requestId: 'foreign' });
  assert.deepEqual(m.report().missingUsageFields, {});
  m.observe({ ...action(), kind: 'Progress', requestId: 'foreign' });
  assert.equal(m.actionGbHours, null);
  assert.ok(m.report().missingUsageFields['usageStats.memoryUsedMb|actionMemoryUsedMb']);
});

test('live meter exposes each cost component and exact numeric I/O fields, with one existing stream', () => {
  const r = metered([action(), fixtures.legacyAction]);
  assert.equal(r.valid, true);
  assert.equal(r.spawns, 1);
  assert.equal(r.projectExecutions, 2);
  closeTo(r.actionGbHours, 0.002);
  closeTo(r.actionComputeUsd, 0.0006);
  assert.deepEqual(r.usage, {
    databaseReadDocuments: 6,
    databaseWriteDocuments: 4,
    databaseIoReadBytes: 2000,
    databaseIoWriteBytes: 4000,
    networkEgressBytes: 8000,
  });
  closeTo(r.costBreakdownUsd.calls, 4.4e-6);
  closeTo(r.costBreakdownUsd.databaseIo, (6000 / 1e9) * 0.22);
  closeTo(r.costBreakdownUsd.egress, (8000 / 1e9) * 0.132);
  closeTo(r.costUsd, 4.4e-6 + (6000 / 1e9) * 0.22 + (8000 / 1e9) * 0.132 + 0.0006);
});

test('meter flags missing usage instead of silently pricing zero; null costs cannot coerce to free compute', () => {
  for (const field of Object.keys(action().usageStats).filter(
    k => !['databaseReadBytes', 'databaseWriteBytes'].includes(k),
  )) {
    const e = action();
    delete e.usageStats[field];
    const r = metered([e]);
    assert.equal(r.valid, false, field);
    assert.ok(r.problems.some(p => p.includes(field)));
    if (['memoryUsedMb', 'databaseIoReadBytes', 'databaseIoWriteBytes', 'networkEgressBytes'].includes(field))
      assert.equal(r.costUsd, null, field);
    if (field === 'memoryUsedMb') assert.equal(r.actionComputeUsd, null);
    else assert.equal(r.usage[field], null);
  }
  assert.equal(costUsd({ executions: 1, ioBytes: 0, egressBytes: 0, actionGbHours: null }), null);
});

test('failed executions are tallied by error code per function, never by error text', () => {
  assert.equal(
    failureCode('Uncaught ConvexError: {"code":"WORK_STALE","message":"Hosted Work changed."}'),
    'WORK_STALE',
  );
  assert.equal(failureCode("{ code: 'CHANNEL_CHANGED', message: 'x' }"), 'CHANNEL_CHANGED');
  assert.equal(failureCode('Uncaught Error: secret-ish free text'), 'UNCODED');
  assert.equal(failureCode('{"code":"lowercase"}'), 'UNCODED');
  const failing = (executionId, error, extra = {}) => ({
    ...action(),
    identifier: 'synthetic:command',
    executionId,
    error,
    logLines: [],
    ...extra,
  });
  const r = metered([
    { ...action(), identifier: 'synthetic:command' },
    failing('a', '{"code":"WORK_STALE"}'),
    failing('b', '{"code":"WORK_STALE"}'),
    failing('c', 'boom'),
  ]);
  const fn = r.perFunction.find(item => item.identifier === 'synthetic:command');
  assert.equal(fn.failures, 3);
  assert.deepEqual(fn.failureCodes, { WORK_STALE: 2, UNCODED: 1 });
  assert.ok(!JSON.stringify(r).includes('boom'), 'error text is not retained');
});

test('per-function costs reconcile to the project total through delayed attribution and retries', () => {
  const parent = { ...action(), identifier: 'synthetic:parent' };
  const child = {
    ...action(),
    identifier: 'synthetic:child',
    executionId: 'child',
    udfType: 'Mutation',
    error: 'synthetic failure',
    logLines: [],
  };
  const cached = { ...parent, executionId: 'cached', cachedResult: true };
  const r = metered([
    child,
    parent,
    parent, // transport replay
    { ...child, occInfo: { retryCount: 1 } },
    cached,
    { ...parent, requestId: 'foreign', logLines: [] },
  ]);
  assert.equal(r.spawns, 1);
  assert.equal(r.perFunction.length, 2);
  const byName = Object.fromEntries(r.perFunction.map(fn => [fn.identifier, fn]));
  assert.equal(byName['synthetic:child'].executions, 2);
  assert.equal(byName['synthetic:child'].failures, 2);
  assert.equal(byName['synthetic:child'].actionGbSeconds, 0);
  assert.equal(byName['synthetic:parent'].cachedExecutions, 1);
  closeTo(byName['synthetic:parent'].actionGbSeconds, 7.2);
  assert.equal(r.projectExecutions, 4);
  closeTo(
    r.perFunction.reduce((n, fn) => n + fn.costUsd, 0),
    r.costUsd,
  );
  for (const part of Object.keys(r.costBreakdownUsd))
    closeTo(
      r.perFunction.reduce((n, fn) => n + fn.costBreakdownUsd[part], 0),
      r.costBreakdownUsd[part],
    );
  for (const field of Object.keys(r.usage))
    assert.equal(
      r.perFunction.reduce((n, fn) => n + fn.usage[field], 0),
      r.usage[field],
    );
});

test('per-function missing usage stays unknown without poisoning another function', () => {
  const bad = { ...action(), identifier: 'synthetic:bad', usageStats: {} };
  const good = { ...action(), identifier: 'synthetic:good', requestId: 'good', executionId: 'good' };
  const r = metered([bad, good]);
  const byName = Object.fromEntries(r.perFunction.map(fn => [fn.identifier, fn]));
  assert.equal(byName['synthetic:bad'].costUsd, null);
  assert.equal(byName['synthetic:bad'].actionGbSeconds, null);
  assert.ok(byName['synthetic:bad'].missingUsageFields['usageStats.databaseIoReadBytes']);
  assert.ok(byName['synthetic:good'].costUsd > 0);
  const unknown = metered([{ ...action(), identifier: undefined }]).perFunction[0];
  assert.equal(unknown.identifier, '(unknown function)');
  assert.equal(unknown.missingUsageFields.identifier, 1);
});

test('dogfood-size stream is local and bounded, with zero extra provider calls', t => {
  const before = process.memoryUsage().heapUsed;
  const start = performance.now();
  const m = monitor();
  for (let i = 0; i < 18000; i++)
    m.observe({ ...action(), identifier: `synthetic:f${i % 100}`, requestId: `r${i}`, executionId: `e${i}` });
  closeTo(m.actionGbHours, 18);
  assert.equal(m.report().retainedExecutions, 18000);
  assert.ok(m.requests.size <= m.capacity);
  assert.equal(m.report().perFunction.length, 100);
  assert.equal(
    m.report().perFunction.reduce((n, fn) => n + fn.executions, 0),
    18000,
  );
  const heapGrowth = process.memoryUsage().heapUsed - before;
  assert.ok(heapGrowth < 128 * 1024 * 1024, `heap growth ${heapGrowth}`);
  t.diagnostic(
    JSON.stringify({
      completions: 18000,
      convexCalls: 0,
      databaseReads: 0,
      databaseWrites: 0,
      heapGrowth,
      wallMs: performance.now() - start,
    }),
  );
});

test('summary exposes compute ranges and per-cell compute, excluding legacy false zeros', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-meter-summary-'));
  try {
    const ids = ['forge-n3-r1-a1-synthetic', 'forge-n3-r2-a1-synthetic'];
    for (const [index, cellId] of ids.entries()) {
      const dir = join(root, 'runs', cellId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'result.json'),
        JSON.stringify({
          cellId,
          arm: 'forge',
          N: 3,
          ...(index
            ? {}
            : { gates: { filesystemEvents: { ok: true, latencyMs: 12, fseventsdRssMb: 10, reason: null } } }),
          convex: index ? { valid: true, actionGbHours: 0, costUsd: 1 } : metered([action()]),
        }),
      );
    }
    mkdirSync(join(root, 'batches', 'synthetic'), { recursive: true });
    writeFileSync(
      join(root, 'batches', 'synthetic', 'batch.json'),
      JSON.stringify({ cells: ids.map(cellId => ({ cellId })) }),
    );
    const result = JSON.parse(
      execFileSync(process.execPath, ['scripts/bench-t3code/summarize.mjs'], {
        env: { ...process.env, BENCH_ROOT: root },
      }),
    );
    assert.deepEqual(result.byArmN['forge N=3'].convexActionGbHours, {
      median: 0.001,
      min: 0.001,
      max: 0.001,
      n: 1,
    });
    assert.equal(result.byArmN['forge N=3'].convexActionComputeUsd.n, 1);
    assert.equal(result.cells[0].convex.actionGbHours, 0.001);
    closeTo(result.cells[0].convex.actionComputeUsd, 0.0003);
    assert.equal(result.cells[1].convex.actionComputeUsd, null);
    assert.equal(result.cells[0].filesystemEvents.ok, true);
    assert.equal(result.cells[0].filesystemEvents.latencyMs, 12);
    assert.equal(result.cells[1].filesystemEvents, null, 'legacy cells have unknown watcher health');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
