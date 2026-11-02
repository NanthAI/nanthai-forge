// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { retryHostedObservation } from '../dist/hosted-observation-retry.js';
import { exchangeFetch } from '../dist/exchange-request.js';
import { ForgeError } from '../dist/errors.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
test('an outage backs off at 2 4 8 16 30 seconds, respects the original deadline and stops all reads', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reads = [],
    events = [];
  const waiting = retryHostedObservation({
    timeoutSeconds: 50,
    emit: e => events.push(e),
    attempt: async () => {
      reads.push(now);
      throw new ForgeError('EXCHANGE_REQUEST_FAILED', 'HTTP 502');
    },
    pending: status => ({ status, inProgress: true }),
  });
  await turn();
  for (const ms of [2000, 4000, 8000, 16000, 20000]) {
    now += ms;
    t.mock.timers.tick(ms);
    await turn();
  }
  assert.deepEqual(await waiting, { status: 'timeout', inProgress: true });
  assert.deepEqual(reads, [0, 2000, 6000, 14000, 30000]);
  assert.deepEqual(
    events.map(e => e.retryAfterMs),
    [2000, 4000, 8000, 16000, 30000],
  );
  now += 100000;
  t.mock.timers.tick(100000);
  await turn();
  assert.equal(reads.length, 5, 'no retry or observer survives the deadline');
});

test('healthy and definitive failures do not retry or add calls', async () => {
  for (const failure of [null, 'AUTH_REVOKED', 'HOSTED_PROTOCOL_INVALID', 'SOURCE_UNAVAILABLE']) {
    let reads = 0;
    const waiting = retryHostedObservation({
      timeoutSeconds: 600,
      emit: () => assert.fail('no retry progress'),
      attempt: async () => {
        reads++;
        if (failure) throw new ForgeError(failure, 'Definite error');
        return 'landed';
      },
      pending: () => 'pending',
    });
    if (failure) await assert.rejects(waiting, { code: failure });
    else assert.equal(await waiting, 'landed');
    assert.equal(reads, 1);
  }
});

test('the wait deadline cancels its in-flight HTTP read so network handles cannot outlive the command', async t => {
  let calls = 0,
    aborted = 0;
  t.mock.method(globalThis, 'fetch', (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        'abort',
        () => {
          aborted++;
          reject(init.signal.reason);
        },
        { once: true },
      );
    });
  });
  const result = await retryHostedObservation({
    timeoutSeconds: 0.01,
    emit: () => assert.fail('no retry before the deadline'),
    attempt: () => exchangeFetch('selected observation', 'https://fixture.invalid'),
    pending: status => ({ status }),
  });
  assert.equal(result.status, 'timeout');
  assert.equal(calls, 1);
  assert.equal(aborted, 1);
});
