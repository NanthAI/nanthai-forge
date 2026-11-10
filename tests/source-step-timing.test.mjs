// SPDX-License-Identifier: Apache-2.0
// Server-phase split of a hosted sync (friction 84c1497f): what each step reports, what the step row
// keeps, what the receipt derives, and when the step's own result skips the complete action.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { sourceStepClock } from '../dist/source-step-clock.js';
import { serverSyncTiming, syncTiming } from '../dist/sync-timing.js';
import { digest } from '../dist/portable-hash.js';
const { recordSourceStep, sourceR2Counts } = await import(moduleUrl('../convex/projectSourceStepTiming.ts'));
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

test('a step reports the R2 requests its isolate signed since it began, and the step row sums them past 16 steps', () => {
  let signed = { a: 10, b: 20, put: 100 };
  const clock = sourceStepClock(undefined, () => ({ ...signed }));
  signed = { a: 12, b: 29, put: 1700 };
  const step = clock.value();
  assert.deepEqual([step.r2a, step.r2b, step.r2put], [2, 9, 1600]);
  assert.equal(sourceStepClock().value().r2a, undefined, 'a clock with no meter reports none');
  let t = { queuedAt: 0, scheduledAt: 0, steps: [] };
  for (let i = 0; i < 20; i++)
    t = recordSourceStep(t, report(10, { r2a: 2, r2b: 9, r2put: 1600 }), 10 + i, i === 19);
  assert.equal(t.steps.length, 16);
  assert.deepEqual(
    sourceR2Counts(t),
    [40, 180, 32_000],
    'folding keeps the sum, so a long step chain still counts every request',
  );
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

test('the step row keeps each step phase, stop reason and read kinds, and folds them past 16 steps', () => {
  let t = { queuedAt: 0, scheduledAt: 0, steps: [] };
  const detail = (phase, stop) => ({ phase, stop, states: 2, pages: 1, blobs: 3 });
  t = recordSourceStep(t, report(10, detail('input>graph', 'bytes')), 100, false);
  assert.deepEqual(
    { phase: t.steps[0].phase, stop: t.steps[0].stop, states: t.steps[0].states, blobs: t.steps[0].blobs },
    { phase: 'input>graph', stop: 'bytes', states: 2, blobs: 3 },
  );
  for (let i = 0; i < 16; i++)
    t = recordSourceStep(
      t,
      report(
        t.scheduledAt + 1,
        detail(i < 15 ? 'graph>graph' : 'graph>compute', i < 15 ? 'fanout' : 'window'),
      ),
      t.scheduledAt + 10,
      false,
    );
  assert.equal(t.steps.length, 16);
  const last = t.steps[15];
  assert.equal(last.phase, 'graph>compute', 'a folded entry spans its first to its last phase');
  assert.equal(last.stop, 'window', 'and keeps the last stop reason');
  assert.equal(last.states, 4, 'counts add up');
  // Older workers report no detail; the entry stays numbers only.
  t = recordSourceStep({ queuedAt: 0, scheduledAt: 0, steps: [] }, report(5), 9, true);
  assert.equal(t.steps[0].phase, undefined);
  assert.equal(t.steps[0].stop, undefined);
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
