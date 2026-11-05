// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { landWaitCommand } from '../dist/hosted-land-wait.js';
import { assertAgentResponseShape } from './agent-response-shape.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ForgeError } from '../dist/errors.js';
import { ConvexError } from 'convex/values';
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
  let conflictReads = 0;
  const sStatus = async id => {
    conflictReads++;
    return f.status(id);
  };
  const transport = {
    root: '/synthetic',
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
      if (name === 'projectHostedLanding:status') return sStatus(args.submissionId);
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
    conflictReads: () => conflictReads,
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
  for (const entry of result.result.submissions) assertAgentResponseShape({ result: entry }, '/synthetic');
  const conflict = result.result.submissions.find(e => e.submission.id === b.state.id).recovery.conflict;
  assert.equal(conflict.next.action, 'sync');
  assert.equal(conflict.error.message, 'Synthetic conflict');
  assert.equal(s.conflictReads(), 1);
  assert.deepEqual(
    s.events.map(e => [e.operationId, e.version]),
    [
      [a.request.operationId, 0],
      [b.request.operationId, 0],
      [a.request.operationId, 1],
      [b.request.operationId, 0],
      [a.request.operationId, 2],
      [b.request.operationId, 0],
      [b.request.operationId, 1],
    ],
  );
  assert.deepEqual(
    s.events
      .filter(event => event.operationId === b.request.operationId && event.version === 0)
      .map(event => event.queue.position),
    [2, 2, 1],
    'the follower sees predecessor progress and settlement without changing its own version',
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
  const rejection = assert.rejects(waiting, code('PROJECT_UNAVAILABLE'));
  await turn();
  s.fail(new ConvexError({ code: 'PROJECT_UNAVAILABLE', message: 'Current access revoked' }));
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
  assert.equal(response.result.status, 'IN_PROGRESS');
  assert.equal(response.result.reason, 'cancelled');
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

test('queue-only progress emits one refreshed receipt without duplicating its retained version', async () => {
  const s = await fixture(),
    a = await s.start(),
    b = await s.start();
  const waiting = s.wait({ operationIds: [b.request.operationId], until: 'any-change' });
  await turn();
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].queue.position, 2);
  s.wake();
  await turn();
  assert.equal(s.events.length, 1, 'a duplicate wake is not queue progress');
  await s.update(a.state.id, 'landed');
  s.wake();
  const result = await waiting;
  assert.equal(result.result.status, 'changed');
  assert.deepEqual(
    s.events.map(event => event.version),
    [0, 0],
  );
  assert.equal(s.events[1].queue.position, 1);
  assert.equal(s.counts().closes, 1);
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
          throw new ConvexError({ code: 'SOURCE_UNAVAILABLE', message: 'Synthetic setup failure' });
        },
        async close() {
          closed = true;
        },
      }),
    ),
    code('SOURCE_UNAVAILABLE'),
  );
  assert.equal(closed, true);
});

test('speculative conflict advice is delivered by wait without a terminal outcome or a new read loop', async () => {
  const s = await fixture(),
    a = await s.start();
  const row = [...s.f.tables.projectHostedLandingRequests.values()].find(
    row => row.submissionId === a.state.id,
  );
  const advice = {
    code: 'COMPOSITION_CONFLICT',
    paths: ['src/shared.ts'],
    more: 0,
    predecessor: {
      groupId: randomUUID(),
      submissionId: randomUUID(),
      head: 'a'.repeat(64),
      receiptId: randomUUID(),
    },
    at: a.state.at,
    next: 'Wait for the predecessor; Forge will recompose automatically.',
  };
  s.f.patch('projectHostedLandingRequests', row._id, { wouldConflict: JSON.stringify(advice) });
  await s.update(a.state.id, 'queued');
  const selection = { operationIds: [a.request.operationId], timeoutSeconds: 0 };
  const pending = await s.wait(selection);
  assert.equal(pending.result.status, 'timeout');
  const event = s.events.find(event => event.wouldConflict);
  assert.deepEqual(event.wouldConflict, advice);
  assert.equal(event.terminal, false);
  assert.equal(event.submission.error, null);
  assert.deepEqual(pending.result.submissions[0].wouldConflict, advice);
  assert.equal(s.counts().opens, 0, 'finite read creates no observer or poller');
  const replay = await s.wait({ ...selection, cursor: pending.result.cursor });
  assert.deepEqual(replay.result.submissions[0].wouldConflict, advice);
  assert.equal(
    s.events.filter(event => event.wouldConflict).length,
    1,
    'the same-version current snapshot and reconnect do not redeliver the advice',
  );
  await s.update(a.state.id, 'checking');
  const resumed = await s.wait({ ...selection, cursor: pending.result.cursor });
  assert.equal(
    resumed.result.submissions[0].wouldConflict,
    undefined,
    'retired advice is not carried into a new source/check state',
  );
});

