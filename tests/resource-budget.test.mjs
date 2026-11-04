// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuMilliseconds, retainedBytes, runResourceWorker } from './resource-budget.mjs';

test('CPU accounting excludes scheduling delay and includes user plus system work', t => {
  const start = { user: 1200, system: 300 };
  t.mock.method(process, 'cpuUsage', previous => {
    assert.equal(previous, start);
    return { user: 2500, system: 500 };
  });
  t.mock.method(performance, 'now', () => assert.fail('wall clock is not a CPU budget'));
  assert.equal(cpuMilliseconds(start), 3);
});

test('retained memory requires explicit GC and counts heap plus backing buffers', t => {
  let collected = false;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'gc');
  Object.defineProperty(globalThis, 'gc', {
    configurable: true,
    value: () => {
      collected = true;
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'gc', previous);
    else delete globalThis.gc;
  });
  t.mock.method(process, 'memoryUsage', () => {
    assert(collected, 'collect before sampling');
    return { heapUsed: 100, arrayBuffers: 200, external: 500, rss: 1000 };
  });
  assert.equal(retainedBytes(), 300);
});

test('large resource fixtures use file delivery and an ignored stdin', () => {
  const input = { text: 'x'.repeat(32 * 1024 * 1024) };
  const result = runResourceWorker('./resource-budget-payload.mjs', input);
  assert.deepEqual(result, { bytes: input.text.length, stdinBytes: 0 });
});
