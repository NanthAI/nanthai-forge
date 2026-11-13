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
import { readBoardCursor } from '../dist/hosted-board.js';
const conflicts = await import(moduleUrl('../convex/projectHostedConflicts.ts'));
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));

async function fixture() {
  const f = await landingFixture();
  const laneId = randomUUID(),
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
  assert.equal(readBoardCursor(root, w.laneId), page.board.cursor);
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
