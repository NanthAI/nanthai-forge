// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { observeHostedSubmissions } from '../dist/hosted-agent-submission-wait.js';
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';
import { landingFixture, store, api, code } from './hosted-landing-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const turn = () => new Promise(resolve => setImmediate(resolve));
async function fixture() {
  const f = await landingFixture(),
    subscriptions = new Set(),
    events = [];
  let opens = 0,
    closes = 0,
    unsubscribes = 0,
    reads = 0,
    actor = 'owner',
    duringSubscribe;
  const transport = {
    address: { url: 'https://fixture.invalid', projectId: f.projectId },
    async dispatch() {
      return {
        schema: 1,
        transport: 'hosted',
        action: 'capabilities',
        operationId: null,
        result: { actor: 'owner' },
      };
    },
    async query(name, args) {
      assert.equal(name, 'projectHostedFinishObserve:page');
      reads++;
      return JSON.parse(
        await f.call('landingWaitPage', observe.page, { ...args, projectId: f.projectId }, actor),
      );
    },
  };
  const subscribe = () => {
    opens++;
    return {
      onUpdate(ref, args, next, fail) {
        assert.equal(getFunctionName(ref), 'projectHostedFinishObserve:page');
        const s = { args, next, fail };
        subscriptions.add(s);
        duringSubscribe?.();
        duringSubscribe = null;
        return () => {
          subscriptions.delete(s);
          unsubscribes++;
        };
      },
      async close() {
        closes++;
      },
    };
  };
  const start = async () => {
    const request = f.request(),
      state = await f.enqueue(request);
    return { request, state };
  };
  const update = async (id, status, overrides = {}) => {
    const { request: state } = await f.status(id);
    const row = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === id);
    const observation =
      status === 'landed'
        ? { state: 'landed', pendingReason: null, cause: null }
        : status === 'terminal-failed'
          ? { state: 'terminal-failed', pendingReason: null, cause: 'conflict' }
          : { state: 'pending', pendingReason: status, cause: null };
    return f.run(
      'landingWaitWrite',
      ctx =>
        store.writeLanding(
          ctx,
          row,
          {
            ...state,
            version: state.version + 1,
            phase: status === 'checking' ? 'checking' : status === 'queued' ? 'queued' : status,
            observation,
            ...overrides,
          },
          false,
        ),
      {},
    );
  };
  return {
    f,
    transport,
    subscribe,
    events,
    start,
    update,
    wait: (input, signal) =>
      observeHostedSubmissions(transport, input, signal, e => events.push(e), subscribe),
    wake: () => {
      for (const s of subscriptions) s.next(null);
    },
    fail: error => {
      for (const s of subscriptions) s.fail(error);
    },
    revoke: () => {
      actor = 'stranger';
    },
    duringSubscribe: fn => {
      duringSubscribe = fn;
    },
    counts: () => ({ opens, closes, unsubscribes, reads }),
  };
}

test('one hosted wait follows several operation IDs, deduplicates wakes and ends when all are terminal', async () => {
  const s = await fixture(),
    a = await s.start(),
    b = await s.start();
  const waiting = s.wait({
    operationIds: [a.request.operationId, b.request.operationId, a.request.operationId],
  });
  await turn();
  assert.equal(s.counts().opens, 1);
  assert.equal(s.events.length, 2);
  s.wake();
  s.wake();
  await turn();
  assert.equal(s.events.length, 2);
  await s.update(a.state.id, 'checking');
  s.wake();
  await turn();
  await s.update(a.state.id, 'landed');
  s.wake();
  await turn();
  assert.equal(s.counts().closes, 0);
  await s.update(b.state.id, 'terminal-failed', {
    error: { code: 'COMPOSITION_CONFLICT', message: 'Synthetic conflict' },
  });
  s.wake();
  const result = await waiting;
  assert.equal(result.result.status, 'terminal');
  assert.equal(result.result.successful, false);
  assert.deepEqual(
    s.events.map(e => [e.operationId, e.version]),
    [
      [a.request.operationId, 0],
      [b.request.operationId, 0],
      [a.request.operationId, 1],
      [a.request.operationId, 2],
      [b.request.operationId, 1],
    ],
  );
  assert.equal(s.counts().closes, 1);
  assert.equal(s.counts().unsubscribes, 2);
  const reads = s.counts().reads;
  await turn();
  assert.equal(s.counts().reads, reads, 'no idle observer/polling');
});

