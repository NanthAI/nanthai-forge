// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { batchesFixture, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import {
  boardWaitOption,
  boardWaker,
  boardWakeEnvelope,
  boardWakeTiming,
  freshBoardDelivery,
} from '../dist/hosted-board-wait.js';
import { readBoardCursor } from '../dist/board-local.js';

const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const conflicts = await import(moduleUrl('../convex/projectHostedConflicts.ts'));
const delivery = await import(moduleUrl('../convex/projectBoardDelivery.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const requestRow = (f, id) =>
  [...f.tables.projectHostedLandingRequests.values()].find(row => row.submissionId === id);
const runOwner = (f, run) =>
  [...f.tables.projectHostedLandingAttempts.values()].find(
    row => JSON.parse(row.value).check?.runId === run.id,
  )?.submissionId;

async function parkedFollower(t) {
  const f = await batchesFixture(t, { count: 2, batching: false, requestCheck: true });
  const [holder, follower] = f.entries;
  for (let tick = 0; tick < 400; tick++) {
    if (requestRow(f, follower.state.id)?.orderWait === holder.state.id) return { f, holder, follower };
    for (const run of f.runs().filter(run => run.status === 'queued'))
      if (runOwner(f, run) !== holder.state.id) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    const task = f.pending()[0];
    assert(task, 'the queue must reach a real parked follower');
    await f.execute(task);
  }
  assert.fail('the follower never parked');
}

async function exerciseParkedNotice(t, startHolder) {
  const { f, holder, follower } = await parkedFollower(t);
  const laneId = follower.lane.laneId;
  const root = mkdtempSync(join(tmpdir(), 'forge-parked-board-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}.forge-client`, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const parked = requestRow(f, follower.state.id);
  assert.equal(parked.runnable, false);
  const delivered = [];
  const waker = boardWaker(boardWaitOption(root, laneId), value => delivered.push(value));
  t.after(() => waker.stop());
  const page = async () =>
    JSON.parse(
      await f.tx('parkedBoardPage', observe.page, {
        projectId: f.projectId,
        operationId: follower.state.operationId,
        nextVersion: 0,
        board: { laneId, after: boardWaitOption(root, laneId).after },
      }),
    );
  if (startHolder) {
    const run = f.runs().find(run => run.status === 'queued' && runOwner(f, run) === holder.state.id);
    assert(run, 'the holder has a reserved new check that has not started');
    const running = await f.rawChecks.activate(run.id);
    assert.equal(running.status, 'running');
    assert.equal(requestRow(f, follower.state.id).orderWait, holder.state.id);
  }
  waker.offer(await page());
  t.mock.timers.tick(boardWakeTiming.batchMs);
  assert.deepEqual(delivered, [], 'holder progress alone never becomes an early board wake');

  for (const name of [
    'projectBoardInboxes',
    'projectBoardMessages',
    'projectBoardProjects',
    'boardSwitches',
    'projectHostedOverlapLanes',
    'projectHostedConflictNotices',
  ])
    f.tables[name] ??= new Map();
  for (const entry of [holder, follower]) {
    if (![...f.tables.projectHostedOverlapLanes.values()].some(row => row.laneId === entry.lane.laneId))
      f.insert('projectHostedOverlapLanes', {
        projectId: f.projectId,
        laneId: entry.lane.laneId,
        intentId: f.c.intentId,
        actor: 'owner',
        intent: 'Synthetic change',
        head: entry.lane.head,
        baseHead: f.c.baseline.sha256,
        baseReceiptId: 'main-0',
        baseSequence: 0,
        recordVersion: 0,
        open: true,
        pathSummary: { paths: [], pathCount: 0 },
        complete: true,
      });
  }
  for (const [targetKey, at] of [
    ['project', 1],
    [`issue:${f.c.intentId}`, 2],
  ]) {
    f.insert('projectBoardMessages', {
      projectId: f.projectId,
      id: randomUUID(),
      author: 'owner',
      targetKey,
      body: 'Unread note',
      bytes: 11,
      bodyHash: targetKey,
      at,
      expiresAt: Date.now() + 86400000,
    });
    f.insert('projectBoardInboxes', { projectId: f.projectId, key: targetKey, latestAt: at, count: 1 });
  }
  const alarm = structuredClone(requestRow(f, follower.state.id).alarm ?? null);
  const tasks = structuredClone(f.pending());
  await f.transaction('parkedConflictRecord', conflicts.record, {
    projectId: f.projectId,
    laneId,
    head: follower.lane.head,
    peers: [{ laneId: holder.lane.laneId, head: holder.lane.head }],
    conflicts: [
      { peer: holder.lane.laneId, path: 'src/shared.ts', mine: [[1, 1]], theirs: [[1, 1]], reason: 'text' },
    ],
  });
  const notice = await page();
  waker.offer(notice);
  t.mock.timers.tick(boardWakeTiming.batchMs);
  assert.equal(
    delivered.length,
    1,
    'the exact notice wakes the parked follower through its existing subscription',
  );
  boardWakeEnvelope(root, laneId, delivered[0]);
  assert.equal(readBoardCursor(root, laneId), 0, 'a parked notice cannot acknowledge project or Issue notes');
  assert.equal(
    freshBoardDelivery(boardWaitOption(root, laneId), { board: { ...notice.board, cursor: 1, more: 1 } }),
    undefined,
    'an older page never redelivers the same generation',
  );
  assert.deepEqual(f.pending(), tasks, 'board delivery creates no alarm or landing wake');
  assert.equal(requestRow(f, follower.state.id).orderWait, holder.state.id);
  assert.deepEqual(requestRow(f, follower.state.id).alarm ?? null, alarm);
  const unread = await f.transaction(
    'parkedOrdinaryInbox',
    {
      _handler: ctx =>
        delivery.boardInbox(ctx, {
          projectId: f.projectId,
          laneId,
          intentId: f.c.intentId,
          after: readBoardCursor(root, laneId),
          limit: 2,
          order: 'asc',
        }),
    },
    {},
  );
  assert.deepEqual(
    unread.messages.map(message => message.target),
    ['project', `issue:${f.c.intentId}`],
  );
}

test('holder starts a new check while followers are parked: board notice wakes once without acknowledging other inboxes', async t => {
  await exerciseParkedNotice(t, true);
});

test('a parked entry with no alarm: exact notice delivery needs no scheduler work and preserves unread notes', async t => {
  await exerciseParkedNotice(t, false);
});
