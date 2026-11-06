// SPDX-License-Identifier: Apache-2.0
// Board Lane 3 (Issue 9c8490a4): wait delivery, peer wait and first-write claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { boardFixture } from './board-fixture.mjs';
import { landingFixture } from './hosted-landing-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { observeHostedSubmissions } from '../dist/hosted-agent-submission-wait.js';
import {
  boardWakeTiming,
  boardWakeEnvelope,
  observePeerLane,
  readBoardWokeAt,
} from '../dist/hosted-board-wait.js';
import { readBoardCursor } from '../dist/hosted-board.js';
import { rememberBoardServerFeatures } from '../dist/hosted-board-wait.js';
import { readHostedEditPeers, hostedEditContext } from '../dist/agent-edit-hosted.js';

const peerWait = await import(moduleUrl('../convex/projectBoardWait.ts'));
const delivery = await import(moduleUrl('../convex/projectBoardDelivery.ts'));
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const turn = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const code = expected => error => (error.data?.code ?? error.code) === expected;

function peerFixture() {
  const f = boardFixture();
  for (const name of ['projectHostedPresence', 'projectFinishReadRows']) f.tables[name] ??= new Map();
  const peer = (args, actor = 'writer') =>
    f.invoke(peerWait.peer, 'projectBoardWait:peer', { projectId: 'project', ...args }, actor);
  const laneRow = key =>
    [...f.tables.projectHostedOverlapLanes.values()].find(r => r.laneId === f.lanes[key]);
  return { f, peer, laneRow };
}

