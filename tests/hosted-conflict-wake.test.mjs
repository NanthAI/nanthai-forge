// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { landingFixture } from './hosted-landing-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { observeHostedSubmissions } from '../dist/hosted-agent-submission-wait.js';
import { boardWakeEnvelope, boardWakeTiming, readBoardWokeAt } from '../dist/hosted-board-wait.js';
import { readBoardCursor, readBoardWaitCursor } from '../dist/board-local.js';
const conflicts = await import(moduleUrl('../convex/projectHostedConflicts.ts'));
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));

async function fixture(selectedLaneId) {
  const f = await landingFixture();
  const laneId = selectedLaneId ?? randomUUID(),
    peerId = randomUUID();
  for (const [id, head] of [
    [laneId, 'mine'],
    [peerId, 'peer'],
  ])
    f.insert('projectHostedOverlapLanes', {
      projectId: f.projectId,
      laneId: id,
      intentId: randomUUID(),
      actor: 'owner',
      intent: 'Synthetic change',
      head,
      baseHead: 'base',
      baseReceiptId: 'base',
      baseSequence: 0,
      recordVersion: 0,
      open: true,
      changes: '[]',
      complete: true,
    });
  const request = f.request();
  await f.enqueue(request);
  const args = { projectId: f.projectId, operationId: request.operationId, nextVersion: 0 };
  const page = (after = 0) =>
    f.call('observerBudgetPage', observe.page, { ...args, board: { laneId, after } });
  const record = (overrides = {}) =>
    f.call('trialRecord', conflicts.record, {
      projectId: f.projectId,
      laneId,
      head: 'mine',
      peers: [{ laneId: peerId, head: 'peer' }],
      conflicts: [{ peer: peerId, path: 'src/service.ts', mine: [[2, 2]], theirs: [[3, 3]], reason: 'text' }],
      ...overrides,
    });
  return { f, laneId, peerId, request, args, page, record };
}

test('83e6d0d3: a notice recorded during a landing wait wakes its existing subscription without a page drain', async t => {
  const w = await fixture(),
    subscriptions = [];
  const root = mkdtempSync(join(tmpdir(), 'forge-conflict-wake-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}.forge-client`, { recursive: true, force: true });
  });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const timing = { ...boardWakeTiming };
  boardWakeTiming.batchMs = 0;
  t.after(() => Object.assign(boardWakeTiming, timing));
  let queries = 0,
    closes = 0;
  const transport = {
    root,
    address: { url: 'https://synthetic.invalid', projectId: w.f.projectId },
    async dispatch() {
      return { result: { actor: 'owner', features: ['board-wait'] } };
    },
    async query(name, args) {
      queries++;
      assert.equal(name, 'projectHostedFinishObserve:page');
      return JSON.parse(await w.f.call('page', observe.page, { projectId: w.f.projectId, ...args }));
    },
  };
  let subscribed;
  const ready = new Promise(resolve => {
    subscribed = resolve;
  });
  const subscribe = () => ({
    onUpdate(ref, args, next) {
      assert.equal(getFunctionName(ref), 'projectHostedFinishObserve:page');
      subscriptions.push({ args, next });
      subscribed();
      return () => {};
    },
    async close() {
      closes++;
    },
  });
  const waiting = observeHostedSubmissions(
    transport,
    { operationIds: [w.request.operationId], timeoutSeconds: 30 },
    controller.signal,
    () => {},
    subscribe,
    { laneId: w.laneId, after: 0, wokeAt: Date.now() },
  );
  await ready;
  const [subscription] = subscriptions;
  subscription.next(await w.page());
  // Capture the exact reactive read set, including the currently absent Lane inbox.
  await w.page();
  const unchanged = w.f.readSet();
  assert.equal(unchanged(), true);
  await w.record();
  assert.equal(unchanged(), false, 'notice publication invalidates the existing wait dependency');
  const page = JSON.parse(await w.page());
  assert.equal(page.board.conflicts[0].with, w.peerId);
  const queryCount = queries;
  subscription.next(JSON.stringify(page));
  const result = await waiting;
  assert.equal(result.result.status, 'message');
  assert.equal(result.result.inProgress, true, 'advice never cancels or fences the landing');
  assert.equal(queries, queryCount, 'notice-only delivery adds no page drain');
  assert.equal(subscriptions.length, 1);
  assert.equal(closes, 1);
  const envelope = boardWakeEnvelope(root, w.laneId, result.result.board);
  assert.equal(envelope.conflictNotice.items[0].file, 'src/service.ts');
  assert.equal(envelope.conflictNotice.items[0].lines, '2');
  assert.equal(readBoardWokeAt(root, w.laneId), 0, 'a source notice adds no member-note cooldown');
  assert.equal(readBoardWaitCursor(root, w.laneId), page.board.cursor);
  assert.equal(readBoardCursor(root, w.laneId), 0);
  assert.equal(JSON.parse(await w.page(page.board.cursor)).board, undefined, 'cursor suppresses replay');
  const inboxes = structuredClone([...w.f.tables.projectBoardInboxes.values()]);
  await w.record();
  assert.deepEqual([...w.f.tables.projectBoardInboxes.values()], inboxes);
  assert.equal(w.f.counts.at(-1).writes, 0, 'a retried record does not wake again');
});

