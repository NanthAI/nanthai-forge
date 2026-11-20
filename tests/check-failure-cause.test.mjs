// SPDX-License-Identifier: Apache-2.0
// Failure-cause contract (Item 2c420916): one cause, four suspects in a fixed order and one next recovery
// from retained evidence; unknown and missing evidence are said, never guessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { failureCause, failureCauseField, failureSuspects } from '../dist/check-failure-cause.js';

const lane = { paths: ['src/adapters/fetch.ts'], tests: [] };
const green = { result: 'passed', redSince: null };
const failedRun = (failed, extra = {}) => ({ status: 'failed', failed, ...extra });
const verdicts = cause => Object.fromEntries(cause.suspects.map(item => [item.suspect, item.verdict]));

test('a failing test that covers the changed file names the change and says fix it in this Lane', () => {
  const cause = failureCause({
    landing: { state: 'check-failed' },
    run: failedRun([{ file: 'tests/fetch.test.ts', firstError: 'expected 4 to equal 3' }]),
    lane,
    main: green,
  });
  assert.equal(cause.cause, 'change');
  assert.equal(cause.next.recovery, 'fix-in-lane');
  assert.deepEqual(
    cause.suspects.map(item => item.suspect),
    [...failureSuspects],
  );
  assert.deepEqual(verdicts(cause), { change: 'yes', test: 'unlikely', main: 'no', ci: 'no' });
  assert.match(cause.sentence, /^Your change: tests\/fetch\.test\.ts/);
});

test('a test that failed before on unchanged code and does not cover the change is a flake with a recorded retry reason', () => {
  const cause = failureCause({
    landing: { state: 'check-failed' },
    run: failedRun([{ file: 'tests/stream-backpressure.test.ts' }], {
      knownFlaky: ['tests/stream-backpressure.test.ts'],
    }),
    lane: { paths: ['.github/workflows/ci.yml'] },
    main: green,
  });
  assert.equal(cause.cause, 'flaky-test');
  assert.equal(cause.next.recovery, 'retry');
  assert.equal(cause.next.retryReason, 'flake');
  assert.equal(verdicts(cause).test, 'likely');
});

test('main failing on a file this Lane does not touch says so with the time main went red', () => {
  const cause = failureCause({
    landing: { state: 'check-failed' },
    run: failedRun([{ file: 'tests/drain.test.ts', firstError: 'queue.shiftMany is not a function' }]),
    lane: { paths: ['.github/workflows/ci.yml'] },
    main: { result: 'failed', redSince: '2026-11-17T09:41:00.000Z' },
  });
  assert.equal(cause.cause, 'main-failing');
  assert.equal(cause.next.recovery, 'wait-for-main');
  assert.equal(cause.mainFailingSince, '2026-11-17T09:41:00.000Z');
  assert.equal(verdicts(cause).main, 'yes');
});

test('a landing held while main is red is main, never the change', () => {
  const cause = failureCause({
    landing: { state: 'held-main-red' },
    main: { result: 'failed', redSince: 'x' },
  });
  assert.equal(cause.cause, 'main-failing');
  assert.equal(verdicts(cause).change, 'not-judged');
});

test('a runner that never started the check is the CI provider and the code was not judged', () => {
  const waiting = failureCause({ landing: { state: 'waiting-for-runner' }, main: green });
  assert.equal(waiting.cause, 'ci-not-started');
  assert.equal(waiting.next.recovery, 'wait');
  const ended = failureCause({ landing: { state: 'not-run' }, run: { status: 'runner-unavailable' } });
  assert.equal(ended.next.retryReason, 'infra');
  assert.deepEqual(verdicts(ended), {
    change: 'not-judged',
    test: 'not-judged',
    main: 'not-reported',
    ci: 'yes',
  });
  const stopped = failureCause({ run: { status: 'interrupted' }, main: green });
  assert.equal(stopped.cause, 'ci-stopped');
});

test('main moving under the check is not a failure and retries with the main-moved reason', () => {
  const cause = failureCause({ landing: { state: 'stale-head' } });
  assert.equal(cause.cause, 'main-moved');
  assert.equal(cause.next.retryReason, 'main-moved');
});

test('without the changed files or any attribution the cause is unknown and says what was not reported', () => {
  const cause = failureCause({
    landing: { state: 'check-failed' },
    run: failedRun([{ file: 'tests/x.test.ts' }]),
  });
  assert.equal(cause.cause, 'unknown');
  assert.equal(cause.next.recovery, 'read-log');
  assert.deepEqual(verdicts(cause), {
    change: 'not-reported',
    test: 'not-reported',
    main: 'not-reported',
    ci: 'no',
  });
  // A failed landing whose run is not in hand still gets an honest answer.
  assert.equal(failureCause({ landing: { state: 'check-failed' } }).cause, 'unknown');
});

test('nothing to explain: running, passed, landed, cancelled and unconfirmed states return no cause', () => {
  for (const state of ['checking', 'queued', 'landed', 'cancelled', 'conflict', 'unknown'])
    assert.equal(failureCause({ landing: { state } }), null, state);
  assert.equal(failureCause({ run: { status: 'passed' } }), null);
  assert.equal(failureCause({ run: { status: 'running' } }), null);
  assert.equal(failureCause({ run: { status: 'cancelled' } }), null);
});

test('many failing files stay bounded and the count reconciles with the list', () => {
  const failed = Array.from({ length: 214 }, (_, i) => ({
    file: `tests/a${i}.test.ts`,
    firstError: 'x'.repeat(900),
  }));
  const cause = failureCause({ run: failedRun(failed, { failedCount: 214 }), lane, main: green });
  assert.equal(cause.failing.length, 20);
  assert.equal(cause.failingCount, 214);
  assert(cause.failing.every(item => item.firstError.length <= 240));
  assert.match(cause.sentence, /213 more failing files/);
});

test('the agent field carries the same cause, recovery and suspects in a compact shape', () => {
  const field = failureCauseField(
    failureCause({ landing: { state: 'held-main-red' }, main: { result: 'failed', redSince: 't' } }),
  );
  assert.deepEqual(Object.keys(field.suspects), [...failureSuspects]);
  assert.equal(field.recovery, 'wait-for-main');
  assert.equal(field.mainFailingSince, 't');
  assert.equal(failureCauseField(null), null);
});

test('43b51a5e: a passed landing waiting for an older one to take main has no failure cause', () => {
  assert.equal(failureCause({ landing: { state: 'waiting-for-order' }, run: { status: 'passed' } }), null);
  assert.equal(failureCause({ landing: { state: 'waiting-for-order' } }), null);
});