test('a retained preparing submission resnapshots the same older version on reconnect', async () => {
  const s = await fixture(),
    a = await s.start();
  await s.f.run(
    'restorePreparingSubmission',
    async ctx => {
      for (const row of s.f.tables.projectHostedLandingRequests.values()) await ctx.db.delete(row._id);
    },
    {},
  );
  s.f.tables.projectHostedLandingDesired.set('desired', {
    projectId: s.f.projectId,
    actor: 'owner',
    operationId: a.request.operationId,
    submissionId: a.state.id,
    composeOperationId: randomUUID(),
    selectionKey: 'synthetic',
    request: JSON.stringify(a.request),
    wake: null,
    value: JSON.stringify({ ...a.state, preparing: true }),
  });
  const selection = { operationIds: [a.request.operationId], timeoutSeconds: 0 };
  await s.transport.query('projectHostedFinishObserve:page', {
    operationId: a.request.operationId,
    nextVersion: 0,
  });
  const first = await s.wait(selection);
  const resumed = await s.wait({ ...selection, cursor: first.result.cursor });
  assert.equal(resumed.result.status, 'timeout');
  assert.equal(resumed.result.resnapshot, true);
  assert.equal(s.events.length, 1, 'repeated unchanged snapshot is deduplicated');
  const query = s.transport.query;
  s.transport.query = async (...args) => ({ ...(await query(...args)), resnapshot: false });
  await assert.rejects(
    s.wait({ ...selection, cursor: first.result.cursor }),
    code('HOSTED_PROTOCOL_INVALID'),
  );
  assert.equal(s.counts().opens, 0);
});

test('acceptance wait stays live at ready until the canonical landing settles', async () => {
  const s = await fixture(),
    a = await s.start();
  await s.update(a.state.id, 'ready', {
    observation: { state: 'pending', pendingReason: 'queued', cause: null },
  });
  let done = false;
  const waiting = s.wait({ operationIds: [a.request.operationId], until: 'acceptance' }).then(value => {
    done = true;
    return value;
  });
  await turn();
  await turn();
  assert.equal(done, false);
  const reads = s.counts().reads;
  await turn();
  assert.equal(s.counts().reads, reads, 'ready creates no idle reads');
  await s.update(a.state.id, 'landed');
  s.wake();
  const result = await waiting;
  assert.equal(result.result.successful, true);
  assert.equal(result.result.submissions[0].submission.phase, 'landed');
  assert.equal(s.counts().closes, 1);
});