test('peer wait (server): open, accepted, abandoned; handles only; write members only; bounded reads', async () => {
  const { f, peer, laneRow } = peerFixture();
  const open = await peer({ peer: f.lanes.B.slice(0, 8) });
  assert.deepEqual(open.peer, {
    laneId: f.lanes.B,
    intentId: f.issue,
    state: 'open',
    terminal: false,
    actor: 'owner-h',
  });
  assert(!JSON.stringify(open).includes('"owner"'), 'no account id');
  assert(f.invoke.reads <= 8, `peer reads ${f.invoke.reads}`);
  console.log(`peer wait run: ${f.invoke.reads} index reads`);
  // The peer's landing stamps its overlap row (existing write): the subscription re-runs to accepted.
  laneRow('B').landed = { receiptId: 'r1', commit: 'c1', laneHead: 'h', at: '2026-11-05T00:00:00.000Z' };
  const accepted = await peer({ peer: f.lanes.B });
  assert.equal(accepted.peer.state, 'accepted');
  assert.equal(accepted.peer.terminal, true);
  assert.equal(accepted.peer.commit, 'c1');
  // A stamp for an older head is not this head's landing.
  laneRow('B').head = 'h2';
  assert.equal((await peer({ peer: f.lanes.B })).peer.state, 'open');
  f.tables.projectHostedRecordHeads.get('head-B').status = 'abandoned';
  assert.equal((await peer({ peer: f.lanes.B })).peer.state, 'abandoned');
  await assert.rejects(peer({ peer: f.lanes.B }, 'reader'), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(peer({ peer: f.lanes.B }, 'outsider'), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(peer({ peer: 'ffffffff' }), code('NOT_FOUND'));
  await assert.rejects(peer({ peer: f.lanes.A, laneId: f.lanes.A }), code('BAD_ARGUMENT'));
});

test('peer wait (server): a note to my own Lane rides on the same query; Issue and project posts do not', async () => {
  const { f, peer } = peerFixture();
  f.tables.projectHostedPresence.set('p-A', {
    _id: 'p-A',
    projectId: 'project',
    laneId: f.lanes.A,
    intentId: f.issue,
    actor: 'writer',
    goal: '',
    paths: [],
    pathCount: 0,
    at: 0,
  });
  await f.post({ to: `issue:${f.issue}`, text: 'Issue-wide heads up', laneId: f.lanes.B });
  await f.post({ to: 'project', text: 'Project-wide heads up' });
  const quiet = await peer({ peer: f.lanes.B, laneId: f.lanes.A, after: 0 });
  assert.equal('board' in quiet, false, 'only the Lane inbox row is watched');
  await f.post({ to: `lane:${f.lanes.A}`, text: 'Landing in 5 min, then rebase on me', laneId: f.lanes.B });
  const woke = await peer({ peer: f.lanes.B, laneId: f.lanes.A, after: 0 });
  assert.equal(woke.board.messages.length, 2, 'the delivery is the full cursor-safe set, at most 2');
  assert(woke.board.more >= 1);
  assert(woke.board.messages.every(message => message.author === 'owner-h'));
});

test('wait delivery (server): the landing page subscription adds board only with the board arg', async () => {
  const f = await landingFixture();
  for (const name of [
    'projectBoardInboxes',
    'projectBoardMessages',
    'boardSwitches',
    'projectHostedPresence',
  ])
    f.tables[name] ??= new Map();
  const request = f.request();
  await f.enqueue(request);
  const args = { projectId: f.projectId, operationId: request.operationId, nextVersion: 0 };
  const plain = await f.call('page', observe.page, args, 'owner');
  const plainCost = f.counts.at(-1);
  const laneId = randomUUID();
  const withArg = await f.call('page', observe.page, { ...args, board: { laneId, after: 0 } }, 'owner');
  assert.equal(withArg, plain, 'no note: byte-identical page');
  const idle = f.counts.at(-1);
  // Watching the Lane inbox adds a few point reads per subscription run, no message rows.
  assert(idle.documents - plainCost.documents <= 3, JSON.stringify([plainCost, idle]));
  console.log(
    `wait subscription run, no note: +${idle.readBytes - plainCost.readBytes} B, +${idle.documents - plainCost.documents} docs`,
  );
  const id = randomUUID();
  f.tables.projectBoardInboxes.set('i1', {
    _id: 'i1',
    projectId: f.projectId,
    key: `lane:${laneId}`,
    latestAt: 7,
    count: 1,
  });
  f.tables.projectBoardMessages.set('m1', {
    _id: 'm1',
    _creationTime: 0,
    projectId: f.projectId,
    id,
    author: 'owner',
    targetKey: `lane:${laneId}`,
    body: 'Please wait for me',
    bytes: 18,
    bodyHash: 'h',
    at: 7,
    expiresAt: Date.now() + 86_400_000,
  });
  assert.equal(await f.call('page', observe.page, args, 'owner'), plain, 'no board arg: unchanged');
  const woke = JSON.parse(
    await f.call('page', observe.page, { ...args, board: { laneId, after: 0 } }, 'owner'),
  );
  const hot = f.counts.at(-1);
  console.log(
    `wait subscription run, note delivered: +${hot.readBytes - plainCost.readBytes} B, +${hot.documents - plainCost.documents} docs`,
  );
  assert.equal(woke.board.messages[0].text, 'Please wait for me');
  assert.equal(woke.board.cursor, 7);
  const { board: _board, ...page } = woke;
  assert.deepEqual(page, JSON.parse(plain), 'the page part is unchanged');
  const after = await f.call('page', observe.page, { ...args, board: { laneId, after: 7 } }, 'owner');
  assert.equal(after, plain, 'the cursor suppresses a repeat');
});

test('first-write claims (server): live notes naming the path, never my own', async () => {
  const f = boardFixture();
  await f.post({ to: 'project', text: 'Rewriting the root helper', paths: ['tests/x.test.mjs'] }, 'owner');
  await f.post({ to: 'project', text: 'Touching b.ts', paths: ['src/a/b.ts', 'src/c.ts'] }, 'owner');
  await f.post({ to: 'project', text: 'Mine', paths: ['tests/x.test.mjs'], laneId: f.lanes.A }, 'writer');
  const claims = path =>
    delivery.boardClaims(f.ctx, { projectId: 'project', laneId: f.lanes.A, path, now: Date.now() });
  assert.deepEqual(
    (await claims('tests/x.test.mjs')).map(c => c.text),
    ['Rewriting the root helper'],
  );
  assert.deepEqual(
    (await claims('src/a/b.ts')).map(c => c.text),
    ['Touching b.ts'],
  );
  assert.deepEqual(await claims('README.md'), []);
  // Claims read the project counter plus at most BOARD_CLAIM_SCAN newest notes.
  for (let i = 0; i < 30; i++)
    f.tables.projectBoardMessages.set(`bulk-${i}`, {
      _id: `bulk-${i}`,
      _creationTime: i,
      projectId: 'project',
      id: randomUUID(),
      author: 'owner',
      targetKey: 'project',
      body: `note ${i}`,
      bytes: 6,
      bodyHash: `b${i}`,
      at: Date.now() + i,
      expiresAt: Date.now() + 86_400_000 + i,
    });
  let rows = 0;
  const query = f.ctx.db.query;
  f.ctx.db.query = (...args) => {
    const q = query(...args);
    const take = q.take;
    q.take = async n => {
      const result = await take(n);
      rows += result.length;
      return result;
    };
    return q;
  };
  try {
    await claims('tests/x.test.mjs');
  } finally {
    f.ctx.db.query = query;
  }
  assert(rows <= delivery.BOARD_CLAIM_SCAN, `claim rows ${rows}`);
  console.log(`first-write claims: ${rows} note rows scanned`);
});

/** A pure client fixture: capability read + one page subscription; counts every query. */
async function waitFixture(features) {
  const f = await landingFixture();
  const request = f.request();
  await f.enqueue(request);
  let queries = 0,
    opens = 0,
    closes = 0;
  const subscriptions = [];
  const transport = {
    root: '/synthetic',
    address: { url: 'https://fixture.invalid', projectId: f.projectId },
    async dispatch() {
      return {
        schema: 1,
        transport: 'hosted',
        action: 'capabilities',
        operationId: null,
        result: { actor: 'owner', ...(features ? { features } : {}) },
      };
    },
    async query(name, args) {
      queries++;
      assert.equal(name, 'projectHostedFinishObserve:page');
      return JSON.parse(await f.call('page', observe.page, { ...args, projectId: f.projectId }, 'owner'));
    },
  };
  const subscribe = () => {
    opens++;
    return {
      onUpdate(ref, args, next) {
        subscriptions.push({ name: getFunctionName(ref), args, next });
        return () => {};
      },
      async close() {
        closes++;
      },
    };
  };
  const page = () =>
    f.call(
      'page',
      observe.page,
      { projectId: f.projectId, operationId: request.operationId, nextVersion: 0 },
      'owner',
    );
  return {
    f,
    request,
    transport,
    subscribe,
    subscriptions,
    page,
    counts: () => ({ queries, opens, closes }),
  };
}

test('a wait without board args is byte-identical to today (no option, or a server without board-wait)', async () => {
  const w = await waitFixture(undefined);
  const run = board =>
    observeHostedSubmissions(
      w.transport,
      { operationIds: [w.request.operationId], timeoutSeconds: 0.05 },
      undefined,
      () => {},
      w.subscribe,
      board,
    );
  const base = await run(undefined);
  // Same landing, now a server that has the board but not board-wait, and a Lane checkout.
  const dispatch = w.transport.dispatch;
  w.transport.dispatch = async () => {
    const value = await dispatch();
    return { ...value, result: { ...value.result, features: ['agent-board'] } };
  };
  const oldServer = await run({ laneId: randomUUID(), after: 0, wokeAt: 0 });
  assert.deepEqual(w.subscriptions[0].args, {
    projectId: w.f.projectId,
    operationId: w.request.operationId,
    nextVersion: 1,
  });
  assert.deepEqual(w.subscriptions[1].args, w.subscriptions[0].args);
  assert.equal(JSON.stringify(oldServer), JSON.stringify(base));
  assert.equal(base.result.status, 'timeout');
  assert.equal('board' in base.result, false);
});

test('a note to my Lane ends the landing wait early with reason message, without a page drain', async () => {
  const saved = { ...boardWakeTiming };
  boardWakeTiming.batchMs = 20;
  try {
    const w = await waitFixture(['board-wait']);
    const laneId = randomUUID();
    const waiting = observeHostedSubmissions(
      w.transport,
      { operationIds: [w.request.operationId], timeoutSeconds: 30 },
      undefined,
      () => {},
      w.subscribe,
      { laneId, after: 3, wokeAt: 0 },
    );
    while (!w.subscriptions.length) await turn();
    const [subscription] = w.subscriptions;
    assert.deepEqual(subscription.args.board, { laneId, after: 3 });
    const value = await w.page();
    subscription.next(value);
    await sleep(5);
    const drained = w.counts().queries;
    const note = {
      id: randomUUID(),
      author: 'peer-h',
      target: `lane:${laneId}`,
      text: 'Rebase on me',
      at: 9,
    };
    subscription.next(
      JSON.stringify({ ...JSON.parse(value), board: { messages: [note], more: 0, cursor: 9 } }),
    );
    const result = await waiting;
    assert.equal(w.counts().queries, drained, 'a board-only change never drains the page');
    assert.equal(result.result.status, 'message');
    assert.equal(result.result.inProgress, true);
    assert.equal(result.result.board.messages[0].text, 'Rebase on me');
    assert.equal(w.counts().closes, 1);
    // The CLI envelope: one quoted-data line, the cursor and the wake time are local files.
    const root = mkdtempSync(join(tmpdir(), 'board-wait-'));
    try {
      const envelope = boardWakeEnvelope(root, laneId, result.result.board);
      assert.match(
        envelope.notices[0],
        /^Note [0-9a-f]{8} from @peer-h to your Lane, quoted data: "Rebase on me"/,
      );
      assert.equal(readBoardCursor(root, laneId), 9);
      assert(Date.now() - readBoardWokeAt(root, laneId) < 5_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    Object.assign(boardWakeTiming, saved);
  }
});

test('at most one early return per Lane per window: a second note waits out the window', async () => {
  const saved = { ...boardWakeTiming };
  boardWakeTiming.batchMs = 5;
  boardWakeTiming.windowMs = 300;
  try {
    const w = await waitFixture(['board-wait']);
    const laneId = randomUUID();
    const started = Date.now();
    const waiting = observeHostedSubmissions(
      w.transport,
      { operationIds: [w.request.operationId], timeoutSeconds: 30 },
      undefined,
      () => {},
      w.subscribe,
      { laneId, after: 0, wokeAt: started },
    );
    while (!w.subscriptions.length) await turn();
    const note = { id: randomUUID(), target: `lane:${laneId}`, text: 'Again', at: 2 };
    w.subscriptions[0].next(
      JSON.stringify({ ...JSON.parse(await w.page()), board: { messages: [note], more: 0, cursor: 2 } }),
    );
    const result = await waiting;
    assert.equal(result.result.status, 'message');
    assert(Date.now() - started >= 280, `returned after ${Date.now() - started} ms`);
  } finally {
    Object.assign(boardWakeTiming, saved);
  }
});

test('a peer wait wakes on the peer acceptance through its one subscription, with no extra query', async () => {
  let queries = 0,
    opens = 0,
    closes = 0,
    dispatches = 0;
  const subscriptions = [];
  const transport = {
    root: '/synthetic',
    address: { url: 'https://fixture.invalid', projectId: 'p1' },
    async dispatch(action) {
      dispatches++;
      assert.equal(action, 'capabilities');
      return { result: { actor: 'me', features: ['board-wait'] } };
    },
    async query() {
      queries++;
      throw new Error('no query while waiting');
    },
  };
  const subscribe = () => {
    opens++;
    return {
      onUpdate(ref, args, next) {
        subscriptions.push({ name: getFunctionName(ref), args, next });
        return () => {};
      },
      async close() {
        closes++;
      },
    };
  };
  const peer = randomUUID();
  const waiting = observePeerLane(
    transport,
    { peer: peer.slice(0, 8), timeoutSeconds: 30 },
    undefined,
    undefined,
    subscribe,
  );
  while (!subscriptions.length) await turn();
  assert.equal(subscriptions[0].name, 'projectBoardWait:peer');
  assert.deepEqual(subscriptions[0].args, { projectId: 'p1', peer: peer.slice(0, 8) });
  subscriptions[0].next(JSON.stringify({ peer: { laneId: peer, state: 'open', terminal: false } }));
  await turn();
  subscriptions[0].next(
    JSON.stringify({
      peer: { laneId: peer, state: 'accepted', terminal: true, receiptId: 'r', commit: 'c', actor: 'peer-h' },
    }),
  );
  const outcome = await waiting;
  assert.equal(outcome.status, 'terminal');
  assert.equal(outcome.peer.state, 'accepted');
  assert.deepEqual(
    { queries, opens, closes, dispatches },
    { queries: 0, opens: 1, closes: 1, dispatches: 1 },
  );
  // An older server without board-wait refuses before subscribing.
  const old = { ...transport, dispatch: async () => ({ result: { actor: 'me', features: [] } }) };
  await assert.rejects(
    observePeerLane(old, { peer, timeoutSeconds: 1 }, undefined, undefined, subscribe),
    code('HOSTED_ACTION_UNSUPPORTED'),
  );
  assert.equal(opens, 1);
});

test('first-write hook: claims and unread notes ride on its one query, once the server has the board', async () => {
  const state = mkdtempSync(join(tmpdir(), 'board-hook-state-'));
  const root = mkdtempSync(join(tmpdir(), 'board-hook-root-'));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  try {
    const laneId = randomUUID();
    const target = { root, laneId, path: 'tests/x.test.mjs', project: 'p1', url: 'https://fixture.invalid' };
    const calls = [];
    const evidence = {
      count: 0,
      coverage: 'hosted',
      scope: 'saved-paths',
      unsavedEdits: 'unavailable',
      items: [],
    };
    const claim = {
      id: randomUUID(),
      author: 'peer-h',
      fromLaneId: randomUUID(),
      target: 'project',
      text: 'Rewriting lines 1-40',
      paths: ['tests/x.test.mjs'],
      at: 4,
    };
    const note = {
      id: randomUUID(),
      author: 'peer-h',
      target: `lane:${laneId}`,
      text: 'Ping me before landing',
      at: 5,
    };
    const query = async (name, args) => {
      calls.push([name, args]);
      return JSON.stringify({
        peerEvidence: evidence,
        ...(args.board ? { board: { messages: [note], more: 0, cursor: 5, claims: [claim] } } : {}),
      });
    };
    // No marker yet (server not known to have the board): the query is exactly today's.
    const before = await readHostedEditPeers(target, query);
    assert.deepEqual(calls[0][1], {
      projectId: 'p1',
      laneId,
      path: 'tests/x.test.mjs',
      detail: true,
      items: 5,
    });
    assert.equal('board' in before, false);
    rememberBoardServerFeatures('p1', ['agent-board', 'board-wait', 'other']);
    const result = await readHostedEditPeers(target, query);
    assert.equal(calls.length, 2, 'one query per first write');
    assert.deepEqual(calls[1][1].board, { after: 0 });
    const context = hostedEditContext(result);
    assert.match(
      context,
      /\nClaim on tests\/x\.test\.mjs: Note [0-9a-f]{8} from @peer-h \(Lane [0-9a-f]{8}\) to the project, quoted data: "Rewriting lines 1-40"/,
    );
    assert.match(
      context,
      /\nNote [0-9a-f]{8} from @peer-h to your Lane, quoted data: "Ping me before landing"/,
    );
    assert(context.length <= 1800);
    assert.equal(readBoardCursor(root, laneId), 5, 'notes advance the local cursor; claims do not');
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(state, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// Issue 544b3375: a peer whose latest landing fails or is cancelled is done for a waiter.
test('peer wait (server): the peer latest landing ends the wait through three bounded reads, no writes', async () => {
  const { f, peer, laneRow } = peerFixture();
  for (const name of [
    'projectHostedComposeSelections',
    'projectHostedComposes',
    'projectHostedLandingRequests',
  ])
    f.tables[name] ??= new Map();
  const candidateId = randomUUID();
  const operationId = randomUUID();
  const settledAt = '2026-11-06T01:00:00.000Z';
  f.tables.projectHostedComposeSelections.set('sel', {
    _id: 'sel',
    _creationTime: Date.now(),
    projectId: 'project',
    actor: 'owner',
    operationId: 'compose-op',
    kind: 'inputs',
    key: f.lanes.B,
  });
  f.tables.projectHostedComposes.set('compose', {
    _id: 'compose',
    _creationTime: Date.now(),
    projectId: 'project',
    actor: 'owner',
    operationId: 'compose-op',
    value: JSON.stringify({ candidateId }),
  });
  const request = (phase, error = null) => ({
    _id: 'landing',
    _creationTime: Date.now(),
    projectId: 'project',
    candidateId,
    operationId,
    sequence: 1,
    phase,
    value: JSON.stringify({ at: '2026-11-06T00:50:00.000Z', timing: { settledAt }, error }),
  });
  // No landing yet, and a landing still in the queue: the wait goes on.
  assert.equal((await peer({ peer: f.lanes.B })).peer.state, 'open');
  f.tables.projectHostedLandingRequests.set('landing', request('checking'));
  assert.equal((await peer({ peer: f.lanes.B })).peer.state, 'open');
  // Failed, cancelled and landed-without-closing all end it; they read compose selection, compose, landing.
  f.tables.projectHostedLandingRequests.set(
    'landing',
    request('terminal-failed', { code: 'CHECK_NOT_PASSED' }),
  );
  const failed = await peer({ peer: f.lanes.B });
  assert.equal(f.invoke.reads, 10, `peer reads with a landing ${f.invoke.reads}`);
  assert.equal(failed.peer.state, 'failed');
  assert.equal(failed.peer.terminal, true);
  assert.deepEqual(failed.peer.landing, {
    operationId,
    phase: 'terminal-failed',
    code: 'CHECK_NOT_PASSED',
  });
  f.tables.projectHostedLandingRequests.set(
    'landing',
    request('terminal-failed', { code: 'LANDING_CANCELLED' }),
  );
  assert.equal((await peer({ peer: f.lanes.B })).peer.state, 'cancelled');
  f.tables.projectHostedLandingRequests.set('landing', request('landed'));
  assert.equal((await peer({ peer: f.lanes.B })).peer.state, 'accepted');
  // The peer saved again after the failure: it is working, so the old failure no longer counts.
  f.tables.projectHostedLandingRequests.set(
    'landing',
    request('terminal-failed', { code: 'CHECK_NOT_PASSED' }),
  );
  laneRow('B').presenceRow = { id: 'p', at: Date.parse(settledAt) + 1000 };
  assert.equal((await peer({ peer: f.lanes.B })).peer.state, 'open');
  laneRow('B').presenceRow = { id: 'p', at: Date.parse(settledAt) - 1000 };
  assert.equal((await peer({ peer: f.lanes.B })).peer.state, 'failed');
  // A closed Lane never reads the landing at all.
  laneRow('B').open = false;
  assert.equal((await peer({ peer: f.lanes.B })).peer.state, 'closed');
  assert(f.invoke.reads <= 7, `closed peer reads ${f.invoke.reads}`);
});
