// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import { landingBodyCounts } from './observer-projection-budget.mjs';
import { logicalTicket, ticketState, patchTicketState } from './landing-ticket-fixture.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { landWaitCommand } from '../dist/hosted-land-wait.js';
import { waitEventLine } from '../dist/hosted-wait-line.js';
import { hostedAgentCli } from '../dist/hosted-agent-cli.js';
import { HostedAgentJournal } from '../dist/hosted-agent-journal.js';
import { observationWaitHooks } from '../dist/hosted-agent-observe.js';
import { landingStateField } from '../dist/landing-state.js';
import { LANDING_STALL_MS, landingStall } from '../dist/landing-stall.js';
import { hostedLandingProgressAt } from '../dist/hosted-landing-stall.js';
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
const feed = await import(moduleUrl('../convex/projectFeed.ts'));
const { recordFeedEvent } = await import(moduleUrl('../convex/projectFeedStore.ts'));
const turn = () => new Promise(resolve => setImmediate(resolve));
const pendingWaits = new Map();
test.afterEach(async () => {
  const waits = [...pendingWaits];
  for (const [controller] of waits) controller.abort();
  await Promise.allSettled(waits.map(([, pending]) => pending));
});
async function fixture(onFeed = false, { rider = onFeed, reactive = false } = {}) {
  const f = await landingFixture(),
    subscriptions = new Set(),
    events = [],
    feedLane = randomUUID();
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
        result: { actor: 'owner', ...(onFeed ? { features: ['feed', 'feed-commit-order'] } : {}) },
      };
    },
    async query(name, args) {
      if (name === 'projectHostedLanding:status') return sStatus(args.submissionId);
      if (name === 'projectFeed:page')
        return f.call('landingWaitFeedContinuation', feed.page, { ...args, projectId: f.projectId }, actor);
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
        assert.equal(getFunctionName(ref), onFeed ? 'projectFeed:page' : 'projectHostedFinishObserve:page');
        const query = { ...args };
        if (!rider) delete query.waitFor;
        const s = { args: query, next, fail };
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
          logicalTicket(f, row),
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
    feedLane,
    events,
    start,
    update,
    wait: (input, signal) => {
      const controller = new AbortController();
      const pending = observeHostedSubmissions(
        transport,
        input,
        signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        e => events.push(e),
        subscribe,
        undefined,
        onFeed ? [feedLane] : undefined,
      );
      pendingWaits.set(controller, pending);
      // A failed assertion can leave its waiter unawaited; teardown still closes it.
      pending.finally(() => pendingWaits.delete(controller)).catch(() => {});
      return pending;
    },
    wake: () => {
      for (const s of subscriptions) s.next(null);
    },
    /** A live delivery as Convex sends one transition: every subscribed page's current value, together. */
    deliver: async () => {
      const live = [...subscriptions].filter(s => !reactive || !s.unchanged?.());
      const values = await Promise.all(
        live.map(async s => {
          const value = await f.call(
            reactive ? 'observerBudgetPage' : 'landingWaitLive',
            onFeed ? feed.page : observe.page,
            { ...s.args, projectId: f.projectId },
            actor,
          );
          if (reactive) s.unchanged = f.readSet();
          return value;
        }),
      );
      live.forEach((s, index) => s.next(values[index]));
      return values;
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
    async record(state, kind) {
      await f.run(
        'landingWaitTerminalEvent',
        ctx =>
          recordFeedEvent(ctx, {
            projectId: f.projectId,
            actor,
            laneId: feedLane,
            kind,
            operationId: state.operationId,
            submissionId: state.id,
          }),
        {},
      );
    },
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
    // 24 page ranges, one account read naming the caller by handle and one empty stop-row probe
    // on the landed reply (friction 28e84c06: a stopped GitHub mirror is named).
    assert(
      c.documents - landingBodyCounts(c).reads <= 26 && c.ranges - landingBodyCounts(c).ranges <= 26,
      JSON.stringify(c),
    );
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
    const state = ticketState(s.f, row);
    state.version++;
    state.phase = 'landed';
    state.observation = { state: 'landed', pendingReason: null, cause: null };
    patchTicketState(s.f, row, state);
    s.f.patch('projectHostedLandingRequests', row._id, { phase: 'landed' });
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

// 593fc2d7 (lead follow-up to 52f2f894): uuidgen prints upper case; the MCP wait must treat an
// uppercase id and its lowercase twin as one operation, as the CLI wait does.
test('593fc2d7: MCP forge_wait finds a landing by the uppercase spelling of its operation id', async () => {
  const s = await fixture(),
    a = await s.start(),
    tools = new Map();
  registerHostedAgentWorkflow(
    {
      registerTool(name, config, call) {
        tools.set(name, { config, call });
      },
    },
    s.transport,
    s.subscribe,
  );
  const extra = { signal: new AbortController().signal, _meta: {}, async sendNotification() {} };
  const wait = async id =>
    JSON.parse(
      (await tools.get('forge_wait').call({ operationIds: [id], timeoutSeconds: 0, maxWaitMs: 0 }, extra))
        .content[0].text,
    );
  const lower = await wait(a.request.operationId);
  const upper = await wait(a.request.operationId.toUpperCase());
  assert.equal(upper.error, undefined, JSON.stringify(upper.error));
  assert.equal(upper.result.status, lower.result.status);
  assert.deepEqual(
    upper.result.submissions?.map(entry => entry.submission.id),
    lower.result.submissions?.map(entry => entry.submission.id),
  );
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
    state = ticketState(s.f, row);
  await s.f.run(
    'landingHistorySelect',
    ctx =>
      store.writeLanding(
        ctx,
        logicalTicket(s.f, row),
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
  assert.deepEqual(ticketState(s.f, firstRow), original);
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

test('an MCP landing budget reply names an owner approval hold', async () => {
  const s = await fixture();
  const { request, state } = await s.start();
  const tools = new Map();
  const reason = 'Owner approval required for protected paths: .github/workflows/check.yml';
  await s.update(state.id, 'ready', {
    observation: { state: 'pending', pendingReason: 'waiting-for-review', cause: null },
    error: { code: 'OWNER_REVIEW_REQUIRED', message: reason },
  });
  registerHostedAgentWorkflow(
    {
      registerTool(name, _config, call) {
        tools.set(name, call);
      },
    },
    s.transport,
    s.subscribe,
  );
  const reply = await tools.get('forge_wait')(
    { operationIds: [request.operationId], maxWaitMs: 0 },
    { signal: new AbortController().signal, _meta: {} },
  );
  assert.equal(reply.isError, undefined);
  const { result } = JSON.parse(reply.content[0].text);
  assert.equal(result.waitOutcome, 'still-landing');
  assert.equal(result.stage, 'held-review');
  assert.equal(result.hold.reason, reason);
  assert.match(result.message, /Owner approval required/);
  assert.equal(s.counts().reads, 1);
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

// Incident 19328518: a passed entry parked behind an older submission had no visible reason.
test('wait carries the order wait of a parked READY entry and drops it once released', async () => {
  const s = await fixture(),
    a = await s.start();
  const older = randomUUID();
  const ready = { observation: { state: 'pending', pendingReason: null, cause: null } };
  await s.update(a.state.id, 'ready', ready);
  const row = () =>
    [...s.f.tables.projectHostedLandingRequests.values()].find(row => row.submissionId === a.state.id);
  await s.f.run('parkBehindOlder', ctx => ctx.db.patch(row()._id, { orderWait: older }), {});
  const selection = { operationIds: [a.request.operationId], timeoutSeconds: 0 };
  const pending = await s.wait(selection);
  assert.equal(pending.result.status, 'timeout');
  assert.equal(pending.result.submissions[0].orderWait?.submissionId, older);
  assert.match(pending.result.submissions[0].orderWait.message, /waiting for older submission/);
  await s.f.run('releaseWaiter', ctx => ctx.db.patch(row()._id, { orderWait: undefined }), {});
  const released = await s.wait({ ...selection, cursor: pending.result.cursor });
  assert.equal(released.result.submissions[0].orderWait, undefined, 'a released entry shows no wait');
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
  const checkRunId = randomUUID();
  await s.update(a.state.id, 'landed', {
    acceptance: { receiptId: randomUUID(), head: 'a'.repeat(64), proofRunId: checkRunId },
  });
  s.wake();
  const result = await waiting;
  assert.equal(result.result.successful, true);
  assert.equal(result.result.submissions[0].submission.phase, 'landed');
  assert.equal(result.result.submissions[0].checkRunId, checkRunId);
  assert.equal(s.events.findLast(event => event.terminal).checkRunId, checkRunId);
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
    const state = ticketState(s.f, requestRow);
    state.version = 9;
    patchTicketState(s.f, requestRow, state);
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
  'a SIGKILLed feed-backed wait reattaches with its printed command to the same landed receipt',
  { timeout: 30000 },
  async t => {
    const s = await fixture(true),
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
    let update;
    process.on('message', ({ id, value, live }) => {
      if (live) {
        update(value);
        return;
      }
      pending.get(id)(value);
      pending.delete(id);
    });
    const transport = {
      root: '/synthetic', address: JSON.parse(process.argv[1]),
    dispatch: async () => ({ schema: 1, transport: 'hosted', action: 'capabilities', operationId: null, result: { actor: 'owner', features: ['feed', 'feed-commit-order'] } }),
      query: (name, args) => new Promise(resolve => {
        const id = ++sequence;
        pending.set(id, resolve);
        process.send({ id, name, args });
      }),
    };
    await observeHostedSubmissions(transport, JSON.parse(process.argv[2]), undefined, event => {
      if (event.type === 'submission' && event.submission.observation.state === 'pending')
        process.send({ observedPending: true });
    }, () => ({
      onUpdate(_ref, args, notify) {
        update = notify;
        process.send({ subscribed: true, args });
        return () => {};
      },
      async close() {},
    }), undefined, [process.argv[3]]);
  `,
        JSON.stringify(s.transport.address),
        JSON.stringify(input),
        s.feedLane,
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    let errors = '',
      killed = false,
      sendError;
    child.stderr.on('data', bytes => {
      errors += bytes;
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        killed = true;
        child.kill('SIGKILL');
        await exited;
      }
    });
    const subscribed = new Promise((resolve, reject) => {
      let observedPending = false;
      child.on('message', async message => {
        if (message.observedPending) {
          observedPending = true;
          return;
        }
        try {
          const value = await s.transport.query(
            message.subscribed ? 'projectFeed:page' : message.name,
            message.args,
          );
          // A reply still in flight when the test SIGKILLs the wait fails with EPIPE: only that
          // deliberate kill excuses a send error.
          if (child.connected)
            child.send({ id: message.id, live: message.subscribed, value }, error => {
              if (error && !killed) reject((sendError = error));
              if (!error && message.subscribed && observedPending) resolve();
            });
        } catch (error) {
          reject(error);
        }
      });
      child.once('exit', () => reject(new Error(errors || 'wait exited before subscribing')));
    });
    await subscribed;
    const exited = once(child, 'exit');
    killed = true;
    child.kill('SIGKILL');
    assert.deepEqual(await exited, [null, 'SIGKILL']);
    assert.equal(sendError, undefined, 'every reply before the kill reached the wait');
    const acceptance = { receiptId: randomUUID(), head: 'a'.repeat(64) };
    await s.update(a.state.id, 'landed', { acceptance });
    await s.record(a.state, 'landing.landed');
    const sameOperation = await s.f.enqueue(a.request);
    assert.equal(sameOperation.id, a.state.id);
    assert.equal(sameOperation.operationId, operationId);
    assert.deepEqual(sameOperation.acceptance, acceptance);
    const replay = s.wait(input);
    await turn();
    await s.deliver();
    const resumed = await replay;
    const canonical = (await s.f.status(a.state.id)).request;
    assert.equal(resumed.result.status, 'terminal');
    assert.equal(resumed.result.submissions[0].submission.id, a.state.id);
    assert.equal(resumed.result.submissions[0].submission.operationId, operationId);
    assert.deepEqual(resumed.result.submissions[0].submission.acceptance, acceptance);
    assert.deepEqual(resumed.result.submissions[0].submission.acceptance, canonical.acceptance);
    assert.equal(s.f.tables.projectHostedLandingRequests.size, 1);
    const again = s.wait(input);
    await turn();
    await s.deliver();
    assert.deepEqual(await again, resumed, 'reattachment retains the same terminal receipt');
  },
);

function feedBackedCliWait(t, s, operationId) {
  const root = mkdtempSync(join(tmpdir(), 'forge-wait-progress-'));
  const { address } = s.transport;
  const oldExit = process.exitCode;
  t.after(() => {
    delete observationWaitHooks.subscribe;
    process.exitCode = oldExit;
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}.forge-client`, { recursive: true, force: true });
    rmSync(`${root}.forge-metrics.jsonl`, { force: true });
  });
  new HostedAgentJournal(root, address, 'owner', 'finish', { laneId: s.feedLane }, operationId);
  observationWaitHooks.subscribe = s.subscribe;
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const input = { operationIds: [operationId], until: 'acceptance', timeoutSeconds: 1 };
  const wait = command => hostedAgentCli(root, 'wait', command, address, s.transport);
  const expireBudget = () => {
    now += 1000;
    t.mock.timers.tick(1000);
  };
  return { input, wait, address, expireBudget, root };
}

test('a foreground land at budget shows the observed check and resumes the original landing', async t => {
  const s = await fixture(true);
  const { request, state } = await s.start();
  const { operationId } = request;
  const requests = s.f.tables.projectHostedLandingRequests;
  const [rowId, row] = [...requests.entries()].find(([, row]) => row.submissionId === state.id);
  requests.delete(rowId);
  const desired = s.f.tables.projectHostedLandingDesired;
  desired.set('desired', {
    projectId: s.f.projectId,
    actor: 'owner',
    operationId,
    submissionId: state.id,
    composeOperationId: randomUUID(),
    selectionKey: 'synthetic',
    request: JSON.stringify(request),
    wake: null,
    value: JSON.stringify({ ...state, phase: 'composing', preparing: true }),
  });
  const { wait, address, expireBudget, root } = feedBackedCliWait(t, s, operationId);
  const snapshot = await s.transport.query('projectHostedFinishObserve:page', {
    operationId,
    nextVersion: 0,
  });
  const stub = '__foregroundLandProgress';
  let submissions = 0;
  globalThis[stub] = {
    HostedAgentTransport: class {
      constructor() {
        return { ...s.transport, root };
      }
    },
    hostedAgentCli: async (_root, action) => {
      assert.equal(action, 'finish');
      submissions++;
      return {
        action,
        operationId,
        result: { phase: 'finish', submission: snapshot.submission },
      };
    },
  };
  t.after(() => delete globalThis[stub]);
  const imports = {
    './hosted-agent-transport.js': 'HostedAgentTransport',
    './hosted-agent-cli.js': 'hostedAgentCli',
  };
  const source = readFileSync(new URL('../dist/hosted-land-cli.js', import.meta.url), 'utf8').replace(
    /from '([^']+)'/g,
    (match, path) =>
      imports[path]
        ? `from 'data:text/javascript,export const ${imports[path]} = globalThis.${stub}.${imports[path]};'`
        : path.startsWith('.')
          ? `from '${new URL(`../dist/${path.slice(2)}`, import.meta.url).href}'`
          : match,
  );
  const { hostedLandCli } = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  );
  const output = [];
  t.mock.method(process.stderr, 'write', chunk => {
    output.push(String(chunk));
    return true;
  });
  const live = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk, ...args) => {
    if (String(chunk).startsWith('{"type":"submission"')) {
      live.push(JSON.parse(String(chunk)));
      return true;
    }
    return write(chunk, ...args);
  });
  const pending = hostedLandCli(root, { operationId, message: 'Land' }, address, {
    detach: false,
    wait: true,
    timeoutSeconds: 1,
  });
  await turn();
  await s.deliver();
  desired.delete('desired');
  requests.set(rowId, row);
  const lastProgressAt = new Date(Date.parse(state.at) + 60_000).toISOString();
  await s.update(state.id, 'checking', { timing: { submittedAt: state.at, ciObservedAt: lastProgressAt } });
  await s.deliver();
  await turn();
  assert.equal(live.at(-1)?.phase, 'checking', 'the foreground prints before the wait exits');
  const { submission } = await s.transport.query('projectHostedFinishObserve:page', {
    operationId,
    nextVersion: 0,
  });
  assert.equal(submission.operationId, operationId);
  assert.equal(submission.attemptId, state.attemptId);
  assert.equal(submission.phase, 'checking');
  const beforeBudget = s.f.metrics.calls;
  expireBudget();
  const { result } = await pending;
  assert.equal(process.exitCode, 3);
  assert.equal(result.waitStatus, 'timeout');
  assert.deepEqual(result.landingState, landingStateField(submission));
  assert.equal(result.pendingProgress.phase, submission.phase);
  assert.equal(result.pendingProgress.attemptId, submission.attemptId);
  assert.equal(result.pendingProgress.version, submission.version);
  assert.equal(result.submission.version, state.version, 'retain the canonical snapshot at its own version');
  assert.match(output.join(''), /^CHECKING; not landed yet$/m);
  assert.doesNotMatch(output.join(''), /^QUEUED;/m);
  assert.equal(result.waitOutcome, 'still-landing');
  assert.equal(result.stage, 'checking');
  assert.equal(result.lastProgressAt, lastProgressAt);
  assert.match(output.join(''), /Still landing \(checking\)/);
  assert(output.join('').includes(result.waitCommand));
  assert.equal(s.f.metrics.calls, beforeBudget, 'formatting adds no Convex call');
  assert.equal(submissions, 1);

  const resumedInput = JSON.parse(result.waitCommand.split(" wait '")[1].slice(0, -1));
  assert.deepEqual(resumedInput, { operationIds: [operationId], until: 'acceptance' });
  const resumed = wait({ ...resumedInput, timeoutSeconds: 1 });
  await turn();
  const acceptance = { receiptId: randomUUID(), head: 'a'.repeat(64) };
  await s.update(state.id, 'landed', { acceptance });
  await s.record(state, 'landing.landed');
  await s.deliver();
  const { result: settled } = await resumed;
  assert.equal(process.exitCode, 0);
  assert.equal(settled.status, 'terminal');
  assert.equal(settled.submission.operationId, operationId);
  assert.equal(settled.submission.attemptId, state.attemptId);
  assert.deepEqual(settled.submission.acceptance, (await s.f.status(state.id)).request.acceptance);
  assert.deepEqual(settled.submission.acceptance, acceptance);
  assert.equal(settled.waitCommand, undefined);
  assert.equal(s.counts().opens, s.counts().closes);
});

test('a bounded acceptance wait reports the observed check and resumes the original landing', async t => {
  const s = await fixture(true);
  const { request, state } = await s.start();
  const operationId = request.operationId;
  const { input, wait, address, expireBudget } = feedBackedCliWait(t, s, operationId);
  const pending = wait(input);
  await turn();
  await s.deliver();
  assert.equal(s.counts().reads, 1);

  const lastProgressAt = new Date(Date.parse(state.at) + 60_000).toISOString();
  await s.update(state.id, 'checking', { timing: { submittedAt: state.at, ciObservedAt: lastProgressAt } });
  const [feedPage] = await s.deliver();
  await turn();
  const { submission, ...page } = await s.transport.query('projectHostedFinishObserve:page', {
    operationId,
    nextVersion: 0,
  });
  assert.equal(page.operationId, operationId);
  assert.equal(submission.id, state.id);
  assert.equal(submission.attemptId, state.attemptId);
  assert.equal(submission.phase, 'checking');
  const [projected] = feedPage.waiting;
  assert.equal(projected.pending.attemptId, submission.attemptId);
  assert.equal(projected.phase, submission.phase);
  assert.equal(projected.version, submission.version);
  const beforeBudget = s.f.metrics.calls;
  expireBudget();
  const bounded = (await pending).result;
  assert.equal(process.exitCode, 3);
  assert.equal(bounded.status, 'IN_PROGRESS');
  assert.equal(bounded.reason, 'budget');
  assert.equal(bounded.waitOutcome, 'still-landing');
  assert.equal(bounded.stage, 'checking');
  assert.equal(bounded.lastProgressAt, lastProgressAt);
  assert.match(bounded.message, /Still landing \(checking\)/);
  assert(bounded.message.includes(bounded.waitCommand));
  assert.equal(bounded.phase, submission.phase);
  assert.equal(bounded.landingState.state, 'checking');
  assert.deepEqual(bounded.next.operationIds, [operationId]);
  assert.equal(s.f.metrics.calls, beforeBudget, 'the budget reply makes no extra Convex call');
  assert.equal(s.counts().reads, 2, 'only the baseline and the explicit comparison read');
  const { readBytes, writeBytes } = s.f.counts.findLast(count => count.name === 'landingWaitLive');
  assert.equal(writeBytes, 0);
  t.diagnostic(
    `Existing feed evaluation: ${readBytes} DB bytes, ${Buffer.byteLength(JSON.stringify(feedPage))} reply bytes. CLI budget reply: ${Buffer.byteLength(JSON.stringify(bounded))} result bytes.`,
  );

  const resumedInput = JSON.parse(bounded.waitCommand.split(" wait '")[1].slice(0, -1));
  assert.deepEqual(resumedInput, { ...input, ...address });
  const resumed = wait(resumedInput);
  await turn();
  const acceptance = { receiptId: randomUUID(), head: 'a'.repeat(64) };
  await s.update(state.id, 'landed', { acceptance });
  await s.record(state, 'landing.landed');
  await s.deliver();
  const settled = (await resumed).result;
  assert.equal(process.exitCode, 0);
  assert.equal(settled.status, 'terminal');
  assert.equal(settled.submission.operationId, operationId);
  assert.equal(settled.submission.attemptId, state.attemptId);
  assert.deepEqual(settled.submission.acceptance, acceptance);
  assert.equal(settled.waitCommand, undefined);
  assert.equal(s.counts().reads, 4, 'the resumed wait reads its own baseline and terminal receipt');
  assert.equal(s.counts().opens, s.counts().closes);
});

test('a stall recorded while waiting is reported at the budget without a fresh read', async t => {
  const s = await fixture(true);
  const { request, state } = await s.start();
  const { input, wait, expireBudget } = feedBackedCliWait(t, s, request.operationId);
  const pendingReason = 'checking';
  const observation = { state: 'pending', pendingReason, cause: null };
  await s.update(state.id, 'checking', { observation });
  const pending = wait(input);
  await turn();
  await s.deliver();

  const lastProgressAt = hostedLandingProgressAt((await s.f.status(state.id)).request);
  const stall = landingStall(
    'checking',
    'check runner',
    lastProgressAt,
    Date.parse(lastProgressAt) + LANDING_STALL_MS,
  );
  await s.update(state.id, 'checking', { observation: { ...observation, stall } });
  await s.deliver();
  const calls = s.f.metrics.calls;
  expireBudget();

  const { result } = await pending;
  assert.equal(process.exitCode, 3);
  assert.equal(result.waitOutcome, 'stalled');
  assert.equal(result.stage, 'checking');
  assert.equal(result.lastProgressAt, lastProgressAt);
  assert.deepEqual(result.stall, stall);
  assert.match(result.message, /Landing is stalled \(checking\)/);
  assert(result.message.includes(result.waitCommand));
  assert.equal(s.counts().reads, 1);
  assert.equal(s.f.metrics.calls, calls);
  assert.equal(s.counts().opens, s.counts().closes);
});

test('a pending metadata update keeps the recorded hold reason on the bounded reply', async t => {
  const s = await fixture(true);
  const { request, state } = await s.start();
  const reason = 'Waiting for pinned parent Candidate';
  const held = {
    observation: { state: 'pending', pendingReason: 'waiting-for-dependency', cause: null },
    error: { code: 'DEPENDENCY_NOT_ACCEPTED', message: reason },
  };
  await s.update(state.id, 'ready', held);
  const { input, wait, expireBudget } = feedBackedCliWait(t, s, request.operationId);
  const pending = wait(input);
  await turn();
  await s.deliver();

  await s.update(state.id, 'ready', held);
  const [feedPage] = await s.deliver();
  assert.equal(feedPage.waiting[0].version, state.version + 2);
  expireBudget();
  const { result } = await pending;
  assert.equal(result.reason, 'budget');
  assert.equal(result.landingState.state, 'held-dependency');
  assert.equal(result.hold.reason, reason);
  assert.equal(s.counts().reads, 1);
});

test('a feed update for a replacement attempt does not relabel the pinned observation', async t => {
  const s = await fixture(true);
  const { request, state } = await s.start();
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = s.wait({ operationIds: [request.operationId], until: 'acceptance', timeoutSeconds: 1 });
  await turn();
  await s.deliver();

  const original = (await s.f.status(state.id)).attempt;
  const replacement = {
    ...original,
    id: randomUUID(),
    parentAttemptId: original.id,
    number: original.number + 1,
    operations: { check: randomUUID(), accept: randomUUID() },
  };
  await s.f.run('landingWaitInsertReplacement', store.insertLandingAttempt, replacement);
  await s.update(state.id, 'checking', { attemptId: replacement.id });
  const [feedPage] = await s.deliver();
  assert.equal(feedPage.waiting[0].pending.attemptId, replacement.id);
  now = 1000;
  t.mock.timers.tick(1000);
  const { result } = await pending;
  assert.equal(result.status, 'timeout');
  assert.equal(result.submissions[0].submission.attemptId, state.attemptId);
  assert.equal(result.pendingProgress, undefined);
  assert.equal(s.counts().reads, 1);
});

test('feed wait delivers compact phase, hold, order and stall changes before acceptance without extra page reads', async () => {
  const s = await fixture(true, { reactive: true });
  const { request, state } = await s.start();
  const operationId = request.operationId;
  const pending = s.wait({ operationIds: [operationId], until: 'acceptance' });
  await turn();
  await s.deliver();
  const lines = () =>
    s.events.filter(event => event.type === 'submission-progress').map(event => waitEventLine(event).line);
  const ready = { state: 'pending', pendingReason: 'waiting-for-review', cause: null };
  const held = { ...ready, pendingReason: 'waiting-for-dependency' };
  const orderWait = randomUUID();
  const checking = { state: 'pending', pendingReason: 'checking', cause: null };
  await s.update(state.id, 'checking', { observation: checking });
  await s.deliver();
  await turn();
  const lastProgressAt = hostedLandingProgressAt((await s.f.status(state.id)).request);
  const stall = landingStall(
    'checking',
    'check runner',
    lastProgressAt,
    Date.parse(lastProgressAt) + LANDING_STALL_MS,
  );
  const row = () =>
    [...s.f.tables.projectHostedLandingRequests.values()].find(row => row.submissionId === state.id);
  const park = waitingFor =>
    s.f.run('feedOrderWait', ctx => ctx.db.patch(row()._id, { orderWait: waitingFor }), {});
  for (const [phase, data] of [
    ['checking', { observation: { ...checking, stall } }],
    ['checking', { observation: { ...checking, stall } }],
    ['ready', { observation: ready }],
    ['ready', { observation: held }],
  ]) {
    await s.update(state.id, phase, data);
    await s.deliver();
    await turn();
  }
  await park(orderWait);
  await s.deliver();
  await turn();
  await park(undefined);
  await s.deliver();
  await turn();
  assert.deepEqual(
    lines().map(line => [line.phase, line.reason, line.waitingFor, line.stall]),
    [
      ['checking', 'checking', undefined, undefined],
      ['checking', 'checking', undefined, stall.message],
      ['ready', 'waiting-for-review', undefined, undefined],
      ['ready', 'waiting-for-dependency', undefined, undefined],
      ['ready', 'waiting-for-dependency', orderWait, undefined],
      ['ready', 'waiting-for-dependency', undefined, undefined],
    ],
  );
  assert(lines().every(line => line.operationId === operationId && !('cursor' in line)));
  assert.equal(s.counts().reads, 1, 'only the canonical baseline before acceptance');
  assert(s.events.every(event => !event.terminal));

  const acceptance = { receiptId: randomUUID(), head: 'a'.repeat(64) };
  await s.update(state.id, 'landed', { acceptance });
  await s.record(state, 'landing.landed');
  await s.deliver();
  const { result } = await pending;
  assert.deepEqual(result.submissions[0].submission.acceptance, acceptance);
  assert.equal(s.counts().reads, 2, 'the terminal event drains the canonical receipt once');
});

test('six matched landing waits preserve outcomes and measure the live read cost with and without the feed rider', async t => {
  const measures = [];
  const outcomes = ['landed', 'failed', 'cancelled', 'landed', 'failed', 'cancelled'];
  for (const mode of ['legacy', 'feed without rider', 'feed with rider']) {
    const s = await fixture(mode !== 'legacy', { rider: mode === 'feed with rider', reactive: true });
    const calls = [];
    const evaluations = [];
    let observerReadBytes = 0;
    for (const outcome of outcomes) {
      const a = await s.start();
      const before = s.f.metrics.calls;
      const cursor = s.f.counts.length;
      const pending = s.wait({ operationIds: [a.request.operationId], until: 'acceptance' });
      await turn();
      await s.deliver(); // Initial subscription evaluation.
      const idle = s.f.metrics.calls;
      await s.deliver(); // No changed query dependency.
      await turn();
      assert.equal(s.f.metrics.calls, idle);
      for (const stage of ['queued', 'checking', 'ready']) {
        await s.update(
          a.state.id,
          stage,
          stage === 'ready'
            ? {
                observation: { state: 'pending', pendingReason: 'waiting-for-review', cause: null },
              }
            : {},
        );
        await s.deliver();
        await turn();
      }
      const phase = outcome === 'landed' ? 'landed' : 'terminal-failed';
      const acceptance = { receiptId: randomUUID(), head: 'a'.repeat(64) };
      const error =
        outcome === 'cancelled' ? { code: 'LANDING_CANCELLED', message: 'Withdrawn.' } : undefined;
      await s.update(a.state.id, phase, {
        ...(outcome === 'landed' ? { acceptance } : {}),
        ...(error ? { error } : {}),
      });
      // Every mode observes the same terminal transition and explicit input Lane.
      await s.record(a.state, `landing.${outcome}`);
      await s.deliver();
      const observed = await pending;
      assert.equal(observed.result.status, 'terminal');
      assert.equal(observed.result.successful, outcome === 'landed');
      const { submission } = observed.result.submissions[0];
      assert.equal(submission.id, a.state.id);
      assert.equal(submission.operationId, a.request.operationId);
      assert.equal(submission.observation.state, phase);
      if (outcome === 'landed') assert.deepEqual(submission.acceptance, acceptance);
      if (error) assert.deepEqual(submission.error, error);
      const counts = s.f.counts
        .slice(cursor)
        .filter(
          count =>
            count.query && (count.name.startsWith('landingWait') || count.name === 'observerBudgetPage'),
        );
      observerReadBytes += counts.reduce((sum, count) => sum + count.readBytes, 0);
      // Test transport stubs the same single capabilities call in each mode.
      calls.push(counts.length + 1);
      evaluations.push(counts.filter(count => count.name === 'observerBudgetPage').length);
      assert(s.f.metrics.calls > before);
    }
    measures.push({ mode, calls, evaluations, observerReadBytes });
    assert.deepEqual(s.counts().opens, s.counts().closes);
  }
  t.diagnostic(JSON.stringify(measures));
  const [legacy, bare, rider] = measures;
  assert(legacy.calls.every((calls, index) => calls >= rider.calls[index]));
  assert(legacy.observerReadBytes > rider.observerReadBytes);
  assert(rider.evaluations.every((calls, index) => calls >= bare.evaluations[index]));
});

test('the feed streams hold-code changes and release at the same phase without canonical rereads', async () => {
  const s = await fixture(true);
  const { request, state } = await s.start();
  const pending = s.wait({ operationIds: [request.operationId], until: 'acceptance' });
  await turn();
  await s.deliver();
  for (const code of ['MAIN_RED', 'CI_DOWN', null]) {
    await s.update(state.id, 'queued', { error: code ? { code, message: 'Synthetic hold' } : null });
    await s.deliver();
    await turn();
  }
  assert.deepEqual(
    s.events
      .filter(event => event.type === 'submission-progress')
      .map(event => {
        const line = waitEventLine(event).line;
        return [line.phase, line.error ?? null];
      }),
    [
      ['queued', 'MAIN_RED'],
      ['queued', 'CI_DOWN'],
      ['queued', null],
    ],
  );
  assert.equal(s.counts().reads, 1);
  await s.update(state.id, 'terminal-failed');
  await s.record(state, 'landing.failed');
  await s.deliver();
  await pending;
  assert.equal(s.counts().reads, 2);
});

test('a feed wait ignores unrelated landing rows and still reports newly marked sync advice', async () => {
  const s = await fixture(true, { reactive: true });
  const selected = await s.start();
  const other = await s.start();
  const pending = s.wait({ operationIds: [selected.request.operationId], until: 'acceptance' });
  await turn();
  await s.deliver();
  await s.update(other.state.id, 'checking');
  const before = s.f.metrics.calls;
  await s.deliver();
  assert.equal(s.f.metrics.calls, before, 'an unrelated landing row does not invalidate the scoped wait');
  await s.f.run(
    'markSelectedLanding',
    async ctx => {
      const row = await ctx.db
        .query('projectHostedLandingRequests')
        .withIndex('by_project_and_submission', q =>
          q.eq('projectId', s.f.projectId).eq('submissionId', selected.state.id),
        )
        .unique();
      await ctx.db.patch(row._id, {
        wouldConflict: JSON.stringify({
          paths: ['shared.ts'],
          more: 0,
          at: new Date(s.f.now()).toISOString(),
          landedSubmissionId: other.state.id,
          laneId: s.feedLane,
          next: 'Sync with accepted main.',
        }),
      });
    },
    {},
  );
  await s.deliver();
  const result = await pending;
  assert.equal(result.result.status, 'sync-required');
  assert.equal(result.result.code, 'SYNC_REQUIRED');
  assert.deepEqual(result.result.next, { action: 'land', save: true, laneId: s.feedLane });
});

test('a feed wait that starts checking still re-drives a stalled Ready settlement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = await fixture(true, { reactive: true });
  const selected = await s.start();
  await s.update(selected.state.id, 'checking');
  const redrives = [];
  s.transport.mutation = async (action, args) => {
    redrives.push([action, args]);
  };
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = s.wait(
    { operationIds: [selected.request.operationId], until: 'acceptance' },
    controller.signal,
  );
  await turn();
  await s.deliver();
  await s.update(selected.state.id, 'ready', {
    observation: { state: 'pending', pendingReason: 'queued', cause: null },
  });
  await s.deliver();
  await turn();
  assert.deepEqual(redrives, []);
  t.mock.timers.tick(120_000);
  await turn();
  assert.deepEqual(redrives, [['projectHostedLandingRedrive:redrive', { submissionId: selected.state.id }]]);
  controller.abort();
  await pending;
});

test('wake wait: one settle wait through queued, checking and ready wakes once per outcome with the receipt', async t => {
  const { wakeContinuation, WAKE_BUDGET_SECONDS } = await import('../dist/agent-wake.js');
  const outcomes = {
    landed: ['landed', {}],
    failed: [
      'terminal-failed',
      { observation: { state: 'terminal-failed', pendingReason: null, cause: 'check-failed' } },
    ],
    cancelled: [
      'terminal-failed',
      {
        observation: { state: 'terminal-failed', pendingReason: null, cause: 'rejected' },
        error: { code: 'LANDING_CANCELLED', message: 'Withdrawn by the Lane author.' },
      },
    ],
  };
  for (const [name, [status, overrides]] of Object.entries(outcomes)) {
    const s = await fixture(),
      a = await s.start();
    const { action, ...input } = wakeContinuation('/synthetic', {
      action: 'wait',
      operationIds: [a.request.operationId],
      until: 'acceptance',
    }).next;
    assert.equal(action, 'wait');
    assert.equal(input.timeoutSeconds, WAKE_BUDGET_SECONDS, 'one budget covers the whole landing');
    let returns = 0;
    // A failed assertion must not leave a two-hour observer holding the test process.
    const stop = new AbortController();
    t.after(() => stop.abort());
    const waiting = s.wait(input, stop.signal).then(value => {
      returns++;
      return value;
    });
    await turn();
    const idle = s.counts().reads;
    for (const step of ['queued', 'checking', 'ready']) {
      await s.update(
        a.state.id,
        step,
        step === 'ready' ? { observation: { state: 'pending', pendingReason: 'queued', cause: null } } : {},
      );
      s.wake();
      await turn();
      await turn();
      assert.equal(returns, 0, `${name}: ${step} is not a wake`);
    }
    await turn();
    const between = s.counts().reads;
    await turn();
    assert.equal(s.counts().reads, between, `${name}: no idle reads between changes`);
    assert(between - idle <= 3, `${name}: one reread per change, ${between - idle}`);
    await s.update(a.state.id, status, overrides);
    s.wake();
    const result = await waiting;
    assert.equal(returns, 1, `${name}: exactly one wake`);
    assert.equal(result.result.status, 'terminal', name);
    const { submission } = result.result.submissions[0];
    assert.equal(submission.observation.state, status, name);
    if (name === 'cancelled') assert.equal(submission.error.code, 'LANDING_CANCELLED');
    assert.equal(s.counts().opens, s.counts().closes, `${name}: the observer closes`);
  }
});

test('a wait across a server deploy that changes the landed reply shape returns the landing outcome (71ef0a66)', async () => {
  const receipt = { receiptId: randomUUID(), head: 'a'.repeat(64) };
  // The server deploys while the wait runs: from then on, a landed reply has a shape this CLI does not know.
  const deploy = (s, change) => {
    const query = s.transport.query.bind(s.transport);
    s.transport.query = async (name, args) => {
      const page = await query(name, args);
      if (name !== 'projectHostedFinishObserve:page') return page;
      const touch = sub =>
        sub.observation.state === 'landed' ? change({ ...sub, acceptance: receipt }) : sub;
      return {
        ...page,
        submission: touch(page.submission),
        events: page.events.map(e => ({ ...e, submission: touch(e.submission) })),
      };
    };
  };
  const run = async change => {
    const s = await fixture(),
      a = await s.start();
    const waiting = s.wait({ operationIds: [a.request.operationId] }).catch(error => error);
    await turn();
    if (change) deploy(s, change);
    await s.update(a.state.id, 'landed');
    s.wake();
    return { s, result: await waiting };
  };
  const control = await run();
  assert.equal(control.result.result.successful, true);
  assert.equal(control.result.result.contractSkew, undefined);
  const reads = control.s.counts().reads;

  // An optional field changed shape (the incident: acceptance.acceptedBy was renamed under the CLI).
  const optional = await run(sub => ({
    ...sub,
    acceptance: { ...sub.acceptance, acceptedBy: { kind: 'delegate', at: sub.at, note: 'n' } },
  }));
  assert.equal(optional.result.result.status, 'terminal');
  assert.equal(optional.result.result.successful, true);
  const landed = optional.result.result.submissions[0].submission;
  assert.equal(landed.acceptance.receiptId, receipt.receiptId, 'the receipt survives');
  assert.equal('acceptedBy' in landed.acceptance, false);
  const skew = optional.result.result.contractSkew;
  assert.deepEqual(skew.paths, [
    'submission.acceptance.acceptedBy.kind',
    'events.*.submission.acceptance.acceptedBy.kind',
  ]);
  assert.deepEqual(skew.dropped, [
    'submission.acceptance.acceptedBy',
    'events.*.submission.acceptance.acceptedBy',
  ]);
  assert.equal(skew.stable, false);
  assert.equal(skew.side, 'server-older', 'the fixture server advertises no contract features');
  assert.match(skew.message, /differs from this CLI's contract at submission\.acceptance\.acceptedBy\.kind/);
  assert.equal(optional.s.counts().reads, reads, 'no read added');

  // A required field changed: the stable outcome fields still tell the outcome.
  const required = await run(sub => ({ ...sub, phase: 'published', sequence: 'one' }));
  assert.equal(required.result.result.successful, true);
  assert.equal(required.result.result.submissions[0].submission.acceptance.receiptId, receipt.receiptId);
  assert.equal(required.result.result.contractSkew.stable, true);
  assert.match(required.result.result.contractSkew.message, /read from its stable fields/);
  assert.equal(required.s.counts().reads, reads, 'no read added');

  // Even the stable outcome changed: the error says the landing may have landed and how to check.
  const unknown = await run(sub => ({ ...sub, observation: { ...sub.observation, state: 'finalized' } }));
  assert(unknown.result instanceof ForgeError);
  assert.equal(unknown.result.code, 'HOSTED_PROTOCOL_INVALID');
  assert.match(unknown.result.message, /at submission\.observation\.state/);
  assert.match(unknown.result.message, /server, whose deploy has not reached it yet/);
  assert.match(unknown.result.message, /may have succeeded/);
  assert.match(
    unknown.result.message,
    /nforge agent '\/synthetic' landings '\{"url":"https:\/\/fixture\.invalid"/,
  );
});

test('a live page delivery drains from its value: one call per wake, not a second page read (686ecdde)', async () => {
  const s = await fixture(),
    a = await s.start(),
    b = await s.start();
  const waiting = s.wait({ operationIds: [a.request.operationId, b.request.operationId] });
  await turn();
  // Before the subscription: one drain per operation, then the register-then-reread drain.
  const reads = s.counts().reads;
  await s.update(a.state.id, 'checking');
  await s.deliver();
  await turn();
  await s.update(a.state.id, 'landed');
  await s.deliver();
  await turn();
  assert.equal(s.counts().reads, reads, 'delivered pages are drained without a page read');
  await s.update(b.state.id, 'landed');
  await s.deliver();
  const result = await waiting;
  assert.equal(result.result.status, 'terminal');
  assert.equal(result.result.successful, true);
  assert.equal(s.counts().reads, reads);
  // Every version is published once, as a read-driven drain publishes it.
  assert.deepEqual(
    s.events.filter(e => e.operationId === a.request.operationId).map(e => e.version),
    [0, 1, 2],
  );
  // A delivery older than the cursor (or a bare wake) falls back to the read.
  const stale = await s.start();
  const again = s.wait({ operationIds: [stale.request.operationId] });
  await turn();
  const before = s.counts().reads;
  s.wake();
  await turn();
  assert.equal(s.counts().reads, before + 1);
  await s.update(stale.state.id, 'landed');
  await s.deliver();
  assert.equal((await again).result.status, 'terminal');
});
