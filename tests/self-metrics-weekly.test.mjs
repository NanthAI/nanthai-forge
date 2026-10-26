// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import {
  snapshotMetricWeek,
  previousMetricWeek,
  weeklyMetricTestHooks,
} from '../dist/self-metrics-weekly.js';
import { initNative } from '../dist/native-work.js';
import { selfMetricsTestHooks } from '../dist/self-metrics-journal.js';
import { cleanupOwner, waitForOwnerChildren } from './owner-cleanup.mjs';

const at = '2026-11-02T00:00:00.000Z';
const { name } = previousMetricWeek(at);
const worker = fileURLToPath(new URL('./self-metrics-weekly-fixture.mjs', import.meta.url));
function fixture(t, control) {
  const root = mkdtempSync(join(tmpdir(), 'forge-weekly-'));
  writeFileSync(join(root, 'source.txt'), 'synthetic\n');
  // Initialize evidence without also scheduling a snapshot for the real clock's
  // week: each test exercises exactly the requested boundary below.
  selfMetricsTestHooks.disabled = true;
  try {
    initNative(root);
  } finally {
    selfMetricsTestHooks.disabled = false;
  }
  writeFileSync(join(root, 'weekly-reader.json'), JSON.stringify(control));
  weeklyMetricTestHooks.worker = worker;
  t.after(async () => {
    if (existsSync(root)) await cleanupOwner(root);
    weeklyMetricTestHooks.worker = undefined;
  });
  return { root, directory: join(root, '.forge', 'work'), metrics: join(root, '.forge', 'work', 'metrics') };
}
function starts(root) {
  const path = join(root, 'weekly-worker-starts.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').length : 0;
}
function schedule(root) {
  const child = spawn(process.execPath, [worker, root, at, 'schedule'], { stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => (code === 0 ? resolve() : reject(new Error(`writer exit ${code}`))));
  });
}

test('weekly hook returns under 50 ms with a two-second reader; teardown drains the unref child', async t => {
  const { root, directory, metrics } = fixture(t, { delay: 2000 });
  const started = performance.now();
  snapshotMetricWeek(directory, at);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 50, `hook took ${elapsed} ms`);
  assert.equal(starts(root), 0, 'record collection is deferred beyond the write');
  snapshotMetricWeek(directory, at); // A second due write before launch is coalesced too.
  await waitForOwnerChildren(root);
  assert.equal(starts(root), 1);
  assert.ok(existsSync(join(metrics, name)));
  assert.ok(!existsSync(join(metrics, `.${name}.pending`)));
  const bytes = readFileSync(join(metrics, name), 'utf8');
  snapshotMetricWeek(directory, at);
  await waitForOwnerChildren(root);
  assert.equal(readFileSync(join(metrics, name), 'utf8'), bytes);
  assert.equal(starts(root), 1);
  t.diagnostic(`weekly hook ${elapsed.toFixed(3)} ms; injected reader 2000 ms`);
  await cleanupOwner(root);
  assert.ok(!existsSync(root), 'all child handles drained before owner removal');
});

test('two independent concurrent due writers launch one worker through the exclusive marker', async t => {
  const { root, metrics } = fixture(t, { delay: 1000 });
  await Promise.all([schedule(root), schedule(root)]);
  await waitForOwnerChildren(root);
  assert.equal(starts(root), 1);
  assert.ok(existsSync(join(metrics, name)));
  assert.deepEqual(readdirSync(metrics), [name]);
});

test('reader failure backs off across processes for an hour, then the next write retries', async t => {
  const { root, directory, metrics } = fixture(t, { fail: true });
  snapshotMetricWeek(directory, at);
  await waitForOwnerChildren(root);
  const failed = join(metrics, `.${name}.failed`);
  const failedAt = Date.parse(JSON.parse(readFileSync(failed, 'utf8')).at);
  assert.ok(Number.isFinite(failedAt));
  assert.ok(!existsSync(join(metrics, name)));
  assert.ok(!existsSync(join(metrics, `.${name}.pending`)));
  await schedule(root);
  await waitForOwnerChildren(root);
  assert.equal(starts(root), 1, 'fresh writer respects durable backoff');
  t.mock.timers.enable({ apis: ['Date'], now: failedAt + 60 * 60 * 1000 - 1 });
  snapshotMetricWeek(directory, at);
  await waitForOwnerChildren(root);
  assert.equal(starts(root), 1);
  t.mock.timers.tick(1);
  writeFileSync(join(root, 'weekly-reader.json'), JSON.stringify({ fail: false }));
  snapshotMetricWeek(directory, at);
  await waitForOwnerChildren(root);
  assert.equal(starts(root), 2);
  assert.ok(existsSync(join(metrics, name)));
  assert.ok(!existsSync(failed));
  assert.ok(!existsSync(join(metrics, `.${name}.pending`)));
  t.mock.timers.reset();
});

test('worker startup failure records backoff and releases only its own marker', async t => {
  const { root, directory, metrics } = fixture(t, {});
  weeklyMetricTestHooks.worker = join(root, 'missing-worker.mjs');
  snapshotMetricWeek(directory, at);
  await waitForOwnerChildren(root);
  assert.ok(existsSync(join(metrics, `.${name}.failed`)));
  assert.ok(!existsSync(join(metrics, `.${name}.pending`)));
  weeklyMetricTestHooks.worker = worker;
  snapshotMetricWeek(directory, at);
  await waitForOwnerChildren(root);
  assert.equal(starts(root), 0);
});

test('closing an owner before the deferred launch never recreates it', async t => {
  const { root, directory } = fixture(t, { delay: 2000 });
  snapshotMetricWeek(directory, at);
  rmSync(root, { recursive: true, force: true });
  await yieldTurn();
  assert.ok(!existsSync(root));
  await yieldTurn();
  assert.ok(!existsSync(root), 'no deferred writes after owner close');
});

test('a reservation left by a worker that died is taken over after the backoff', async t => {
  const { root, metrics } = fixture(t, {});
  mkdirSync(metrics, { recursive: true });
  const pending = join(metrics, `.${name}.pending`);
  writeFileSync(pending, 'dead-worker');
  const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  utimesSync(pending, old, old);
  await schedule(root);
  await waitForOwnerChildren(root);
  assert.equal(starts(root), 1);
  assert.ok(existsSync(join(metrics, name)));
  assert.ok(!existsSync(pending));
});