for (const stage of ['initial', 'live'])
  test(`submission observe 502 during ${stage} read keeps waiting and returns the real landing`, async () => {
    const s = await fixture(),
      a = await s.start(),
      query = s.transport.query;
    let fail = stage === 'initial',
      failures = 0;
    s.transport.query = async (...args) => {
      if (fail) {
        fail = false;
        failures++;
        throw new ForgeError('EXCHANGE_REQUEST_FAILED', 'HTTP 502');
      }
      return query(...args);
    };
    const waiting = s.wait({ operationIds: [a.request.operationId], until: 'acceptance' });
    await turn();
    if (stage === 'live') {
      fail = true;
      s.wake();
      await turn();
    }
    await s.update(a.state.id, 'landed');
    const result = await waiting;
    assert.equal(result.result.status, 'terminal');
    assert.equal(result.result.successful, true);
    assert.equal(result.result.submissions[0].submission.phase, 'landed');
    assert.equal(failures, 1);
    assert.equal(s.events.filter(e => e.type === 'observation-retry').length, 1);
    assert.equal(s.events.filter(e => e.type === 'submission' && e.submission.phase === 'landed').length, 1);
    assert.equal(s.counts().opens, s.counts().closes);
  });

test('persistent observe 502 and a hung initial read both end at the wait deadline in progress', async () => {
  for (const hangs of [false, true]) {
    const s = await fixture(),
      a = await s.start();
    let calls = 0;
    s.transport.query = async () => {
      calls++;
      if (hangs) return new Promise(() => {});
      throw new ForgeError('EXCHANGE_REQUEST_FAILED', 'HTTP 502');
    };
    const result = await s.wait({ operationIds: [a.request.operationId], timeoutSeconds: 0.01 });
    assert.equal(result.result.status, 'timeout');
    assert.equal(result.result.inProgress, true);
    assert.equal(result.result.successful, false);
    assert.equal(calls, 1);
    assert.equal(s.counts().opens, 0);
    assert.equal((await s.f.status(a.state.id)).request.phase, 'queued');
  }
});

test('a transient subscription error reconnects the selected operations and preserves the cursor', async () => {
  const s = await fixture(),
    a = await s.start();
  const waiting = s.wait({ operationIds: [a.request.operationId], until: 'acceptance' });
  await turn();
  s.fail(new TypeError('Synthetic network error with private text'));
  await turn();
  await s.update(a.state.id, 'landed');
  const result = await waiting;
  assert.equal(result.result.successful, true);
  assert.equal(s.counts().opens, s.counts().closes);
  assert(!JSON.stringify(s.events).includes('private text'));
});

test('unexpected server observe errors log bounded stage context without another read', async () => {
  const s = await fixture(),
    a = await s.start();
  const lines = [],
    original = console.error;
  console.error = (...args) => {
    lines.push(args);
  };
  try {
    // Version zero may be absent on older writers: inject a malformed selected version.
    s.f.insert('projectHostedLandingObservations', {
      projectId: s.f.projectId,
      submissionId: a.state.id,
      version: 9,
      value: 'invalid json',
    });
    const requestRow = [...s.f.tables.projectHostedLandingRequests.values()][0];
    const state = JSON.parse(requestRow.value);
    state.version = 9;
    s.f.patch('projectHostedLandingRequests', requestRow._id, { value: JSON.stringify(state) });
    await assert.rejects(
      s.transport.query('projectHostedFinishObserve:page', {
        operationId: a.request.operationId,
        nextVersion: 9,
      }),
    );
    const diagnostic = lines.find(line => line[0] === 'FORGE_FINISH_OBSERVE_FAILED');
    assert(diagnostic);
    assert.deepEqual(diagnostic[1], {
      projectId: s.f.projectId,
      operationId: a.request.operationId,
      nextVersion: 9,
      stage: 'history',
      phase: 'queued',
      version: 9,
      eventCount: 0,
    });
    assert(!JSON.stringify(diagnostic).includes('invalid json'));
  } finally {
    console.error = original;
  }
});

test('an initial read completing after the deadline cannot subscribe or emit late progress', async () => {
  const s = await fixture(),
    a = await s.start(),
    query = s.transport.query;
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  s.transport.query = async (...args) => {
    await gate;
    return query(...args);
  };
  const result = await s.wait({ operationIds: [a.request.operationId], timeoutSeconds: 0.01 });
  assert.equal(result.result.inProgress, true);
  release();
  await turn();
  await turn();
  assert.equal(s.counts().opens, 0);
  assert.equal(s.events.length, 0);
});

