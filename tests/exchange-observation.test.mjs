// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { exchangeFetch } from '../dist/exchange-request.js';
import { withExchangeObservation } from '../dist/exchange-observation.js';

test('receipts measure actual RPC retries, request/response bodies and elapsed time without a billing estimate', async t => {
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _ of request) {
      /* consume */
    }
    if (++calls === 1) {
      response.writeHead(503);
      response.end();
    } else {
      response.end('response');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}/api/action`;
  const { value, observation } = await withExchangeObservation(async () => {
    const result = await exchangeFetch(
      'synthetic RPC',
      url,
      { method: 'POST', body: 'request' },
      { retries: 1, delayMs: 0 },
    );
    return result.text();
  });
  assert.equal(value, 'response');
  assert.deepEqual(observation.measured, {
    requests: 2,
    rpcRequests: 2,
    requestBodyBytes: 14,
    responseBodyBytes: 8,
  });
  assert.ok(observation.elapsedMs >= 0);
  assert.equal(observation.estimatedUsd, null);
  assert.equal(observation.billedUsd, null);
  assert.doesNotMatch(JSON.stringify(observation), /request"|response"|http/);
});

test('concurrent exchange observations keep their byte counts separate', async () => {
  const result = await Promise.all(
    [1, 3].map(n =>
      withExchangeObservation(async () => {
        const response = await exchangeFetch('synthetic body', `data:text/plain,${'x'.repeat(n)}`);
        return response.text();
      }),
    ),
  );
  assert.deepEqual(
    result.map(item => item.observation.measured.responseBodyBytes),
    [1, 3],
  );
});
