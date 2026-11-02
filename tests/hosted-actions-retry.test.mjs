// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { retryActionsInfrastructure, actionsInfrastructureResponse } from '../dist/hosted-actions-retry.js';

test('429 and 5xx retry within one bounded infrastructure operation', async () => {
  const statuses = [429, 503, 200];
  let calls = 0;
  const response = await retryActionsInfrastructure(async () =>
    actionsInfrastructureResponse(new Response(null, { status: statuses[calls++] })),
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
});

test('total deadline stops retries and bounds each attempt signal', async () => {
  let calls = 0;
  await assert.rejects(
    retryActionsInfrastructure(
      async signal => {
        calls++;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 1000);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
      100,
      20,
    ),
    { code: 'RUNNER_UNAVAILABLE' },
  );
  assert.equal(calls, 1);
});

test('permanent HTTP refusal is returned once for domain classification', async () => {
  let calls = 0;
  const response = await retryActionsInfrastructure(async () => {
    calls++;
    return actionsInfrastructureResponse(new Response(null, { status: 403 }));
  });
  assert.equal(response.status, 403);
  assert.equal(calls, 1);
});
