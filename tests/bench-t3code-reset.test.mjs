// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, retryResetRequest, rulesetName } from '../scripts/bench-t3code/github-arm.mjs';

for (const message of [
  'HTTP 504: Gateway Timeout',
  'GraphQL: Something went wrong (HTTP 504)',
  'HTTP 502: Bad Gateway',
])
  test(`reset request retries ${message} with bounded backoff`, async () => {
    const failure = Object.assign(Error('gh failed'), { stderr: message });
    let calls = 0;
    const delays = [];
    assert.equal(
      await retryResetRequest(
        () => {
          if (++calls < 4) throw failure;
          return 'ok';
        },
        async ms => delays.push(ms),
      ),
      'ok',
    );
    assert.equal(calls, 4);
    assert.deepEqual(delays, [1000, 2000, 4000]);
    calls = 0;
    await assert.rejects(
      retryResetRequest(
        () => {
          calls++;
          throw failure;
        },
        async () => {},
      ),
      e => e === failure,
    );
    assert.equal(calls, 4);
  });

for (const message of [
  'HTTP 401: Bad credentials',
  'HTTP 403: Forbidden',
  'HTTP 404: Not Found',
  'GraphQL: Could not resolve repository',
  'invalid JSON',
])
  test(`reset request fails immediately for ${message}`, async () => {
    const failure = Error(message);
    let calls = 0;
    await assert.rejects(
      retryResetRequest(
        () => {
          calls++;
          throw failure;
        },
        () => assert.fail('no backoff'),
      ),
      e => e === failure,
    );
    assert.equal(calls, 1);
  });

test('real reset retries its PR-list read and completes the same base verification', async () => {
  const calls = [],
    delays = [];
  let failed = false;
  const receipt = await reset('synthetic-base', {
    pause: async ms => delays.push(ms),
    request: async args => {
      calls.push(args);
      if (args[0] === 'pr') {
        if (!failed) {
          failed = true;
          throw Error('GraphQL: HTTP 504');
        }
        return '[]';
      }
      if (args.includes('--slurp')) return JSON.stringify([[{ name: 'main' }]]);
      if (args.at(-1).endsWith('/rulesets')) return JSON.stringify([{ id: 1, name: rulesetName }]);
      if (args.at(-1).endsWith('/branches/main'))
        return JSON.stringify({ commit: { sha: 'synthetic-base' } });
      return '{}';
    },
  });
  assert.equal(receipt.main, 'synthetic-base');
  assert.deepEqual(delays, [1000]);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls.filter(a => a.includes('PATCH')).length, 1);
  assert.equal(calls.filter(a => a.includes('enforcement=active')).length, 1);
});
