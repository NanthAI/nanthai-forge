// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
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

// The daily operating meter shares the provider adapter, but uses the approved budget rates.
const { spendEvent, daySummary, pendingAlerts } = await import('../scripts/convex-spend-model.mjs');
const { SpendJournal, journalLock } = await import('../scripts/convex-spend-journal.mjs');
const { notifySpend } = await import('../scripts/convex-spend.mjs');
function dailyEvent(fields = {}) {
  const log = { ...action(), timestamp: Date.parse('2026-01-02T12:00Z') / 1000, ...fields };
  log.usageStats = { ...log.usageStats, textIndexQueryBytes: 1e9, textIndexWriteQueryBytes: 2e9 };
  return log;
}
function dailyDirectory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-daily-spend-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('daily spend prices calls, I/O, both search meters, action compute and egress separately', () => {
  const event = spendEvent(dailyEvent(), 'synthetic');
  const report = daySummary(event.day, [event]);
  assert.equal(report.usage.calls, 1);
  closeTo(report.classes.calls, 0.000002);
  closeTo(report.classes.io, (3000 / 1e9) * 0.2);
  closeTo(report.classes.search, (3 * 0.11) / 1000);
  closeTo(report.classes.compute, 0.0003);
  closeTo(report.classes.egress, (4000 / 1e9) * 0.12);
  assert.equal(report.usd, report.perFunction[0].usd);
  assert.ok(!JSON.stringify(event).includes('FORGE_PROJECT_EXECUTION'));
  assert.ok(!JSON.stringify(event).includes('logLines'));
});
test('daily journals restart without double billing while preserving retries, cached calls and deployments', async t => {
  const dir = dailyDirectory(t);
  const event = spendEvent(dailyEvent(), 'first');
  const first = new SpendJournal(dir);
  assert.equal(await first.append(event), true);
  const restarted = new SpendJournal(dir);
  assert.equal(await restarted.append(event), false);
  for (const next of [
    spendEvent(dailyEvent({ occInfo: { retryCount: 1 } }), 'first'),
    spendEvent(dailyEvent(), 'second'),
    spendEvent(dailyEvent({ cachedResult: true, executionId: 'cache' }), 'first'),
  ])
    await restarted.append(next);
  assert.equal((await restarted.report(event.day)).usage.calls, 4);
  assert.equal(
    readFileSync(join(dir, event.day + '.jsonl'), 'utf8')
      .trim()
      .split('\n').length,
    4,
  );
});
test('daily journal preserves crash-torn bytes, reports the gap and resumes on a new line', async t => {
  const dir = dailyDirectory(t),
    event = spendEvent(dailyEvent(), 'synthetic');
  const path = join(dir, event.day + '.jsonl');
  const before = JSON.stringify(event) + '\n{"kind":"exec';
  writeFileSync(path, before);
  const journal = new SpendJournal(dir);
  assert.equal((await journal.report(event.day)).gaps.length, 1);
  assert.equal(readFileSync(path, 'utf8'), before, 'reporting is read only');
  await journal.append(spendEvent(dailyEvent({ executionId: 'next' }), 'synthetic'));
  const report = await new SpendJournal(dir).report(event.day);
  assert.equal(report.usage.calls, 2);
  assert.equal(report.gaps.length, 1);
  assert.ok(readFileSync(path, 'utf8').startsWith(before));
});
test('daily coverage splits UTC midnight and sums overlapping streams without inventing missing time', async t => {
  const journal = new SpendJournal(dailyDirectory(t));
  const start = Date.parse('2026-01-02T23:59:00Z'),
    end = start + 120_000;
  await journal.coverage('one', start, end);
  await journal.coverage('one', start, end);
  assert.equal((await journal.report('2026-01-02', end)).deployments[0].coveredMs, 60_000);
  assert.equal((await journal.report('2026-01-03', end)).deployments[0].coveredMs, 60_000);
  const event = spendEvent(dailyEvent(), 'one');
  await journal.append(event);
  await journal.gap('one', 'synthetic-disconnect', start);
  const report = await journal.report(event.day, end);
  closeTo(report.projectedKnownUsd, report.knownUsd * 1440);
  assert.equal(report.gaps.length, 1);
  assert.match(report.coverage, /partial/);
});
test('missing usage stays unknown instead of free and known costs can still trigger daily alerts', () => {
  const raw = dailyEvent();
  delete raw.usageStats.networkEgressBytes;
  const event = spendEvent(raw, 'one');
  event.usage.io = 1e9;
  const report = daySummary(
    event.day,
    [event, { kind: 'coverage', deployment: 'one', from: event.at, to: event.at + 60_000 }],
    event.at + 60_000,
  );
  assert.equal(report.usd, null);
  assert.equal(report.classes.egress, null);
  assert.ok(report.perFunction[0].missingFields.includes('usageStats.networkEgressBytes'));
  assert.equal(pendingAlerts(report)[0].kind, 'daily');
  assert.throws(() => spendEvent({ ...raw, timestamp: 'bad' }, 'one'), /SPEND_LOG_SCHEMA/);
  assert.equal(spendEvent({ kind: 'Progress' }, 'one'), null);
});
test('daily and per-function alerts survive restarts and only trigger above their exact thresholds', () => {
  const event = spendEvent(dailyEvent(), 'one');
  event.usage = { calls: 0, io: 2.5e9, search: 0, compute: 0, egress: 0 };
  const coverage = { kind: 'coverage', deployment: 'one', from: event.at, to: event.at + 28_800_000 };
  let report = daySummary(event.day, [event, coverage], coverage.to);
  assert.deepEqual(pendingAlerts(report), []);
  event.usage.io += 100;
  report = daySummary(event.day, [event, coverage], coverage.to);
  assert.deepEqual(
    pendingAlerts(report).map(a => a.kind),
    ['daily', 'function'],
  );
  const markers = pendingAlerts(report).map(a => ({ kind: 'alert', key: a.key }));
  assert.deepEqual(pendingAlerts(daySummary(event.day, [event, coverage, ...markers], coverage.to)), []);
});
test('notifier receives private topic and target through stdin, suppresses output and reports failure', async t => {
  const dir = dailyDirectory(t),
    output = join(dir, 'notification.json');
  await notifySpend(
    {
      command: [
        process.execPath,
        '-e',
        "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>require('fs').writeFileSync(process.argv[1],s));",
        output,
      ],
      topic: 'fixture-topic',
      target: 'fixture-target',
    },
    { key: 'stable-id', knownUsd: 2 },
  );
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), {
    topic: 'fixture-topic',
    target: 'fixture-target',
    key: 'stable-id',
    knownUsd: 2,
  });
  await assert.rejects(
    notifySpend({ command: [process.execPath, '-e', 'process.exit(1)'], topic: 't', target: 'x' }, {}),
    /SPEND_HOOK_FAILED/,
  );
  await notifySpend(undefined, {});
});
test('daily journal rejects a competing writer and releases its local lock', t => {
  const dir = dailyDirectory(t),
    release = journalLock(dir);
  assert.throws(() => journalLock(dir), /SPEND_WRITER_RUNNING/);
  release();
  journalLock(dir)();
});

