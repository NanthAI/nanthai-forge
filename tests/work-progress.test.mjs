// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { withWorkProgress, workProgress } from '../dist/work-progress.js';

test('progress elapsed resets per phase and total age retains the operation start', () => {
  const originalNow = Date.now,
    originalWrite = process.stderr.write;
  const output = [];
  let now = 1000;
  Date.now = () => now;
  process.stderr.write = line => {
    output.push(line);
    return true;
  };
  try {
    withWorkProgress({ operationId: 'test' }, () => {
      workProgress('queued', 'waiting');
      now += 65000;
      workProgress('queued', 'waiting');
      withWorkProgress({ phase: 'landing' }, () => {
        workProgress('landing', 'ready');
        now += 2000;
        workProgress('landing', 'accepted');
      });
    });
  } finally {
    Date.now = originalNow;
    process.stderr.write = originalWrite;
  }
  assert.match(output[1], /elapsed=65s totalAge=65s/);
  assert.match(output[2], /elapsed=0s totalAge=65s/);
  assert.match(output[3], /elapsed=2s totalAge=67s/);
});

test('a retry run reports running immediately even when its details match the previous run', t => {
  const output = [];
  t.mock.method(Date, 'now', () => 10000);
  t.mock.method(process.stderr, 'write', line => {
    output.push(line);
    return true;
  });
  withWorkProgress({ operationId: 'finish' }, () => {
    for (const runId of ['first', 'retry'])
      withWorkProgress({ runId }, () => {
        workProgress('running check', 'queue position=1 holder=runner');
        workProgress('running check', 'queue position=1 holder=runner');
      });
  });
  assert.equal(output.length, 2);
  assert.match(output[0], /run=first /);
  assert.match(output[1], /run=retry /);
});

test('scoped reporters observe existing callbacks and suppress handled lines without timers', async t => {
  const { withWorkProgressReporter, observeWorkProgress } = await import('../dist/work-progress.js');
  const observed = [],
    output = [];
  t.mock.method(process.stderr, 'write', line => {
    output.push(line);
    return true;
  });
  await withWorkProgressReporter(
    phase => {
      observed.push(phase);
      return phase === 'running check';
    },
    async () => {
      workProgress('running check', 'one');
      await Promise.resolve();
      workProgress('running check', 'one');
      observeWorkProgress();
      workProgress('other', 'retained diagnostic');
    },
  );
  workProgress('outside', 'normal');
  assert.deepEqual(observed, ['running check', 'running check', 'observation', 'other']);
  assert.equal(output.length, 2);
  assert.match(output[0], /retained diagnostic/);
});
