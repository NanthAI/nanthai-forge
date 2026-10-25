// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  sampleSelfMetricDisk,
  scanSelfMetricDisk,
  readSelfMetricDisk,
  setSelfMetricDiskBudget,
  defaultDiskBudget,
} from '../dist/self-metrics-disk.js';
import { readSelfMetricReceipts, recordOwnerMutation } from '../dist/self-metrics-journal.js';
import { calculateSelfMetrics } from '../dist/self-metrics.js';
import { hostedSelfMetricsReader } from '../dist/self-metrics-hosted.js';
import { pendingStatus } from '../dist/pending-status.js';
import { formatPendingStatus } from '../dist/pending-status-format.js';
const at = day => `2026-10-${day}T12:00:00.000Z`;
const localBytes = bytes => ({ objects: bytes, records: 0, lanes: 0, checks: 0, snapshots: 0, backups: 0 });
const measurement = bytes => ({
  localBytes: localBytes(bytes),
  freeBytes: 100_000,
  complete: true,
  scannedEntries: 6,
});
const withDir = fn => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-m2-disk-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('disk counts six disjoint kinds and registered backups, ignores symlink targets and reports owner free space', () =>
  withDir(dir => {
    const paths = [
      ['objects/blob', 10],
      ['records/page', 20],
      [`lane-${'a'.repeat(8)}-aaaa-aaaa-aaaa-${'a'.repeat(12)}/file`, 30],
      ['check-run/log', 40],
      ['auto-snapshots/snapshot.json', 50],
      ['native-backup-copy/blob', 60],
      ['ignored/file', 200],
    ];
    for (const [path, bytes] of paths) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), Buffer.alloc(bytes));
    }
    symlinkSync(join(dir, 'ignored'), join(dir, 'objects', 'redirect'));
    const backup = join(dir, 'external-backup');
    mkdirSync(backup);
    writeFileSync(join(backup, 'data'), Buffer.alloc(7));
    writeFileSync(join(dir, 'record-collection-backups.json'), JSON.stringify([{ path: backup }]));
    const sample = scanSelfMetricDisk(dir, { entries: 100, milliseconds: 10_000 });
    assert.deepEqual(sample.localBytes, {
      objects: 10,
      records: 20,
      lanes: 30,
      checks: 40,
      snapshots: 50,
      backups: 67,
    });
    assert.equal(sample.complete, true);
    assert.equal(typeof sample.freeBytes, 'number');
    assert.ok(sample.freeBytes > 0);
  }));

test('disk scan stops at its hard entry bound even with 1,400 work directories', () =>
  withDir(dir => {
    for (let i = 0; i < 1400; i++) mkdirSync(join(dir, `check-${i}`));
    const sample = scanSelfMetricDisk(dir, { entries: 32, milliseconds: 10_000 });
    assert.equal(sample.complete, false);
    assert.ok(sample.scannedEntries <= 33);
    assert.equal(sampleSelfMetricDisk(dir, at('25'), () => sample).growthBytesPerDay, null);
  }));

test('write-triggered daily sampling survives restart/retry and emits one retained status warning across many writes', () =>
  withDir(dir => {
    let scans = 0;
    setSelfMetricDiskBudget(dir, {
      maxBytes: 1000,
      maxGrowthBytesPerDay: 100,
      minFreeBytes: 1000,
      lookaheadDays: 1,
    });
    const scan = () => {
      scans++;
      return measurement(scans === 1 ? 100 : 300);
    };
    sampleSelfMetricDisk(dir, at('24'), scan);
    const growing = sampleSelfMetricDisk(dir, at('25'), scan);
    for (let n = 0; n < 100; n++) sampleSelfMetricDisk(dir, at('25'), scan);
    assert.equal(scans, 2);
    assert.equal(growing.growthBytesPerDay, 200);
    assert.match(growing.warning, /growth/);
    const receipts = readSelfMetricReceipts(dir);
    assert.equal(receipts.filter(r => r.disk?.warning).length, 1);
    const status = pendingStatus(
      { revision: 1, lanes: [], views: [], runs: [], channelMoves: [] },
      { disk: readSelfMetricDisk(dir) },
      at('25'),
    );
    assert.equal(
      formatPendingStatus(status)
        .split('\n')
        .filter(line => line.startsWith('Disk:')).length,
      1,
    );
    // The durable claim still prevents a scan if the disposable latest pointer was lost.
    rmSync(join(dir, 'self-metrics-disk.json'));
    sampleSelfMetricDisk(dir, at('25'), scan);
    assert.equal(scans, 2);
  }));

