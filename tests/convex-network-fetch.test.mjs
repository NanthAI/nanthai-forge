// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const { convexFetch, networkTimeout } = await import(moduleUrl('../convex/networkFetch.ts'));
const { classifyDispatchFailure } = await import(moduleUrl('../convex/projectHostedActionsDirect.ts'));

// Issue aabe52a7: Convex actions share the CLI transport's deadlines.
test('convexFetch rejects at the caller budget even when the transport ignores its signal', async () => {
  const started = performance.now();
  await assert.rejects(
    convexFetch(
      'https://example.invalid/',
      { signal: networkTimeout(50) },
      { request: () => new Promise(() => {}) },
    ),
    error => error.code === 'EXCHANGE_REQUEST_TIMEOUT',
  );
  assert(performance.now() - started < 2_000);
});

test('convexFetch bounds a response with no caller budget', async () => {
  await assert.rejects(
    convexFetch(
      'https://example.invalid/',
      {},
      { request: () => new Promise(() => {}), headerTimeoutMs: 50 },
    ),
    error => error.code === 'EXCHANGE_REQUEST_TIMEOUT',
  );
});

test('convexFetch adds no calls: a failing read is not retried', async () => {
  let calls = 0;
  const response = await convexFetch(
    'https://example.invalid/',
    {},
    {
      request: async () => (calls++, new Response('busy', { status: 503 })),
    },
  );
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'busy');
  assert.equal(calls, 1);
});

test('dispatch classification keeps timeouts from the shared transport', async () => {
  const error = await convexFetch(
    'https://example.invalid/',
    { method: 'POST', signal: networkTimeout(20) },
    { request: () => new Promise(() => {}) },
  ).catch(caught => caught);
  assert.deepEqual(classifyDispatchFailure(undefined, error, 'dispatch'), {
    outcome: 'unknown',
    failure: 'timeout',
  });
  assert.deepEqual(classifyDispatchFailure(undefined, new TypeError('fetch failed'), 'dispatch'), {
    outcome: 'unknown',
    failure: 'network',
  });
});