test('a cursor from a mid-page progress event resumes every disconnected version once', async () => {
  const s = await fixture(),
    a = await s.start(),
    b = await s.start();
  const selection = { operationIds: [a.request.operationId, b.request.operationId], timeoutSeconds: 0 };
  await s.wait(selection);
  const cursor = s.events[0].cursor;
  for (let i = 0; i < 43; i++) await s.update(a.state.id, i % 2 ? 'queued' : 'checking');
  await s.update(a.state.id, 'landed');
  await s.update(b.state.id, 'landed');
  s.events.length = 0;
  const result = await s.wait({ ...selection, cursor });
  assert.equal(result.result.status, 'terminal');
  assert.deepEqual(
    s.events.filter(e => e.operationId === a.request.operationId).map(e => e.version),
    Array.from({ length: 44 }, (_, i) => i + 1),
  );
  assert.deepEqual(
    s.events.filter(e => e.operationId === b.request.operationId).map(e => e.version),
    [0, 1],
  );
  assert.equal(s.counts().opens, 0);
  assert.equal(new Set(s.events.map(e => `${e.id}:${e.version}`)).size, s.events.length);
  for (const c of s.f.counts.filter(c => c.name === 'landingWaitPage')) {
    assert(c.documents <= 25 && c.ranges <= 24, JSON.stringify(c));
  }
  const replay = await s.wait({ ...selection, cursor: result.result.cursor });
  assert.equal(replay.result.status, 'terminal');
  assert.equal(s.events.length, 46);
});

test('reconnect during an active wait replays pending changes and retains the same operations', async () => {
  const s = await fixture(),
    a = await s.start(),
    controller = new AbortController();
  const first = s.wait({ operationIds: [a.request.operationId] }, controller.signal);
  await turn();
  await s.update(a.state.id, 'checking');
  s.wake();
  await turn();
  controller.abort();
  const disconnected = await first;
  assert.equal(disconnected.result.status, 'cancelled');
  await s.update(a.state.id, 'queued');
  s.events.length = 0;
  const second = s.wait({ operationIds: [a.request.operationId], cursor: disconnected.result.cursor });
  await turn();
  assert.deepEqual(
    s.events.map(e => e.version),
    [2],
  );
  await s.update(a.state.id, 'landed');
  s.wake();
  assert.equal((await second).result.status, 'terminal');
  assert.deepEqual(
    s.events.map(e => e.version),
    [2, 3],
  );
  assert.equal(s.f.tables.projectHostedLandingRequests.size, 1);
  assert.equal(s.counts().closes, 2);
});

test('registration followed by an authoritative reread closes a missed wake', async () => {
  const s = await fixture(),
    a = await s.start();
  // Directly edit a retained event/current row at subscription registration: no callback.
  s.duringSubscribe(() => {
    const row = [...s.f.tables.projectHostedLandingRequests.values()][0];
    const state = JSON.parse(row.value);
    state.version++;
    state.phase = 'landed';
    state.observation = { state: 'landed', pendingReason: null, cause: null };
    s.f.patch('projectHostedLandingRequests', row._id, { phase: 'landed', value: JSON.stringify(state) });
    s.f.insert('projectHostedLandingObservations', {
      projectId: s.f.projectId,
      submissionId: state.id,
      version: state.version,
      value: JSON.stringify({ submission: state, pendingAttempt: null }),
    });
  });
  assert.equal((await s.wait({ operationIds: [a.request.operationId] })).result.status, 'terminal');
  assert.deepEqual(
    s.events.map(e => e.version),
    [0, 1],
  );
});