test('wait retains the fresh queue-ahead selection for bound callers without a final reread', async () => {
  const s = await fixture(),
    a = await s.start(),
    query = s.transport.query;
  const selection = { main: 'a'.repeat(64), mine: 'b'.repeat(64), ahead: [], more: false };
  s.transport.query = async (...args) => ({ ...(await query(...args)), queueAheadSelection: selection });
  const result = await s.wait({ operationIds: [a.request.operationId], timeoutSeconds: 0 });
  assert.deepEqual(result.result.submissions[0].queueAheadSelection, selection);
  assert.equal(s.counts().reads, 1);
});

test('575 selected operations retain one cursor and bounded metadata across an observation interruption', async () => {
  const s = await fixture(),
    a = await s.start(),
    controller = new AbortController();
  const initial = await s.transport.query('projectHostedFinishObserve:page', {
    operationId: a.request.operationId,
    nextVersion: 0,
  });
  const operationIds = Array.from({ length: 575 }, () => randomUUID());
  let reads = 0,
    subscriptions = 0,
    closes = 0;
  const transport = {
    ...s.transport,
    async query(_name, { operationId }) {
      reads++;
      const submission = {
        ...initial.submission,
        id: operationId,
        operationId,
        request: { ...initial.submission.request, operationId },
      };
      return {
        ...initial,
        operationId,
        canonicalOperationId: operationId,
        submission,
        events: [],
        nextVersion: 1,
        isDone: true,
      };
    },
  };
  const started = performance.now();
  const result = await observeHostedSubmissions(
    transport,
    { operationIds, timeoutSeconds: 60, until: 'acceptance' },
    controller.signal,
    () => {},
    () => {
      queueMicrotask(() => controller.abort());
      return {
        onUpdate() {
          subscriptions++;
          return () => {};
        },
        async close() {
          closes++;
        },
      };
    },
  );
  assert.equal(result.result.status, 'cancelled');
  assert.equal(result.result.submissions.length, 575);
  assert(result.result.submissions.every(entry => !('cursor' in entry) && !('type' in entry)));
  const bytes = Buffer.byteLength(JSON.stringify(result));
  assert(bytes < 2_000_000, `bounded selected metadata: ${bytes} bytes`);
  assert.equal(reads, 575, 'one existing initial page per selected operation; no replay at cancellation');
  assert.equal(subscriptions, 575);
  assert.equal(closes, 1);
  await turn();
  assert.equal(reads, 575, 'no idle reads after interruption');
  console.error(
    `575 selected operations: ${reads} initial reads, ${subscriptions} selected subscriptions on one connection, ${bytes} retained bytes, ${Math.round(performance.now() - started)} ms`,
  );
});

test('wait reuses observed conflict recovery across wakes and exposes a single conflict continuation', async () => {
  const s = await fixture(),
    a = await s.start(),
    b = await s.start();
  await s.update(a.state.id, 'terminal-failed', {
    error: { code: 'COMPOSITION_CONFLICT', message: 'shared.txt conflict' },
  });
  const waiting = observeHostedSubmissions(
    s.transport,
    { operationIds: [a.request.operationId, b.request.operationId], until: 'acceptance', timeoutSeconds: 5 },
    undefined,
    e => s.events.push(e),
    s.subscribe,
  );
  await turn();
  assert.equal(s.conflictReads(), 1);
  s.wake();
  await turn();
  assert.equal(s.conflictReads(), 1, 'duplicate wakes reuse the exact observed attempt recovery');
  await s.update(b.state.id, 'landed');
  s.wake();
  const result = await waiting;
  assert.equal(result.result.status, 'terminal');
  assert.equal(s.conflictReads(), 1);
  const single = await observeHostedSubmissions(
    s.transport,
    { operationIds: [a.request.operationId], until: 'acceptance', timeoutSeconds: 0 },
    undefined,
    () => {},
    s.subscribe,
  );
  assert.equal(single.result.recovery.conflict.next.action, 'sync');
  assert.equal(single.result.recovery.conflict.error.message, 'shared.txt conflict');
});

