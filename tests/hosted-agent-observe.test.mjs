// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { ForgeError } from '../dist/errors.js';
import { ConvexError } from 'convex/values';
import { observeHostedRun } from '../dist/hosted-agent-observe.js';
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';
import { agentFixture } from './hosted-agent-fixture.mjs';
function fixture(t) {
  const s = agentFixture(t),
    runId = randomUUID();
  let current = { id: runId, projectId: s.address.projectId, status: 'running' };
  const query = s.exchange.client.query;
  s.exchange.client.query = async (ref, args) => {
    const result = await query(ref, args);
    return getFunctionName(ref) === 'projectHostedCheckRead:status' ? JSON.stringify(current) : result;
  };
  let opens = 0,
    closes = 0,
    unsubscribes = 0,
    update,
    fail;
  return {
    ...s,
    runId,
    counts: () => ({ opens, closes, unsubscribes }),
    current(value) {
      current = { ...current, ...value };
    },
    update(value) {
      current = { ...current, ...value };
      update(JSON.stringify(current));
    },
    fail(error = new ConvexError({ code: 'PROJECT_UNAVAILABLE', message: 'Current access revoked.' })) {
      fail(error);
    },
    subscribe() {
      opens++;
      return {
        onUpdate(ref, args, next, error) {
          assert.equal(getFunctionName(ref), 'projectHostedCheckRead:status');
          assert.deepEqual(args, {
            projectId: s.address.projectId,
            runId,
            features: ['ci-status-check', 'check-report-detail'],
          });
          update = next;
          fail = error;
          return () => {
            unsubscribes++;
          };
        },
        async close() {
          closes++;
        },
      };
    },
  };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
test('only an explicit requested wait subscribes, emits observations and closes on terminal', async t => {
  const s = fixture(t),
    events = [];
  const waiting = observeHostedRun(
    s.transport(),
    { runId: s.runId },
    undefined,
    value => events.push(value),
    s.subscribe,
  );
  await turn();
  assert.deepEqual(s.counts(), { opens: 1, closes: 0, unsubscribes: 0 });
  assert.deepEqual(
    s.calls.map(call => call.name),
    ['projectHostedAgent:capabilities', 'projectHostedCheckRead:status'],
  );
  s.update({ status: 'passed' });
  const response = await waiting;
  assert.equal(response.action, 'observe');
  assert.equal(response.operationId, null);
  assert.equal(response.result.status, 'terminal');
  assert.equal(response.result.run.status, 'passed');
  assert.deepEqual(
    events.map(event => event.status),
    ['running', 'passed'],
  );
  assert.deepEqual(s.counts(), { opens: 1, closes: 1, unsubscribes: 1 });
  const count = s.calls.length;
  await turn();
  assert.equal(s.calls.length, count);
});
for (const status of ['passed', 'failed', 'cancelled', 'interrupted', 'runner-unavailable'])
  test(`terminal ${status} and finite zero waits open no subscription`, async t => {
    const s = fixture(t);
    s.current({ status });
    assert.equal(
      (await observeHostedRun(s.transport(), { runId: s.runId }, undefined, undefined, s.subscribe)).result
        .status,
      'terminal',
    );
    s.current({ status: 'unknown' });
    assert.equal(
      (
        await observeHostedRun(
          s.transport(),
          { runId: s.runId, timeoutSeconds: 0 },
          undefined,
          undefined,
          s.subscribe,
        )
      ).result.status,
      'timeout',
    );
    assert.equal(s.counts().opens, 0);
  });

test('timeout and request cancellation close the selected subscription without cancelling the run', async t => {
  const s = fixture(t);
  const timeout = await observeHostedRun(
    s.transport(),
    { runId: s.runId, timeoutSeconds: 0.01 },
    undefined,
    undefined,
    s.subscribe,
  );
  assert.equal(timeout.result.status, 'timeout');
  const controller = new AbortController();
  const waiting = observeHostedRun(
    s.transport(),
    { runId: s.runId },
    controller.signal,
    undefined,
    s.subscribe,
  );
  await turn();
  controller.abort();
  assert.equal((await waiting).result.status, 'cancelled');
  assert.deepEqual(s.counts(), { opens: 2, closes: 2, unsubscribes: 2 });
  assert(s.calls.every(call => /capabilities|:status$/.test(call.name)));
});

test('revocation and invalid source/run identity remain explicit and close live observation', async t => {
  for (const failure of ['revoke', 'identity']) {
    const s = fixture(t);
    const waiting = observeHostedRun(s.transport(), { runId: s.runId }, undefined, undefined, s.subscribe);
    const rejection = assert.rejects(waiting, {
      code:
        failure === 'revoke'
          ? 'PROJECT_UNAVAILABLE'
          : failure === 'identity'
            ? 'HOSTED_PROTOCOL_INVALID'
            : 'HOSTED_ACTION_FAILED',
    });
    await turn();
    if (failure === 'identity') s.update({ id: randomUUID() });
    else s.fail(failure === 'transport' ? new Error('Synthetic private transport payload') : undefined);
    await rejection;
    assert.deepEqual(s.counts(), { opens: 1, closes: 1, unsubscribes: 1 });
  }
});

test('MCP progress and disconnect are scoped to the requested live run only', async t => {
  const s = fixture(t),
    tools = new Map(),
    notifications = [];
  const close = registerHostedAgentWorkflow(
    {
      registerTool(name, config, call) {
        tools.set(name, { config, call });
      },
    },
    s.transport(),
    s.subscribe,
  );
  assert.equal(s.calls.length, 0);
  assert.equal(s.counts().opens, 0);
  const waiting = tools.get('forge_wait').call(
    { runId: s.runId },
    {
      signal: new AbortController().signal,
      _meta: { progressToken: 'watch' },
      async sendNotification(value) {
        notifications.push(value);
      },
    },
  );
  await turn();
  close();
  const result = JSON.parse((await waiting).content[0].text);
  assert.equal(result.result.status, 'IN_PROGRESS');
  assert.equal(result.result.reason, 'cancelled');
  assert.equal(result.result.next.action, 'wait');
  assert.equal(result.result.next.runId, s.runId);
  assert.equal(result.result.command, result.result.waitCommand);
  assert.equal(result.result.instruction, undefined, 'one resume command, no repeated prose');
  assert.equal(notifications[0].params.progressToken, 'watch');
  assert.equal(JSON.parse(notifications[0].params.message).id, s.runId);
  assert.deepEqual(s.counts(), { opens: 1, closes: 1, unsubscribes: 1 });
});

test('failed authorization and pre-cancelled waits never allocate a live client', async t => {
  const s = fixture(t),
    controller = new AbortController();
  controller.abort();
  assert.equal(
    (await observeHostedRun(s.transport(), { runId: s.runId }, controller.signal, undefined, s.subscribe))
      .result.status,
    'cancelled',
  );
  s.allow(false);
  await assert.rejects(
    observeHostedRun(s.transport(), { runId: s.runId }, undefined, undefined, s.subscribe),
    { code: 'PROJECT_UNAVAILABLE' },
  );
  assert.equal(s.counts().opens, 0);
});

test('a synchronous subscription setup failure still closes its client', async t => {
  const s = fixture(t);
  let closed = false;
  await assert.rejects(
    observeHostedRun(s.transport(), { runId: s.runId }, undefined, undefined, () => ({
      onUpdate() {
        throw new ConvexError({ code: 'SOURCE_UNAVAILABLE', message: 'Synthetic setup failure' });
      },
      async close() {
        closed = true;
      },
    })),
    { code: 'SOURCE_UNAVAILABLE' },
  );
  assert(closed);
});

test('run observation retries HTTP 502 and returns the actual passed outcome', async t => {
  const s = fixture(t),
    transport = s.transport(),
    events = [];
  const dispatch = transport.dispatch.bind(transport);
  let attempts = 0;
  transport.dispatch = async (...args) => {
    if (++attempts === 1) throw new ForgeError('EXCHANGE_REQUEST_FAILED', 'HTTP 502');
    return dispatch(...args);
  };
  s.current({ status: 'passed' });
  const result = await observeHostedRun(
    transport,
    { runId: s.runId },
    undefined,
    e => events.push(e),
    s.subscribe,
  );
  assert.equal(result.result.run.status, 'passed');
  assert.equal(attempts, 2);
  assert.equal(events[0].type, 'observation-retry');
  assert.equal(events[0].retryAfterMs, 2000);
  assert.equal(s.counts().opens, 0);
});

test('persistent run observation outage reaches the deadline as in progress', async t => {
  const s = fixture(t),
    transport = s.transport();
  let attempts = 0;
  transport.dispatch = async () => {
    attempts++;
    throw new ForgeError('EXCHANGE_REQUEST_TIMEOUT', 'Synthetic timeout');
  };
  const result = await observeHostedRun(
    transport,
    { runId: s.runId, timeoutSeconds: 0.01 },
    undefined,
    undefined,
    s.subscribe,
  );
  assert.equal(result.result.status, 'timeout');
  assert.equal(result.result.inProgress, true);
  assert.equal(attempts, 1);
});