test('selection/project/actor cursor mismatch is explicit; authority cutover rereads without replaying old versions', async () => {
  const s = await fixture(),
    a = await s.start(),
    b = await s.start();
  const first = await s.wait({ operationIds: [a.request.operationId], timeoutSeconds: 0 });
  const cursor = first.result.cursor;
  await assert.rejects(
    s.wait({ operationIds: [b.request.operationId], cursor, timeoutSeconds: 0 }),
    code('BAD_ARGUMENT'),
  );
  const other = { ...s.transport, address: { ...s.transport.address, url: 'https://another.invalid' } };
  await assert.rejects(
    observeHostedSubmissions(other, { operationIds: [a.request.operationId], cursor }),
    code('BAD_ARGUMENT'),
  );
  s.f.patch('hostedProjects', s.f.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await s.update(a.state.id, 'checking');
  s.events.length = 0;
  const resumed = await s.wait({ operationIds: [a.request.operationId], cursor, timeoutSeconds: 0 });
  assert.equal(resumed.result.status, 'timeout');
  assert.deepEqual(
    s.events.map(e => e.version),
    [1],
  );
});

test('revoked access, subscription failure, finite timeout and cancellation never wake or cancel landing work', async () => {
  const s = await fixture(),
    a = await s.start();
  const tasks = s.f.pendingTasks().length;
  assert.equal(
    (await s.wait({ operationIds: [a.request.operationId], timeoutSeconds: 0.01 })).result.status,
    'timeout',
  );
  const waiting = s.wait({ operationIds: [a.request.operationId] });
  const rejection = assert.rejects(waiting, code('HOSTED_ACTION_FAILED'));
  await turn();
  s.fail(new Error('Synthetic transport failure'));
  await rejection;
  s.revoke();
  await assert.rejects(
    s.wait({ operationIds: [a.request.operationId], timeoutSeconds: 0 }),
    code('PROJECT_UNAVAILABLE'),
  );
  assert.equal(s.f.pendingTasks().length, tasks);
  assert.equal(s.counts().opens, 2);
  assert.equal(s.counts().closes, 2);
});

test('legacy history resnapshots explicitly and missing operations never scan a project', async () => {
  const s = await fixture(),
    a = await s.start();
  s.f.tables.projectHostedLandingObservations.clear();
  const page = await s.transport.query('projectHostedFinishObserve:page', {
    operationId: a.request.operationId,
    nextVersion: 0,
  });
  assert.equal(page.resnapshot, true);
  assert.equal(page.events.length, 1);
  const snapshot = await s.wait({ operationIds: [a.request.operationId], timeoutSeconds: 0 });
  assert.equal(snapshot.result.resnapshot, true);
  assert.equal(s.events[0].resnapshot, true);
  await assert.rejects(
    s.transport.query('projectHostedFinishObserve:page', { operationId: randomUUID(), nextVersion: 0 }),
    code('NOT_FOUND'),
  );
});

test('MCP hosted wait accepts multi-operation selection and closes on disconnect with a reusable cursor', async () => {
  const s = await fixture(),
    a = await s.start(),
    tools = new Map(),
    notifications = [];
  const close = registerHostedAgentWorkflow(
    {
      registerTool(name, config, call) {
        tools.set(name, { config, call });
      },
    },
    s.transport,
    s.subscribe,
  );
  const waiting = tools.get('forge_wait').call(
    { operationIds: [a.request.operationId] },
    {
      signal: new AbortController().signal,
      _meta: { progressToken: 'submissions' },
      async sendNotification(value) {
        notifications.push(value);
      },
    },
  );
  await turn();
  close();
  const response = JSON.parse((await waiting).content[0].text);
  assert.equal(response.result.status, 'cancelled');
  assert.equal(notifications.length, 1);
  assert.equal(JSON.parse(notifications[0].params.message).cursor, response.result.cursor);
  assert.equal(s.counts().closes, 1);
  assert.equal((await s.f.status(a.state.id)).request.phase, 'queued');
});

test('historical failed/conflicted attempts retain their own evidence after a landed child; old pins stay immutable', async () => {
  const s = await fixture(),
    a = await s.start();
  const original = (await s.f.status(a.state.id)).attempt;
  await s.update(a.state.id, 'terminal-failed', {
    error: { code: 'COMPOSITION_CONFLICT', message: 'Original conflict' },
  });
  const child = {
    ...original,
    id: randomUUID(),
    parentAttemptId: original.id,
    number: 1,
    operations: { check: randomUUID(), accept: randomUUID() },
  };
  await s.f.run('landingHistoryInsert', store.insertLandingAttempt, child);
  const row = [...s.f.tables.projectHostedLandingRequests.values()][0],
    state = JSON.parse(row.value);
  await s.f.run(
    'landingHistorySelect',
    ctx =>
      store.writeLanding(
        ctx,
        row,
        {
          ...state,
          version: state.version + 1,
          attemptId: child.id,
          phase: 'landed',
          observation: { state: 'landed', pendingReason: null, cause: null },
          error: null,
          acceptance: { receiptId: child.operations.accept, head: 'b'.repeat(64) },
        },
        false,
      ),
    {},
  );
  const history = JSON.parse(
    await s.f.call('landingHistoryPage', api.attempts, {
      projectId: s.f.projectId,
      submissionId: state.id,
      cursor: null,
    }),
  );
  assert.equal(history.page[0].superseded, true);
  assert.equal(history.page[0].observation.cause, 'conflict');
  assert.equal(history.page[0].progress.error.message, 'Original conflict');
  assert.equal(history.page[0].progress.acceptance, null);
  assert.equal(history.page[1].observation.state, 'landed');
  assert.equal(history.page[1].progress.acceptance.receiptId, child.operations.accept);
  const firstRow = [...s.f.tables.projectHostedLandingAttempts.values()][0];
  assert.deepEqual(JSON.parse(firstRow.value), original);
  s.f.patch('projectHostedLandingAttempts', firstRow._id, { progress: undefined });
  const legacy = JSON.parse(
    await s.f.call('landingHistoryPage', api.attempts, {
      projectId: s.f.projectId,
      submissionId: state.id,
      cursor: null,
    }),
  );
  assert.equal(legacy.page[0].progress, null, 'unrecorded old evidence stays explicitly unknown');
  assert.equal(legacy.page[0].observation, null);
});

test('any-change observes an initial baseline, and resumed cursors report only new observations', async () => {
  const s = await fixture(),
    a = await s.start();
  const waiting = s.wait({ operationIds: [a.request.operationId], until: 'any-change' });
  await turn();
  assert.equal(s.counts().closes, 0);
  s.wake();
  await turn();
  assert.equal(s.counts().closes, 0);
  await s.update(a.state.id, 'checking');
  s.wake();
  const first = await waiting;
  assert.equal(first.result.status, 'changed');
  await s.update(a.state.id, 'queued');
  const next = await s.wait({
    operationIds: [a.request.operationId],
    cursor: first.result.cursor,
    until: 'any-change',
  });
  assert.equal(next.result.status, 'changed');
  assert.deepEqual(
    s.events.map(e => e.version),
    [0, 1, 2],
  );
  assert.equal(s.counts().opens, 1);
});

test('live revocation, pre-cancellation and partial subscription setup failures close observers', async () => {
  const s = await fixture(),
    a = await s.start(),
    controller = new AbortController();
  controller.abort();
  assert.equal(
    (await s.wait({ operationIds: [a.request.operationId] }, controller.signal)).result.status,
    'cancelled',
  );
  assert.equal(s.counts().opens, 0);
  const waiting = s.wait({ operationIds: [a.request.operationId] });
  const rejection = assert.rejects(waiting, code('PROJECT_UNAVAILABLE'));
  await turn();
  s.revoke();
  s.wake();
  await rejection;
  assert.equal(s.counts().closes, 1);
  const other = await fixture(),
    b = await other.start();
  let closed = false;
  await assert.rejects(
    observeHostedSubmissions(
      other.transport,
      { operationIds: [b.request.operationId] },
      undefined,
      undefined,
      () => ({
        onUpdate() {
          throw new Error('Synthetic setup failure');
        },
        async close() {
          closed = true;
        },
      }),
    ),
    code('HOSTED_ACTION_FAILED'),
  );
  assert.equal(closed, true);
});
