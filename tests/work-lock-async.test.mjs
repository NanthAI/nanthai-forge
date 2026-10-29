// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, unlinkSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { processIdentity } from '../dist/local-process.js';
import { workLocked, workLockedAsync, observeWorkLocks } from '../dist/work-lock.js';
import { detachedChecksRequired } from '../dist/check-execution-context.js';
import {
  withLandingWorker,
  withoutLandingWorker,
  landingWorkerSignal,
} from '../dist/landing-worker-context.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-async-lock-')),
    path = join(root, 'lock');
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  t.mock.method(process.stderr, 'write', () => true);
  return { root, path };
}

test('asynchronous Work admission retains FIFO tickets and lets timers release a legacy holder', async t => {
  const { path } = fixture(t);
  writeFileSync(path, JSON.stringify({ ...processIdentity(), host: hostname(), operation: 'legacy writer' }));
  const order = [],
    spans = [];
  let timerAt;
  const first = observeWorkLocks(
    span => spans.push(span),
    () => workLockedAsync(path, () => order.push(1), { waitMs: 2000 }),
  );
  const second = workLockedAsync(path, () => order.push(2), { waitMs: 2000 });
  const tickets = readdirSync(`${path}-queue`).sort();
  assert.equal(tickets.length, 2);
  const begin = performance.now();
  await delay(80);
  timerAt = performance.now();
  assert.deepEqual(
    readdirSync(`${path}-queue`).sort(),
    tickets,
    'waiting preserves the original ticket identities',
  );
  unlinkSync(path);
  await Promise.all([first, second]);
  assert.deepEqual(order, [1, 2]);
  assert.equal(spans.length, 1);
  assert.ok(spans[0].waitMs >= 80);
  assert.ok(timerAt - begin < 180, `timer lag exceeded 100ms: ${timerAt - begin - 80}`);
  assert.deepEqual(readdirSync(`${path}-queue`), []);
  assert.equal(existsSync(path), false);
  t.diagnostic(`80ms timer fired after ${(timerAt - begin).toFixed(2)}ms during FIFO Work-lock contention`);
});

test('async timeout and cancellation preserve ambiguous legacy locks and clean their tickets', async t => {
  const { path } = fixture(t);
  writeFileSync(path, '{unpublished');
  await assert.rejects(
    workLockedAsync(path, () => assert.fail(), { waitMs: 30 }),
    { code: 'WORK_BUSY' },
  );
  let cancelled = false;
  const pending = workLockedAsync(path, () => assert.fail(), { cancelled: () => cancelled, waitMs: 2000 });
  await delay(20);
  cancelled = true;
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(existsSync(path), true);
  assert.deepEqual(readdirSync(`${path}-queue`), []);
});

test('owner driver legacy synchronous call sites never wait on the event loop', async t => {
  const { path } = fixture(t);
  writeFileSync(path, '{unpublished');
  const began = performance.now();
  withLandingWorker(new AbortController().signal, () => {
    assert.equal(detachedChecksRequired(), false, 'local checks keep the owner controller lifecycle');
    assert.throws(() => workLocked(path, () => assert.fail(), { waitMs: 150 }), { code: 'WORK_BUSY' });
  });
  assert.ok(performance.now() - began < 50, 'legacy owner call must yield to its receipt-reconciled retry');
  const before = performance.now();
  assert.throws(() => workLocked(path, () => assert.fail(), { waitMs: 150 }), { code: 'WORK_BUSY' });
  const blocked = performance.now() - before;
  const asyncStart = performance.now();
  let timerAt;
  const pending = workLockedAsync(path, () => assert.fail(), { waitMs: 150 });
  await delay(10);
  timerAt = performance.now();
  await assert.rejects(pending, { code: 'WORK_BUSY' });
  assert.ok(timerAt - asyncStart < 110);
  t.diagnostic(
    `finite sync compatibility wait blocked ${blocked.toFixed(2)}ms; async waiter 10ms timer fired in ${(timerAt - asyncStart).toFixed(2)}ms; owner sync attempt ${(before - began).toFixed(2)}ms`,
  );
});

test('a registered detached execution handoff outlives its aborted hosting driver', () => {
  const controller = new AbortController();
  withLandingWorker(controller.signal, () => {
    controller.abort();
    assert.equal(landingWorkerSignal().aborted, true);
    withoutLandingWorker(() => assert.equal(landingWorkerSignal(), undefined));
    assert.equal(landingWorkerSignal().aborted, true);
  });
});
