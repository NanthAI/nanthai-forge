// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { observeHostedRun } from '../dist/hosted-agent-observe.js';
import { observePeerLane } from '../dist/hosted-board-wait.js';
import { observeHostedSubmissions } from '../dist/hosted-agent-submission-wait.js';
import { waitHostedAgentSource } from '../dist/hosted-agent-source-wait.js';
import { logicalTicket } from './landing-ticket-fixture.mjs';
import { landingFixture, store } from './hosted-landing-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const board = { laneId: randomUUID(), after: 0, wokeAt: 0 };
const delivery = {
  messages: [],
  more: 0,
  cursor: 1,
  conflicts: [
    {
      with: 'main',
      goal: 'main',
      flaggedAt: '2026-01-01T00:00:00.000Z',
      files: [{ path: 'src/preview.ts', mine: [[60, 60]], theirs: [[60, 61]], reason: 'text' }],
    },
  ],
};
const address = { url: 'https://synthetic.invalid', projectId: 'project' };
const verify = value => {
  assert.equal(value.conflictNotice?.items[0].file, 'src/preview.ts');
  assert.match(value.conflictNotice.next, /sync/);
};

for (const immediate of [false, true])
  test(`83e6d0d3 t19456: a ${immediate ? 'retained' : 'newly terminal'} run returns the conflict already in its reply without waiting for the batch timer`, async () => {
    const runId = randomUUID();
    let dispatches = 0,
      subscriptions = 0,
      closes = 0;
    const initial = { id: runId, projectId: address.projectId, status: immediate ? 'passed' : 'running' };
    const terminal = { ...initial, status: 'passed', board: delivery };
    const transport = {
      root: '/synthetic',
      address,
      advertisedFeatures: ['run-board-wait'],
      async dispatch() {
        dispatches++;
        return { schema: 1, transport: 'hosted', action: 'observe', result: immediate ? terminal : initial };
      },
    };
    const response = await observeHostedRun(
      transport,
      { runId, timeoutSeconds: 30 },
      undefined,
      undefined,
      () => ({
        onUpdate(_ref, _args, next) {
          subscriptions++;
          queueMicrotask(() => next(terminal));
          return () => {};
        },
        async close() {
          closes++;
        },
      }),
      board,
    );
    assert.equal(response.result.status, 'terminal', 'the notice never changes the check outcome');
    assert.equal(response.result.run.status, 'passed');
    verify(response);
    assert.equal(dispatches, 1);
    assert.equal(subscriptions, immediate ? 0 : 1);
    assert.equal(closes, subscriptions);
  });

test('83e6d0d3 t19456: a peer settling in the conflict update retains both the peer outcome and actionable notice', async () => {
  let calls = 0,
    closes = 0;
  const peer = { laneId: randomUUID(), state: 'accepted', terminal: true };
  const response = await observePeerLane(
    {
      root: '/synthetic',
      address,
      async dispatch() {
        calls++;
        return { result: { features: ['board-wait'] } };
      },
    },
    { peer: peer.laneId, timeoutSeconds: 30 },
    board,
    undefined,
    () => ({
      onUpdate(_ref, _args, next) {
        queueMicrotask(() => next({ peer, board: delivery }));
        return () => {};
      },
      async close() {
        closes++;
      },
    }),
  );
  assert.equal(response.status, 'terminal');
  assert.deepEqual(response.peer, peer);
  verify(response);
  assert.equal(calls, 1);
  assert.equal(closes, 1);
});

for (const kind of ['Saves', 'Sync', 'Compose'])
  for (const chain of [false, true])
    test(`83e6d0d3 t19456: terminal ${kind}${chain ? ' chain' : ''} keeps the current notice when progress compacts to its receipt`, async () => {
      const receipt = {
        attemptId: randomUUID(),
        at: '2026-01-01T00:00:00.000Z',
        outcome: { status: 'completed', result: { saved: true } },
      };
      let subscriptions = 0,
        closes = 0;
      const response = await waitHostedAgentSource(
        address,
        randomUUID(),
        { status: 'submitted' },
        undefined,
        () => ({
          onUpdate(_ref, _args, next) {
            subscriptions++;
            queueMicrotask(() => next({ terminal: receipt, board: delivery }));
            return () => {};
          },
          async close() {
            closes++;
          },
        }),
        kind,
        30,
        undefined,
        chain ? () => ({ value: { save: receipt, chained: receipt } }) : undefined,
        board,
      );
      assert.deepEqual(
        chain ? response.save : { attemptId: response.attemptId, at: response.at, outcome: response.outcome },
        receipt,
      );
      verify(response);
      assert.equal(subscriptions, 1);
      assert.equal(closes, 1);
    });

test('83e6d0d3 t19456: a terminal landing update cannot discard the notice carried by its existing subscription', async t => {
  const f = await landingFixture();
  const request = f.request(),
    state = await f.enqueue(request);
  let next,
    ready,
    calls = 0,
    closes = 0;
  const subscribed = new Promise(resolve => {
    ready = resolve;
  });
  const transport = {
    root: '/synthetic',
    address: { ...address, projectId: f.projectId },
    async dispatch() {
      return { result: { actor: 'owner', features: ['board-wait'] } };
    },
    async query(_name, args) {
      calls++;
      return JSON.parse(
        await f.call('terminalNoticePage', observe.page, { projectId: f.projectId, ...args }),
      );
    },
  };
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = observeHostedSubmissions(
    transport,
    { operationIds: [request.operationId], until: 'acceptance', timeoutSeconds: 30 },
    controller.signal,
    undefined,
    () => ({
      onUpdate(_ref, _args, callback) {
        next = callback;
        ready();
        return () => {};
      },
      async close() {
        closes++;
      },
    }),
    board,
  );
  await subscribed;
  await new Promise(resolve => setImmediate(resolve));
  const row = [...f.tables.projectHostedLandingRequests.values()].find(row => row.submissionId === state.id);
  await f.run(
    'settleForNotice',
    ctx =>
      store.writeLanding(
        ctx,
        logicalTicket(f, row),
        {
          ...state,
          phase: 'landed',
          version: state.version + 1,
          observation: { state: 'landed', pendingReason: null, cause: null },
        },
        false,
      ),
    {},
  );
  const page = JSON.parse(
    await f.call('terminalNoticePage', observe.page, {
      projectId: f.projectId,
      operationId: request.operationId,
      nextVersion: 0,
    }),
  );
  const before = calls;
  next({ ...page, board: delivery });
  const response = await pending;
  assert.equal(response.result.status, 'terminal');
  assert.equal(response.result.successful, true);
  verify(response);
  assert.equal(calls, before, 'the terminal live page is reused, with no notice read');
  assert.equal(closes, 1);
});

for (const kind of ['Saves', 'Sync', 'Compose'])
  test(`83e6d0d3: retained ${kind} terminal delivery adds no subscription and no conflict for notes alone`, async () => {
    const receipt = { outcome: { status: 'completed', result: { saved: true } } };
    const read = notice =>
      waitHostedAgentSource(
        address,
        randomUUID(),
        { terminal: receipt, board: notice },
        undefined,
        () => assert.fail('a retained terminal opens no subscription'),
        kind,
        30,
        undefined,
        undefined,
        board,
      );
    verify(await read(delivery));
    const notesOnly = {
      messages: [{ id: 'note', target: 'project', text: 'Synthetic', at: 1 }],
      more: 0,
      cursor: 1,
    };
    assert.deepEqual(await read(notesOnly), receipt, 'member notes do not change a terminal source result');
    assert.deepEqual(await read(undefined), receipt, 'healthy terminal bytes stay identical');
  });
