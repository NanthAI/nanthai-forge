// SPDX-License-Identifier: Apache-2.0
// Server-phase split of a hosted sync (friction 84c1497f): what each step reports, what the step row
// keeps, what the receipt derives, and when the step's own result skips the complete action.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { sourceStepClock } from '../dist/source-step-clock.js';
import { serverSyncTiming, syncTiming } from '../dist/sync-timing.js';
import { digest } from '../dist/portable-hash.js';
const { recordSourceStep } = await import(moduleUrl('../convex/projectSourceStepTiming.ts'));
const { inlineSourceResult } = await import(moduleUrl('../convex/projectConvexSourceStore.ts'));

const report = (startedAt, extra = {}) => ({
  startedAt,
  runMs: 900.4,
  readMs: 300,
  writeMs: 100,
  callMs: 200,
  calls: 3,
  reads: 2,
  writes: 1,
  ...extra,
});

test('the step clock counts overlapping I/O of one kind once and holds a read until its body is consumed', async () => {
  const clock = sourceStepClock(Date.now() - 50);
  let release;
  const gate = new Promise(resolve => (release = resolve));
  const a = clock.call(() => gate),
    b = clock.call(() => gate);
  const body = await clock.read(async () =>
    (async function* () {
      yield new Uint8Array(1);
    })(),
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  await Promise.all([a, b]);
  const open = clock.value();
  assert.equal(open.calls, 2);
  assert.equal(open.reads, 1);
  assert(open.callMs >= 15 && open.callMs <= open.runMs, 'two concurrent calls count as one span');
  assert(open.readMs >= open.callMs, 'the unread body is still in flight');
  for await (const chunk of body) assert.equal(chunk.length, 1);
  const settled = clock.value().readMs;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(clock.value().readMs, settled, 'a consumed read stops counting');
  assert(clock.value().bootMs >= 50);
  assert.equal(sourceStepClock().value().bootMs, undefined);
});

test('the step row appends each reported step with its scheduling wait and folds past 16 steps', () => {
  let t = { queuedAt: 1000, scheduledAt: 1000, steps: [] };
  t = recordSourceStep(t, report(1400, { bootMs: 250 }), 2400, false);
  assert.deepEqual(t.steps[0], {
    waitMs: 400,
    runMs: 900,
    readMs: 300,
    writeMs: 100,
    callMs: 200,
    calls: 3,
    reads: 2,
    writes: 1,
    bootMs: 250,
  });
  assert.equal(t.scheduledAt, 2400);
  assert.equal(t.doneAt, undefined);
  // A step that reports nothing (an older worker) still moves the scheduling mark.
  t = recordSourceStep(t, undefined, 2500, false);
  assert.equal(t.scheduledAt, 2500);
  assert.equal(t.steps.length, 1);
  for (let i = 0; i < 20; i++)
    t = recordSourceStep(t, report(t.scheduledAt + 10), t.scheduledAt + 1000, i === 19);
  assert.equal(t.steps.length, 16, 'the row stays bounded');
  assert.equal(
    t.steps.slice(1).reduce((sum, step) => sum + step.calls, 0),
    60,
    'folded steps keep their counts',
  );
  assert.equal(t.doneAt, t.scheduledAt + 1000);
  assert.equal(
    recordSourceStep(undefined, report(1), 2, true),
    undefined,
    'rows from before the change stay as they are',
  );
});

test('the receipt splits hostedWait into dispatch, steps, publication and the client watch', () => {
  const progress = {
    state: {
      submittedAt: 10_000,
      serverTiming: {
        queuedAt: 10_120,
        scheduledAt: 11_000,
        steps: [{ waitMs: 30, runMs: 4000 }],
        doneAt: 15_000,
        publishedAt: 15_250,
      },
    },
  };
  assert.deepEqual(serverSyncTiming(progress, 5600), {
    dispatchMs: 120,
    steps: [{ waitMs: 30, runMs: 4000 }],
    publishMs: 250,
    watchMs: 350,
  });
  assert.equal(
    serverSyncTiming({ state: { status: 'submitted' } }, 10),
    undefined,
    'older servers report nothing',
  );
  assert.equal(serverSyncTiming(undefined, 10), undefined);
  const clock = [0, 6000];
  const timing = syncTiming(() => clock.shift());
  timing.mark('hostedWait');
  timing.server(progress);
  assert.equal(timing.value().server.watchMs, 750);
});

test('only a small save, sync or compose result that matches the signed output skips the complete action', () => {
  const result = JSON.stringify({ files: ['a'] }),
    output = { sha256: digest(result), size: new TextEncoder().encode(result).length };
  assert.equal(inlineSourceResult('sync', output, result), true);
  assert.equal(inlineSourceResult('save', output, result), true);
  assert.equal(inlineSourceResult('compose', output, result), true, 'a small compose result too');
  assert.equal(inlineSourceResult('register-state', output, result), false, 'no publish mutation');
  assert.equal(inlineSourceResult('sync', output, undefined), false, 'no text: read it back');
  assert.equal(inlineSourceResult('sync', null, result), false, 'a failure has no output');
  assert.equal(inlineSourceResult('sync', { ...output, sha256: digest('other') }, result), false);
  assert.equal(inlineSourceResult('sync', { ...output, size: output.size + 1 }, result), false);
  const big = 'x'.repeat(64 * 1024 + 1);
  assert.equal(inlineSourceResult('sync', { sha256: digest(big), size: big.length }, big), false);
});