test('CLI consumes stdin, reports seven days offline and deduplicates the same stream after restart', t => {
  const dir = dailyDirectory(t);
  const event = dailyEvent({ timestamp: Date.now() / 1000 });
  const input = JSON.stringify(event) + '\n';
  for (let i = 0; i < 2; i++)
    execFileSync(
      process.execPath,
      ['scripts/convex-spend.mjs', '--state', dir, '--stdin', '--deployment', 'synthetic'],
      { input, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  const report = JSON.parse(
    execFileSync(process.execPath, ['scripts/convex-spend.mjs', '--state', dir, '--print'], {
      encoding: 'utf8',
    }),
  );
  assert.equal(report.today.usage.calls, 1);
  const summary = JSON.parse(readFileSync(join(dir, report.today.day + '.summary.json'), 'utf8'));
  assert.equal(summary.usage.calls, 1);
  assert.equal(summary.perFunction[0].usd, report.today.usd);
  assert.equal(report.trend.length, 7);
  assert.equal(report.top10[0].identifier, 'synthetic:work');
  assert.equal(report.yesterday.deployments.length, 0);
});

test('writer crash releases the local lock automatically without deleting any day data', async t => {
  const dir = dailyDirectory(t);
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import {journalLock} from './scripts/convex-spend-journal.mjs'; journalLock(process.argv[1]); console.log('ready'); process.stdin.resume();",
      dir,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  await once(child.stdout, 'data');
  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
  journalLock(dir)();
});

test('one incomplete execution cannot erase known costs of other executions or suppress their alerts', () => {
  const first = spendEvent(dailyEvent(), 'one');
  first.usage.egress = 10e9;
  const missing = spendEvent(dailyEvent({ executionId: 'missing' }), 'one');
  missing.usage.egress = null;
  const report = daySummary(
    first.day,
    [
      first,
      missing,
      { kind: 'gap', deployment: '(journal)', reason: 'synthetic-torn-record' },
      { kind: 'coverage', deployment: 'one', from: first.at, to: first.at + 60_000 },
    ],
    first.at + 60_000,
  );
  assert.equal(report.usd, null);
  assert.ok(report.knownUsd > 1.2);
  assert.ok(report.perFunction[0].knownUsd > 1.2);
  assert.deepEqual(
    pendingAlerts(report).map(a => a.kind),
    ['daily', 'function'],
  );
});

const { spendPlan, billingPeriod, billingSummary, periodRows, planAlerts } =
  await import('../scripts/convex-spend-plan.mjs');
const BILL_DAY = 86_400_000;
const proConfig = extra => ({
  name: 'Professional',
  monthlyUsd: 25,
  periodStart: '2026-11-10T00:00:00Z',
  renewalDay: 27,
  prorateFirstPeriod: true,
  allowances: {
    calls: 25e6,
    compute: 250,
    io: 50,
    egress: 50,
    databaseStorage: 50,
    fileStorage: 100,
    search: 50000,
  },
  ...extra,
});
function planEvent(at, identifier, usage, deployment = 'one') {
  return {
    kind: 'execution',
    id: `${at}:${identifier}:${deployment}`,
    at: Date.parse(at),
    day: at.slice(0, 10),
    deployment,
    identifier,
    usage: { calls: 0, io: 0, compute: 0, egress: 0, search: 0, ...usage },
    missingFields: [],
  };
}

test('Professional first period uses conservative 17/31 allowances and separately shows the normal 30-day pace', () => {
  const plan = spendPlan(proConfig()),
    now = Date.parse('2026-11-11T00:00:00Z');
  const report = billingSummary(plan, [], now);
  assert.equal(report.period.start, '2026-11-10T00:00:00.000Z');
  assert.equal(report.period.end, '2026-11-27T00:00:00.000Z');
  closeTo(report.period.allowanceFactor, 17 / 31);
  closeTo(report.classes.io.allowance, (50 * 17) / 31);
  closeTo(report.classes.egress.allowance, (50 * 17) / 31);
  closeTo(report.classes.io.normalDailyAllowance, 50 / 30);
  closeTo(report.classes.io.periodDailyAllowance, 50 / 31);
  closeTo(report.classes.io.allowanceToDate, 50 / 31);
  assert.equal(report.subscriptionMonthlyUsd, 25);
  assert.equal(report.overageAlertUsd, 25);
  const corrected = billingSummary(spendPlan(proConfig({ prorateFirstPeriod: false })), [], now);
  assert.equal(corrected.classes.io.allowance, 50, 'invoice correction stays in private config');
});

test('renewal on the 27th resets allowances and short-month renewal clamps without drifting', () => {
  const plan = spendPlan(proConfig());
  const next = billingPeriod(plan, Date.parse('2026-11-27T00:00:00Z'));
  assert.equal(new Date(next.start).toISOString(), '2026-11-27T00:00:00.000Z');
  assert.equal(new Date(next.end).toISOString(), '2026-12-27T00:00:00.000Z');
  assert.equal(next.allowanceFactor, 1);
  const leap = spendPlan(proConfig({ periodStart: '2028-01-31T00:00:00Z', renewalDay: 31 }));
  assert.equal(
    new Date(billingPeriod(leap, Date.parse('2028-02-15T00:00:00Z')).end).toISOString(),
    '2028-02-29T00:00:00.000Z',
  );
  assert.equal(
    new Date(billingPeriod(leap, Date.parse('2028-03-01T00:00:00Z')).end).toISOString(),
    '2028-03-31T00:00:00.000Z',
  );
});

test('shared plan allowances apply once across functions and deployments; list-rate and allocated overage stay separate', () => {
  const plan = spendPlan(proConfig({ periodStart: '2026-10-27T00:00:00Z' }));
  const at = '2026-11-10T00:00:00Z',
    now = Date.parse('2026-11-11T00:00:00Z');
  const rows = [
    planEvent(at, 'a', { io: 30e9, calls: 13e6 }, 'one'),
    planEvent(at, 'b', { io: 30e9, calls: 13e6 }, 'two'),
  ];
  for (const deployment of ['one', 'two'])
    rows.push({ kind: 'coverage', deployment, from: Date.parse(at), to: now });
  const report = billingSummary(plan, [daySummary('2026-11-10', rows, now)], now, ['one', 'two']);
  assert.equal(report.classes.io.observedUsage, 60);
  assert.equal(report.classes.io.overageUsd, 2);
  assert.equal(report.classes.calls.overageUsd, 2);
  assert.equal(report.knownOverageUsd, 4);
  assert.equal(report.listRateUsd, 64);
  assert.equal(report.perFunction.length, 2);
  assert.equal(report.perFunction[0].allocatedOverageUsd, 2);
  assert.equal(report.perFunction[0].listRateUsd, 32);
  assert.equal(report.classes.databaseStorage.observedUsage, null, 'function logs cannot invent storage use');
  assert.equal(report.projectedOverageUsd, null, 'the complete bill remains unknown');
});

test('late capture projects the whole billing period and cannot silently treat earlier unwatched time as free', () => {
  const plan = spendPlan(proConfig()),
    now = Date.parse('2026-11-20T00:00:00Z');
  const at = '2026-11-19T00:00:00Z';
  const report = billingSummary(
    plan,
    [
      daySummary(
        '2026-11-19',
        [
          planEvent(at, 'io-work', { io: 1.7e9 }),
          { kind: 'coverage', deployment: 'one', from: Date.parse(at), to: now },
        ],
        now,
      ),
    ],
    now,
    ['one'],
  );
  assert.equal(report.classes.io.observedUsage, 1.7);
  closeTo(report.classes.io.projectedKnownUsage, 1.7 * 17);
  assert(report.classes.io.projectedKnownUsage > report.classes.io.allowance);
  assert(planAlerts(report).some(alert => alert.kind === 'allowance' && alert.class === 'io'));
  assert(planAlerts(report).some(alert => alert.kind === 'billing-coverage'));
});

test('known overage still alerts with zero coverage or missing usage, and monthly thresholds are strict', () => {
  const plan = spendPlan(proConfig({ periodStart: '2026-10-27T00:00:00Z' }));
  const now = Date.parse('2026-11-11T00:00:00Z');
  const event = planEvent('2026-11-10T00:00:00Z', 'known', { io: 200e9 });
  const missing = planEvent('2026-11-10T00:00:01Z', 'missing', { io: null });
  const report = billingSummary(plan, [daySummary('2026-11-10', [event, missing], now)], now);
  assert.equal(report.classes.io.observedUsage, null);
  assert.equal(report.classes.io.knownOverageUsd, 30);
  assert(planAlerts(report).some(alert => alert.kind === 'month-overage'));
  assert(planAlerts(report).some(alert => alert.class === 'io'));
  const exact = {
    ...report,
    missing: [],
    projectedKnownOverageUsd: 25,
    classes: {
      io: { projectedKnownUsage: 50, allowance: 50 },
      egress: { projectedKnownUsage: 50, allowance: 50 },
    },
  };
  assert.deepEqual(planAlerts(exact), []);
  assert.deepEqual(
    planAlerts({ ...exact, projectedKnownOverageUsd: 25.001 }).map(a => a.kind),
    ['month-overage'],
  );
  assert.deepEqual(
    planAlerts({
      ...exact,
      classes: { ...exact.classes, egress: { projectedKnownUsage: 50.001, allowance: 50 } },
    }).map(a => a.class),
    ['egress'],
  );
});

test('billing clips a partial upgrade day, excludes earlier executions, and retains torn-record uncertainty', () => {
  const from = Date.parse('2026-11-10T12:00:00Z'),
    to = from + BILL_DAY;
  const before = planEvent('2026-11-10T11:59:59Z', 'before', { io: 50e9 });
  const after = planEvent('2026-11-10T12:00:00Z', 'after', { io: 2e9 });
  const rows = periodRows(
    [
      before,
      after,
      { kind: 'coverage', deployment: 'one', from: from - 1000, to: to + 1000 },
      { kind: 'gap', reason: 'torn-or-invalid-journal-record', at: to + 1000 },
    ],
    from,
    to,
  );
  assert.equal(rows.filter(r => r.kind === 'execution').length, 1);
  assert.equal(rows.find(r => r.kind === 'coverage').from, from);
  assert.equal(rows.find(r => r.kind === 'coverage').to, to);
  assert.equal(rows.filter(r => r.kind === 'gap').length, 1);
});

test('billing restarts deduplicate, reuse closed summaries and invalidate them on late journal writes', async t => {
  const dir = dailyDirectory(t),
    journal = new SpendJournal(dir);
  const plan = spendPlan(proConfig()),
    now = Date.parse('2026-11-12T00:00:00Z');
  const first = planEvent('2026-11-10T01:00:00Z', 'first', { io: 1e9 });
  await journal.append(first);
  let report = await journal.billing(plan, now);
  assert.equal(report.classes.io.observedUsage, 1);
  const rawRead = journal.readDay.bind(journal);
  journal.readDay = () => {
    throw Error('closed day replayed');
  };
  assert.equal((await journal.billing(plan, now)).classes.io.observedUsage, 1);
  journal.readDay = rawRead;
  const restarted = new SpendJournal(dir);
  assert.equal(await restarted.append(first), false);
  await restarted.append(planEvent('2026-11-10T02:00:00Z', 'late', { io: 2e9 }));
  report = await journal.billing(plan, now);
  assert.equal(report.classes.io.observedUsage, 3);
  assert.equal((await new SpendJournal(dir).billing(plan, now)).classes.io.observedUsage, 3);
  const alert = planAlerts(report).find(a => a.kind === 'billing-coverage');
  await journal.append({ kind: 'alert', key: alert.key, at: now });
  assert(!planAlerts(await journal.billing(plan, now)).some(a => a.kind === 'billing-coverage'));
});

test('private plan rejects misspelled or invalid allowances, while optional storage snapshots remain explicit', () => {
  assert.equal(spendPlan(undefined), null);
  for (const bad of [
    { renewalDay: 0 },
    { periodStart: '2026-02-30T00:00:00Z' },
    { overageAlertUsd: -1 },
    { allowances: { ...proConfig().allowances, io: -1 } },
    { allowance: 100 },
    { overageRates: [] },
  ])
    assert.throws(() => spendPlan(proConfig(bad)), /SPEND_PLAN_CONFIG/);
  const now = Date.parse('2026-11-11T00:00:00Z');
  const report = billingSummary(
    spendPlan(
      proConfig({
        storageUsage: { asOf: '2026-11-10T12:00:00Z', databaseStorage: 7.5, fileStorage: 0.0013 },
      }),
    ),
    [],
    now,
  );
  assert.equal(report.classes.databaseStorage.observedUsage, 7.5);
  assert.equal(report.classes.databaseStorage.overageUsd, 0);
  assert.equal(
    report.classes.databaseStorage.normalDailyAllowance,
    null,
    'capacity is a gauge, never a daily counter',
  );
});

test('plan-aware stdin/print reports overage and list-rate columns without any provider command', t => {
  const dir = dailyDirectory(t),
    config = join(dir, 'plan.json');
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    config,
    JSON.stringify({
      stateDirectory: dir,
      deployments: ['synthetic'],
      plan: proConfig({ periodStart: today + 'T00:00:00Z' }),
    }),
  );
  const output = execFileSync(process.execPath, ['scripts/convex-spend.mjs', '--config', config, '--stdin'], {
    input: JSON.stringify(dailyEvent({ timestamp: Date.now() / 1000 })) + '\n',
    encoding: 'utf8',
  });
  assert(!output.includes('"kind":"daily"'), 'plan mode replaces the old list-price daily alerts');
  const printed = JSON.parse(
    execFileSync(process.execPath, ['scripts/convex-spend.mjs', '--config', config, '--print'], {
      encoding: 'utf8',
    }),
  );
  assert.equal(printed.billing.subscriptionMonthlyUsd, 25);
  assert.equal(printed.billing.top10[0].identifier, 'synthetic:work');
  assert.equal(typeof printed.billing.top10[0].listRateUsd, 'number');
  assert.equal(typeof printed.billing.top10[0].allocatedOverageUsd, 'number');
  assert.equal(printed.today.usage.calls, 1);
});

const { acceptedLandings } = await import('../scripts/convex-spend-model.mjs');
const { driftModel, driftSummary, driftAlerts } = await import('../scripts/convex-spend-drift.mjs');
test('landing denominator uses only one numeric marker on successful uncached mutation completions', () => {
  const marker = { udfType: 'Mutation', logLines: [{ messages: ['FORGE_ACCEPTED_LANDINGS 4'] }] };
  assert.equal(acceptedLandings(marker), 4);
  assert.equal(acceptedLandings({ ...marker, logLines: [{ messages: ["'FORGE_ACCEPTED_LANDINGS 4'"] }] }), 4);
  for (const bad of [
    { ...marker, error: 'failed' },
    { ...marker, cachedResult: true },
    { ...marker, udfType: 'action' },
    { ...marker, logLines: ['prefix FORGE_ACCEPTED_LANDINGS 4'] },
    { ...marker, logLines: ['FORGE_ACCEPTED_LANDINGS 0'] },
    { ...marker, logLines: ["'FORGE_ACCEPTED_LANDINGS 4"] },
    { ...marker, logLines: ["FORGE_ACCEPTED_LANDINGS 4'"] },
    { ...marker, logLines: ["'prefix FORGE_ACCEPTED_LANDINGS 4'"] },
    { ...marker, logLines: ['FORGE_ACCEPTED_LANDINGS 1 extra'] },
    { ...marker, logLines: ['FORGE_ACCEPTED_LANDINGS 1', 'FORGE_ACCEPTED_LANDINGS 1'] },
    { ...marker, logLines: [] },
  ])
    assert.equal(acceptedLandings(bad), 0);
});
test('rolling dollar drift stays quiet below twenty receipts and shares durable notifier deduplication across midnight', async t => {
  const journal = new SpendJournal(dailyDirectory(t));
  const now = Date.parse('2026-01-03T00:10:00Z');
  const model = driftModel();
  const append = async (at, count, id) =>
    journal.append(
      spendEvent(
        dailyEvent({
          udfType: 'mutation',
          timestamp: at / 1000,
          executionId: id,
          logLines: [`FORGE_ACCEPTED_LANDINGS ${count}`],
          usageStats: { ...dailyEvent().usageStats, databaseIoReadBytes: 1e9 },
        }),
        'synthetic',
      ),
    );
  await append(now - 20 * 60_000, 19, 'batch');
  assert.equal((await journal.drift(now)).status, 'too-few-landings');
  assert.deepEqual(driftAlerts(await journal.drift(now)), []);
  await append(now - 60_000, 1, 'solo');
  const report = await journal.drift(now);
  assert.equal(report.landings, 20);
  assert.equal(report.status, 'drift');
  const [alert] = driftAlerts(report);
  assert.equal(alert.priority, 'P0');
  assert.equal(alert.issue.key, alert.key);
  assert.equal(report.model.usdPer1000, model.usdPer1000);
  assert.equal(report.model.thresholdPct, 15);
  await journal.append({ kind: 'alert', key: alert.key, at: now });
  assert.deepEqual(driftAlerts(await new SpendJournal(journal.directory).drift(now)), []);
  assert.equal((await journal.drift(now + 86_400_000)).landings, 0);
  await append(now + 2 * 86_400_000, 20, 'later');
  assert.deepEqual(driftAlerts(await new SpendJournal(journal.directory).drift(now + 2 * 86_400_000)), []);
  assert.equal((await journal.drift(now, ['other'])).landings, 0);
});
test('drift compares matching list-rate classes and preserves unknown usage and exact threshold', () => {
  const now = Date.parse('2026-01-03T00:10:00Z'),
    model = { id: 'test', usdPer1000: 1, thresholdPct: 15 };
  const row = {
    kind: 'execution',
    at: now,
    deployment: 'one',
    acceptedLandings: 20,
    usage: { calls: 0, io: 115000000, egress: 0, compute: 0, search: 0 },
  };
  assert.equal(driftSummary([row], now, model).status, 'within-model');
  row.usage.io++;
  assert.equal(driftSummary([row], now, model).status, 'drift');
  row.usage.egress = null;
  assert.equal(driftSummary([row], now, model).status, 'unknown-usage');
  assert.deepEqual(driftAlerts(driftSummary([row], now, model)), []);
});

test('stdin meter delivers one P0 upsert payload through the existing notifier and preserves its acknowledgment', async t => {
  const dir = dailyDirectory(t),
    config = join(dir, 'config.json'),
    output = join(dir, 'issues.jsonl');
  writeFileSync(
    config,
    JSON.stringify({
      stateDirectory: join(dir, 'state'),
      deployments: ['synthetic'],
      notifier: {
        command: [
          process.execPath,
          '-e',
          "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{if(JSON.parse(s).kind==='landing-drift')require('fs').appendFileSync(process.argv[1],s)});",
          output,
        ],
        topic: 'synthetic-topic',
        target: 'synthetic-target',
      },
    }),
  );
  const log = dailyEvent({
    timestamp: Date.now() / 1000,
    udfType: 'Mutation',
    logLines: ['FORGE_ACCEPTED_LANDINGS 20'],
    usageStats: { ...dailyEvent().usageStats, databaseIoReadBytes: 1e9 },
  });
  for (let i = 0; i < 2; i++)
    execFileSync(process.execPath, ['scripts/convex-spend.mjs', '--stdin', '--config', config], {
      input: JSON.stringify(log) + '\n',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const alerts = readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].priority, 'P0');
  assert.equal(alerts[0].issue.key, alerts[0].key);
  assert.equal(alerts[0].landings, 20);
  assert.match(alerts[0].body, /partial/);
});