test('83e6d0d3: a healthy trial leaves wait bytes and reactive dependencies unchanged', async () => {
  const w = await fixture();
  const before = await w.page(),
    unchanged = w.f.readSet();
  await w.record({ conflicts: [] });
  assert.equal(unchanged(), true);
  assert.equal(await w.page(), before);
  assert.equal(w.f.tables.projectBoardInboxes.size, 0);
});

test('83e6d0d3: source conflicts survive board switches and a project-note cursor, while stale heads do not wake', async () => {
  const w = await fixture();
  const prior = Date.now() + 1000;
  w.f.insert('projectBoardProjects', {
    projectId: w.f.projectId,
    live: 0,
    firstPostAt: prior,
    lastAt: prior,
  });
  w.f.insert('boardSwitches', { key: 'global', off: true, at: prior });
  await w.record();
  const page = JSON.parse(await w.page(prior));
  assert.equal(page.board.conflicts[0].with, w.peerId);
  assert(page.board.cursor > prior);
  const mine = [...w.f.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === w.laneId);
  w.f.patch('projectHostedOverlapLanes', mine._id, { head: 'new-head' });
  assert.equal(JSON.parse(await w.page(prior)).board, undefined);
});

for (const kind of ['operation', 'run']) {
  test(`83e6d0d3: a real ${kind}-wait CLI reply wakes from the existing Lane inbox without another call`, async t => {
    const { agentFixture } = await import('./hosted-agent-fixture.mjs');
    const { hostedAgentCli } = await import('../dist/hosted-agent-cli.js');
    const { observationWaitHooks } = await import('../dist/hosted-agent-observe.js');
    const { boardWake } = await import(moduleUrl('../convex/projectBoardDelivery.ts'));
    const s = agentFixture(t);
    await s.transport().dispatch('open', { laneId: s.lane.laneId });
    const w = await fixture(s.lane.laneId);
    const timing = { ...boardWakeTiming },
      previousExit = process.exitCode;
    boardWakeTiming.batchMs = 0;
    const subscriptions = [];
    let calls = 0,
      closes = 0;
    const runId = randomUUID();
    const run = { id: runId, projectId: w.f.projectId, status: 'running' };
    const transport = {
      root: s.root,
      address: { url: 'https://synthetic.invalid', projectId: w.f.projectId },
      advertisedFeatures: ['board-wait', 'run-board-wait'],
      async dispatch(action) {
        calls++;
        return {
          schema: 1,
          transport: 'hosted',
          action,
          operationId: null,
          resolved: null,
          result:
            action === 'capabilities' ? { actor: 'owner', features: ['board-wait', 'run-board-wait'] } : run,
        };
      },
      async query(name, args) {
        calls++;
        assert.equal(name, 'projectHostedFinishObserve:page');
        return JSON.parse(await w.f.call('page', observe.page, { projectId: w.f.projectId, ...args }));
      },
    };
    observationWaitHooks.subscribe = () => ({
      onUpdate(ref, args, next) {
        subscriptions.push({ name: getFunctionName(ref), args, next });
        return () => {};
      },
      async close() {
        closes++;
      },
    });
    t.after(() => {
      observationWaitHooks.subscribe = undefined;
      Object.assign(boardWakeTiming, timing);
      process.exitCode = previousExit;
    });
    const selection =
      kind === 'run' ? { runId } : { operationIds: [w.request.operationId], until: 'acceptance' };
    const waiting = hostedAgentCli(
      s.root,
      'wait',
      { ...selection, timeoutSeconds: 30 },
      transport.address,
      transport,
    );
    for (let i = 0; i < 200 && !subscriptions.length; i++)
      await new Promise(resolve => setImmediate(resolve));
    assert.equal(subscriptions.length, 1);
    const subscription = subscriptions[0];
    assert.equal(
      subscription.name,
      kind === 'run' ? 'projectHostedCheckRead:status' : 'projectHostedFinishObserve:page',
    );
    assert.equal(
      kind === 'run' ? subscription.args.board?.laneId : subscription.args.board?.laneId,
      w.laneId,
    );
    await w.record();
    const delivery =
      kind === 'run'
        ? {
            ...run,
            board: await w.f.call(
              'wake',
              {
                _handler: ctx =>
                  boardWake(ctx, {
                    projectId: w.f.projectId,
                    viewer: 'owner',
                    laneId: w.laneId,
                    after: 0,
                  }),
              },
              {},
            ),
          }
        : JSON.parse(await w.page());
    const callCount = calls;
    subscription.next(JSON.stringify(delivery));
    const reply = await waiting;
    assert.equal(reply.conflictNotice?.items[0].with, w.peerId);
    assert.equal(reply.result.status, 'IN_PROGRESS');
    assert.equal(reply.result.reason, 'message');
    assert.equal(
      reply.result.next[kind === 'run' ? 'runId' : 'until'],
      kind === 'run' ? runId : 'acceptance',
    );
    assert.equal(calls, callCount, 'a notice-only wake does not drain a page or read again');
    assert.equal(closes, 1);
  });
}

