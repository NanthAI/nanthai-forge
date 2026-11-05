// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  retryActionsInfrastructure,
  actionsInfrastructureResponse,
  actionsDeliveryDeadlineMs,
  actionsDeliveryPolicy,
} from '../dist/hosted-actions-retry.js';

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

/** Drives mocked timers until the retry settles; returns its outcome. */
async function settle(t, promise) {
  let done = false;
  const outcome = promise.then(
    value => ({ value }),
    error => ({ error }),
  );
  outcome.then(() => (done = true));
  for (let step = 0; !done; step++) {
    assert(step < 10_000, 'retry never settled');
    await new Promise(resolve => setImmediate(resolve));
    if (!done) t.mock.timers.tick(1000);
  }
  return outcome;
}
const quiet = t => t.mock.method(console, 'log', () => {});

test('Issue 72d50375: a finished result outlives a 10-minute write outage, resending the same body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const log = quiet(t);
  const body = JSON.stringify({ kind: 'result', runId: 'r', index: 0, digest: 'd' });
  const sent = [];
  const outcome = await settle(
    t,
    retryActionsInfrastructure(
      async () => {
        sent.push({ at: Date.now(), body });
        return actionsInfrastructureResponse(
          new Response(null, { status: Date.now() < 10 * 60_000 ? 503 : 200 }),
        );
      },
      60_000,
      actionsDeliveryDeadlineMs,
      actionsDeliveryPolicy,
    ),
  );
  assert.equal(outcome.value?.status, 200);
  assert(sent.at(-1).at >= 10 * 60_000);
  assert(new Set(sent.map(s => s.body)).size === 1, 'one immutable request body');
  // Backoff caps at a minute: about 15 calls across 10 minutes, not hundreds.
  assert(sent.length <= 20, String(sent.length));
  assert.match(log.mock.calls[0].arguments[0], /Forge is not accepting it yet \(HTTP 503\)/);
});

test('Issue 72d50375: delivery honors Retry-After from a paused deployment', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  quiet(t);
  const at = [];
  const outcome = await settle(
    t,
    retryActionsInfrastructure(
      async () => {
        at.push(Date.now());
        return actionsInfrastructureResponse(
          at.length === 1
            ? new Response(null, { status: 503, headers: { 'retry-after': '300' } })
            : new Response(null, { status: 200 }),
        );
      },
      60_000,
      actionsDeliveryDeadlineMs,
      actionsDeliveryPolicy,
    ),
  );
  assert.equal(outcome.value?.status, 200);
  assert.deepEqual(at.length, 2);
  assert(at[1] - at[0] >= 300_000, String(at[1] - at[0]));
});

test('Issue 72d50375: delivery gives up only past the pause bound; other calls keep 3 attempts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  quiet(t);
  let calls = 0;
  const unavailable = async () => {
    calls++;
    return actionsInfrastructureResponse(new Response(null, { status: 503 }));
  };
  const delivery = await settle(
    t,
    retryActionsInfrastructure(unavailable, 60_000, actionsDeliveryDeadlineMs, actionsDeliveryPolicy),
  );
  assert.equal(delivery.error?.code, 'RUNNER_UNAVAILABLE');
  assert(Date.now() >= 34 * 60_000, String(Date.now()));
  calls = 0;
  const other = await settle(t, retryActionsInfrastructure(unavailable));
  assert.equal(other.error?.code, 'RUNNER_UNAVAILABLE');
  assert.equal(calls, 3);
});