test('wait preserves embedded recovery from its observation with zero conflict reads', async () => {
  const s = await fixture(),
    a = await s.start();
  await s.update(a.state.id, 'terminal-failed', {
    error: { code: 'COMPOSITION_CONFLICT', message: 'shared.txt conflict' },
  });
  const recovery = {
    conflict: {
      candidateId: randomUUID(),
      paths: ['shared.txt'],
      next: { action: 'sync' },
      command: "nforge agent '/synthetic' sync '{}'",
    },
  };
  const query = s.transport.query;
  s.transport.query = async (...args) => {
    const page = await query(...args);
    return { ...page, events: page.events.map(event => ({ ...event, recovery })) };
  };
  const result = await observeHostedSubmissions(
    s.transport,
    { operationIds: [a.request.operationId], until: 'acceptance', timeoutSeconds: 0 },
    undefined,
    () => {},
    s.subscribe,
  );
  assert.deepEqual(result.result.recovery, recovery);
  assert.equal(s.conflictReads(), 0);
});

test(
  'a SIGKILLed hosted wait reattaches with its printed command to the same landed receipt',
  { timeout: 30000 },
  async t => {
    const s = await fixture(),
      a = await s.start(),
      operationId = a.request.operationId;
    const command = landWaitCommand('/synthetic', {
      operationId,
      result: { phase: 'finish', submission: a.state },
    });
    const input = JSON.parse(command.split(" wait '")[1].slice(0, -1));
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { observeHostedSubmissions } from ${JSON.stringify(new URL('../dist/hosted-agent-submission-wait.js', import.meta.url).href)};
    process.on('disconnect', () => process.exit());
    let sequence = 0;
    const pending = new Map();
    process.on('message', ({ id, value }) => {
      pending.get(id)(value);
      pending.delete(id);
    });
    const transport = {
      root: '/synthetic', address: JSON.parse(process.argv[1]),
      dispatch: async () => ({ schema: 1, transport: 'hosted', action: 'capabilities', operationId: null, result: { actor: 'owner' } }),
      query: (name, args) => new Promise(resolve => {
        const id = ++sequence;
        pending.set(id, resolve);
        process.send({ id, name, args });
      }),
    };
    await observeHostedSubmissions(transport, JSON.parse(process.argv[2]), undefined, () => {}, () => ({
      onUpdate() { process.send({ subscribed: true }); return () => {}; },
      async close() {},
    }));
  `,
        JSON.stringify(s.transport.address),
        JSON.stringify(input),
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    let errors = '';
    child.stderr.on('data', bytes => {
      errors += bytes;
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    });
    const subscribed = new Promise((resolve, reject) => {
      child.on('message', async message => {
        if (message.subscribed) return resolve();
        try {
          const value = await s.transport.query(message.name, message.args);
          if (child.connected) child.send({ id: message.id, value });
        } catch (error) {
          reject(error);
        }
      });
      child.once('exit', () => reject(new Error(errors || 'wait exited before subscribing')));
    });
    await subscribed;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    assert.deepEqual(await exited, [null, 'SIGKILL']);
    const acceptance = { receiptId: randomUUID(), head: 'a'.repeat(64) };
    await s.update(a.state.id, 'landed', { acceptance });
    const resumed = await s.wait(input);
    const canonical = (await s.f.status(a.state.id)).request;
    assert.equal(resumed.result.status, 'terminal');
    assert.equal(resumed.result.submissions[0].submission.id, a.state.id);
    assert.equal(resumed.result.submissions[0].submission.operationId, operationId);
    assert.deepEqual(resumed.result.submissions[0].submission.acceptance, acceptance);
    assert.deepEqual(resumed.result.submissions[0].submission.acceptance, canonical.acceptance);
    assert.equal(s.f.tables.projectHostedLandingRequests.size, 1);
    assert.deepEqual(await s.wait(input), resumed, 'reattachment retains the same terminal receipt');
  },
);