test('83e6d0d3: the existing run status query watches the inbox, revalidates the head and current access', async () => {
  const { read } = await import('./hosted-checks-fixture.mjs');
  const w = await fixture();
  const run = await w.f.rawChecks.enqueue(w.f.rawChecks.selection());
  const input = {
    projectId: w.f.projectId,
    runId: run.id,
    features: ['check-report-detail'],
    board: { laneId: w.laneId, after: 0 },
  };
  const page = () => w.f.call('observerBudgetPage', read.status, input);
  await page();
  const unchanged = w.f.readSet();
  await w.record();
  assert.equal(unchanged(), false, 'record invalidates the existing run status dependency');
  const value = JSON.parse(await page());
  assert.equal(value.board.conflicts[0].with, w.peerId);
  const mine = [...w.f.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === w.laneId);
  w.f.patch('projectHostedOverlapLanes', mine._id, { head: 'moved' });
  assert.equal(JSON.parse(await page()).board, undefined);
  await assert.rejects(
    w.f.rawChecks.call('runStatusOtherViewer', read.status, input, 'other'),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
});

for (const [action, kind] of [
  ['save', 'Saves'],
  ['sync', 'Sync'],
  ['compose', 'Compose'],
]) {
  test(`83e6d0d3: the CLI wakes a retained ${action} operation on its own progress subscription`, async t => {
    const { agentFixture } = await import('./hosted-agent-fixture.mjs');
    const { HostedAgentJournal } = await import('../dist/hosted-agent-journal.js');
    const { hostedAgentCli } = await import('../dist/hosted-agent-cli.js');
    const { observationWaitHooks } = await import('../dist/hosted-agent-observe.js');
    const { boardWake } = await import(moduleUrl('../convex/projectBoardDelivery.ts'));
    const s = agentFixture(t);
    await s.transport().dispatch('open', { laneId: s.lane.laneId });
    const w = await fixture(s.lane.laneId),
      operationId = randomUUID();
    const address = { url: 'https://synthetic.invalid', projectId: w.f.projectId };
    new HostedAgentJournal(s.root, address, 'owner', action, { laneId: s.lane.laneId }, operationId);
    const timing = { ...boardWakeTiming },
      exit = process.exitCode;
    boardWakeTiming.batchMs = 0;
    const subscriptions = [];
    let calls = 0;
    observationWaitHooks.subscribe = () => ({
      onUpdate(ref, args, next) {
        subscriptions.push({ name: getFunctionName(ref), args, next });
        return () => {};
      },
      async close() {},
    });
    t.after(() => {
      observationWaitHooks.subscribe = undefined;
      Object.assign(boardWakeTiming, timing);
      process.exitCode = exit;
    });
    const transport = {
      root: s.root,
      address,
      advertisedFeatures: ['source-board-wait'],
      async dispatch() {
        calls++;
        return {
          schema: 1,
          transport: 'hosted',
          action,
          operationId,
          resolved: null,
          result: { status: 'submitted', jobId: 'synthetic' },
        };
      },
    };
    const waiting = hostedAgentCli(
      s.root,
      'wait',
      { operationIds: [operationId], timeoutSeconds: 30 },
      address,
      transport,
    );
    for (let i = 0; i < 200 && !subscriptions.length; i++)
      await new Promise(resolve => setImmediate(resolve));
    assert.equal(subscriptions.length, 1);
    assert.equal(subscriptions[0].name, `projectHosted${kind}:progress`);
    assert.equal(subscriptions[0].args.board?.laneId, w.laneId);
    await w.record();
    const board = await w.f.call(
      'wake',
      {
        _handler: ctx =>
          boardWake(ctx, { projectId: w.f.projectId, viewer: 'owner', laneId: w.laneId, after: 0 }),
      },
      {},
    );
    subscriptions[0].next(JSON.stringify({ status: 'submitted', jobId: 'synthetic', board }));
    const reply = await waiting;
    assert.equal(reply.conflictNotice.items[0].with, w.peerId);
    assert.equal(reply.result.status, 'IN_PROGRESS');
    assert.equal(reply.result.reason, 'message');
    assert.deepEqual(reply.result.next.operationIds, [operationId]);
    assert.equal(calls, 1, 'the notice wakes without replaying the operation or adding a query');
  });
}

test('83e6d0d3: a retained exact conflict rides the real land reply without gating admission', async t => {
  const { agentFixture } = await import('./hosted-agent-fixture.mjs');
  const { hostedAgentCli } = await import('../dist/hosted-agent-cli.js');
  const s = agentFixture(t),
    transport = s.transport();
  await transport.dispatch('open', { laneId: s.lane.laneId });
  const w = await fixture(s.lane.laneId);
  await w.record();
  s.caps.overlapVersion = 1;
  const query = transport.query.bind(transport);
  transport.query = async (name, args) => {
    if (name !== 'projectHostedOverlaps:read') return query(name, args);
    return {
      behindMain: { commits: 0, conflictingPaths: [], more: 0, coverage: 'hosted' },
      conflicts: await w.f.call(
        'notices',
        { _handler: ctx => conflicts.laneConflicts(ctx, w.f.projectId, w.laneId, 'mine') },
        {},
      ),
    };
  };
  const exit = process.exitCode;
  t.after(() => {
    process.exitCode = exit;
  });
  const reply = await hostedAgentCli(
    s.root,
    'finish',
    { laneId: s.lane.laneId, accept: false },
    s.address,
    transport,
  );
  assert.equal(reply.conflictNotice.items[0].with, w.peerId);
  assert.equal(reply.result.phase, 'check');
  assert.equal(
    s.calls.filter(call => call.name === 'projectHostedChecks:enqueue').length,
    1,
    'peer advice does not fence admission',
  );
});

test('83e6d0d3: head revalidation withdraws a stale conflict before the existing batching timer returns it', async t => {
  const { boardWaker } = await import('../dist/hosted-board-wait.js');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const delivered = [];
  const waker = boardWaker({ laneId: randomUUID(), after: 0, wokeAt: 0 }, value => delivered.push(value));
  waker.offer({
    board: {
      messages: [],
      more: 0,
      cursor: 1,
      conflicts: [
        {
          with: 'peer',
          goal: 'Synthetic',
          flaggedAt: new Date().toISOString(),
          files: [{ path: 'src/service.ts', mine: [[1, 1]], theirs: [[1, 1]], reason: 'text' }],
        },
      ],
    },
  });
  waker.offer({});
  t.mock.timers.tick(boardWakeTiming.batchMs);
  assert.deepEqual(delivered, []);
  waker.stop();
});

test('9829778c: reconnecting a wait never redelivers an exact notice behind older board pages', async t => {
  const { boardWaker, boardWaitOption } = await import('../dist/hosted-board-wait.js');
  const { rememberBoardReader, writeBoardProjectCursor } = await import('../dist/board-local.js');
  const root = mkdtempSync(join(tmpdir(), 'forge-wait-reconnect-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}.forge-client`, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const laneId = randomUUID();
  const conflict = {
    with: randomUUID(),
    goal: 'Synthetic peer',
    flaggedAt: new Date().toISOString(),
    files: [{ path: 'src/shared.ts', mine: [[1, 1]], theirs: [[1, 1]], reason: 'text' }],
  };
  const board = { messages: [], more: 4, cursor: 2, conflicts: [conflict] };
  const first = boardWakeEnvelope(root, laneId, board);
  assert.equal(first.noticeIds.length, 1);
  assert.equal(first.cursor, 2, 'the message page stays before the conflict clock');
  rememberBoardReader(root, 'synthetic-project', 'synthetic-actor');
  writeBoardProjectCursor(root, 50);
  const delivered = [];
  const option = boardWaitOption(root, laneId);
  const waker = boardWaker(option, value => delivered.push(value));
  t.after(() => waker.stop());
  // A project note already read in another Lane used to yield an empty message wake.
  waker.offer({
    board: {
      ...board,
      cursor: 4,
      messages: [{ id: randomUUID(), target: 'project', text: 'Already read elsewhere', at: 4 }],
    },
  });
  t.mock.timers.tick(120000);
  assert.deepEqual(delivered, [], 'stale conflict plus already-read note cannot interrupt checking');
  waker.offer({
    board: {
      ...board,
      cursor: 5,
      messages: [{ id: randomUUID(), target: `lane:${randomUUID()}`, text: 'For another Lane', at: 5 }],
    },
  });
  t.mock.timers.tick(120000);
  assert.deepEqual(delivered, [], 'another Lane message never interrupts this wait');
  const changed = { ...conflict, files: [{ ...conflict.files[0], mine: [[2, 2]] }] };
  waker.offer({ board: { ...board, cursor: 6, conflicts: [changed] } });
  t.mock.timers.tick(boardWakeTiming.batchMs);
  assert.equal(delivered.length, 1, 'new exact ranges interrupt once');
  assert.notDeepEqual(boardWakeEnvelope(root, laneId, delivered[0]).noticeIds, first.noticeIds);
});

for (const moved of ['peer', 'mine', 'ranges']) {
  test(`11c07518: a revised ${moved} conflict wakes once through the real projection behind an older note page`, async t => {
    const { boardWaitOption, freshBoardDelivery } = await import('../dist/hosted-board-wait.js');
    const w = await fixture();
    const root = mkdtempSync(join(tmpdir(), 'forge-conflict-identity-'));
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(`${root}.forge-client`, { recursive: true, force: true });
    });
    await w.record();
    const read = () =>
      w.f.call(
        'notices',
        {
          _handler: ctx => conflicts.laneConflicts(ctx, w.f.projectId, w.laneId),
        },
        {},
      );
    const first = { messages: [], more: 4, cursor: 2, conflicts: await read() };
    const envelope = boardWakeEnvelope(
      root,
      w.laneId,
      freshBoardDelivery(boardWaitOption(root, w.laneId), { board: first }),
    );
    const option = boardWaitOption(root, w.laneId);
    assert.equal(freshBoardDelivery(option, { board: first }), undefined);
    const overrides =
      moved === 'peer'
        ? { peers: [{ laneId: w.peerId, head: 'peer-v2' }] }
        : moved === 'mine'
          ? { head: 'mine-v2' }
          : {
              conflicts: [
                { peer: w.peerId, path: 'src/service.ts', mine: [[4, 4]], theirs: [[3, 3]], reason: 'text' },
              ],
            };
    if (moved !== 'ranges') {
      const laneId = moved === 'peer' ? w.peerId : w.laneId;
      const lane = [...w.f.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === laneId);
      w.f.patch('projectHostedOverlapLanes', lane._id, { head: moved === 'peer' ? 'peer-v2' : 'mine-v2' });
    }
    await w.record(overrides);
    const revised = { ...first, conflicts: await read() };
    assert.equal(revised.conflicts[0].flaggedAt, first.conflicts[0].flaggedAt);
    const fresh = freshBoardDelivery(option, { board: revised });
    assert.ok(fresh, 'a new exact source pair or changed ranges must remain observable');
    const next = boardWakeEnvelope(root, w.laneId, fresh);
    assert.notDeepEqual(next.noticeIds, envelope.noticeIds);
    await w.record(overrides);
    assert.equal(
      freshBoardDelivery(boardWaitOption(root, w.laneId), {
        board: { ...revised, conflicts: await read() },
      }),
      undefined,
      'retrying the same exact pair behind an old page never wakes again',
    );
  });
}

test('70b38346: a conflict-only wake leaves earlier project and Issue notes unread', async t => {
  const { boardInbox } = await import(moduleUrl('../convex/projectBoardDelivery.ts'));
  const { boardEnvelope } = await import('../dist/board-local.js');
  const w = await fixture();
  const root = mkdtempSync(join(tmpdir(), 'forge-conflict-unread-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}.forge-client`, { recursive: true, force: true });
  });
  for (const [targetKey, at] of [
    ['issue:synthetic-issue', 1],
    ['project', 2],
  ]) {
    w.f.insert('projectBoardMessages', {
      projectId: w.f.projectId,
      id: randomUUID(),
      author: 'owner',
      targetKey,
      body: `Unread ${targetKey}`,
      bytes: 16,
      bodyHash: targetKey,
      at,
      expiresAt: Date.now() + 60000,
    });
    w.f.insert('projectBoardInboxes', { projectId: w.f.projectId, key: targetKey, latestAt: at, count: 1 });
  }
  await w.record();
  const page = JSON.parse(await w.page());
  assert.equal(page.board.messages.length, 0);
  const { generation: _generation, ...old } = page.board.conflicts[0];
  const delta =
    Buffer.byteLength(JSON.stringify(page.board.conflicts[0])) - Buffer.byteLength(JSON.stringify(old));
  assert(delta <= 32, `notice generation adds ${delta} reply bytes`);
  t.diagnostic(`conflict reply delta ${delta} bytes; generation is projected from existing notice rows`);
  boardWakeEnvelope(root, w.laneId, page.board);
  const unread = await w.f.call(
    'ordinaryInbox',
    {
      _handler: ctx =>
        boardInbox(ctx, {
          projectId: w.f.projectId,
          laneId: w.laneId,
          intentId: 'synthetic-issue',
          after: readBoardCursor(root, w.laneId),
          limit: 2,
          order: 'asc',
        }),
    },
    {},
  );
  assert.deepEqual(
    unread.messages.map(message => message.target),
    ['issue:synthetic-issue', 'project'],
  );
  assert.equal(boardEnvelope(root, w.laneId, unread).notices.length, 2);
});