test('disk warns on projected bytes and free-space reserve before crossing either budget', () =>
  withDir(dir => {
    setSelfMetricDiskBudget(dir, {
      maxBytes: 1000,
      maxGrowthBytesPerDay: 1000,
      minFreeBytes: 100,
      lookaheadDays: 1,
    });
    sampleSelfMetricDisk(dir, at('24'), () => ({ ...measurement(400), freeBytes: 600 }));
    const next = sampleSelfMetricDisk(dir, at('25'), () => ({ ...measurement(700), freeBytes: 350 }));
    assert.match(next.warning, /project bytes/);
    assert.match(next.warning, /free space/);
    assert.ok(Object.values(next.localBytes).reduce((a, b) => a + b, 0) < 1000);
    assert.ok(next.freeBytes > 100);
  }));

test('disk reports day/landing growth, hosted and R2 bytes from records without scanning', () => {
  const samples = [100, 300].map((bytes, i) => ({
    at: at(String(24 + i)),
    ...measurement(bytes),
    budget: defaultDiskBudget,
    growthBytesPerDay: i ? 200 : null,
    warning: null,
  }));
  const record = {
    receipts: [],
    submissions: [],
    runs: [],
    gaps: [],
    diskSamples: samples,
    moves: [{ id: 'one', head: 'h', at: at('25'), kind: 'landing', inputs: [] }],
    observations: [24, 25].map((day, i) => ({
      type: 'storage',
      id: `storage-${day}`,
      at: at(String(day)),
      hostedBytes: 200 + i * 100,
      r2Bytes: 500 + i * 50,
      basis: 'Retained upload accounting',
    })),
  };
  const m = calculateSelfMetrics(record, { from: at('24'), to: '2026-10-26T00:00:00.000Z' }).disk;
  assert.equal(m.growthBytesPerDay, 200);
  assert.equal(m.growthBytesPerLanding, 200);
  assert.equal(m.hostedBytes, 300);
  assert.equal(m.r2Bytes, 550);
  assert.deepEqual(m.hostedGrowth, { bytes: 100, bytesPerDay: 100, bytesPerLanding: 100 });
  assert.equal(m.partial, false);
});

test('idle projects perform zero further filesystem scans or Convex calls; repeated status reads stay read-only', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-m2-idle-'));
  let scans = 0,
    convexCalls = 0;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.parse(at('25')) });
  for (const name of ['opendirSync', 'readdirSync', 'statfsSync']) {
    const original = fs[name];
    t.mock.method(fs, name, (...args) => {
      scans++;
      return original(...args);
    });
  }
  syncBuiltinESMExports();
  try {
    hostedSelfMetricsReader({
      records: async () => {
        convexCalls++;
        return [];
      },
    });
    recordOwnerMutation(dir, 1);
    const afterWrite = scans;
    assert.ok(afterWrite > 0);
    const before = readFileSync(join(dir, 'self-metrics.jsonl'));
    for (let i = 0; i < 10; i++) readSelfMetricDisk(dir);
    for (let i = 0; i < 10; i++) recordOwnerMutation(dir, i + 2);
    assert.equal(scans, afterWrite);
    const idleBytes = readFileSync(join(dir, 'self-metrics.jsonl'));
    t.mock.timers.tick(90 * 24 * 60 * 60 * 1000);
    await Promise.resolve();
    assert.equal(scans, afterWrite);
    assert.equal(convexCalls, 0);
    assert.deepEqual(readFileSync(join(dir, 'self-metrics.jsonl')), idleBytes);
    assert.ok(idleBytes.length > before.length);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});
