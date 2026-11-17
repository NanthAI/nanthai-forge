// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardFixture, delivery } from './board-fixture.mjs';
import { boardHostedSource } from '../dist/hosted-board.js';
import { boardWakeEnvelope } from '../dist/hosted-board-wait.js';
import {
  readBoardCursor,
  readBoardConflictIds,
  writeBoardConflictIds,
  rememberBoardServerFeatures,
  unreadBoardNotes,
} from '../dist/board-local.js';
import { readHostedEditPeers } from '../dist/agent-edit-hosted.js';

const features = ['agent-board', 'board-lane-after', 'board-resolve'];
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-lane-cursor-'));
  const prior = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, 'state');
  t.after(() => {
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}.forge-client`, { recursive: true, force: true });
  });
  const f = boardFixture();
  rememberBoardServerFeatures('project', features);
  function note(targetKey, at, body) {
    const id = randomUUID();
    f.tables.projectBoardMessages.set(id, {
      _id: id,
      projectId: 'project',
      id,
      author: 'owner',
      targetKey,
      body,
      bodyHash: id,
      bytes: body.length,
      at,
      expiresAt: Date.now() + 86400000,
    });
    const previous = f.tables.projectBoardInboxes.get(targetKey);
    f.tables.projectBoardInboxes.set(targetKey, {
      _id: targetKey,
      projectId: 'project',
      key: targetKey,
      latestAt: at,
      count: (previous?.count ?? 0) + 1,
    });
  }
  async function directed(after) {
    const value = await delivery.boardWake(f.ctx, {
      projectId: 'project',
      viewer: 'writer',
      laneId: f.lanes.A,
      after,
    });
    assert(value?.messages.length, 'the wait delivers actual directed notes');
    boardWakeEnvelope(root, f.lanes.A, value);
    assert.equal(readBoardCursor(root, f.lanes.A), 0);
    return value.cursor;
  }
  return { f, root, note, directed };
}

test('70b38346 S1(a): delivered Lane notes cannot fill an ascending two-note hook page with an empty more hint', async t => {
  const { f, root, note, directed } = setup(t);
  note(`lane:${f.lanes.A}`, 5, 'Delivered first');
  note(`lane:${f.lanes.A}`, 6, 'Delivered second');
  await directed(0);
  note('project', 7, 'Unread project note');
  const target = {
    root,
    project: 'project',
    url: 'https://synthetic.invalid',
    laneId: f.lanes.A,
    path: 'src/file.ts',
  };
  let calls = 0;
  const result = await readHostedEditPeers(target, async (_name, args) => {
    calls++;
    return {
      board: await delivery.boardDelivery(f.ctx, {
        projectId: 'project',
        viewer: 'writer',
        laneId: f.lanes.A,
        intentId: f.issue,
        ...args.board,
      }),
    };
  });
  assert.equal(calls, 1);
  assert.equal(result.board.notices.length, 1);
  assert.match(result.board.notices[0], /Unread project note/);
});

test('70b38346 S1(b): ten-plus delivered Lane notes cannot hide older unread project and Issue notes on board reads', async t => {
  const { f, root, note, directed } = setup(t);
  note('project', 1, 'Unread project note');
  note(`issue:${f.issue}`, 2, 'Unread Issue note');
  for (let at = 3; at <= 14; at++) note(`lane:${f.lanes.A}`, at, `Delivered ${at}`);
  let after = 0;
  while (after < 14) after = await directed(after);
  await f.read({ laneId: f.lanes.A, after: 0 }, 'writer');
  const beforeReads = f.invoke.reads;
  const requests = [];
  const transport = {
    root,
    advertisedFeatures: features,
    query: async (_name, args) => {
      requests.push(args);
      return f.read(args, 'writer');
    },
  };
  const result = await boardHostedSource(transport, 'board', { laneId: f.lanes.A });
  assert.equal(requests.length, 1);
  assert.deepEqual(
    result.messages.map(message => message.target).sort(),
    ['project', `issue:${f.issue}`].sort(),
  );
  assert.equal(result.notices.length, 2);
  assert.equal(result.more, 0);
  assert(f.invoke.reads <= beforeReads, 'server filtering adds no reads');
  console.log(`laneAfter page: ${beforeReads} -> ${f.invoke.reads} index documents/probes`);
  const history = await boardHostedSource(transport, 'board', { laneId: f.lanes.A, all: true });
  assert(history.messages.some(message => message.target.startsWith('lane:')));
  assert.equal(requests.at(-1).laneAfter, undefined, 'explicit history ignores the directed watermark');
});

test('laneAfter is sent only to a server advertising its optional argument', async t => {
  const { f, root, note, directed } = setup(t);
  note(`lane:${f.lanes.A}`, 5, 'Delivered');
  await directed(0);
  const requests = [];
  const transport = {
    root,
    query: async (_name, args) => {
      requests.push(args);
      return { messages: [], more: 0, cursor: 0 };
    },
  };
  await boardHostedSource({ ...transport, advertisedFeatures: ['agent-board'] }, 'board', {
    laneId: f.lanes.A,
  });
  await boardHostedSource({ ...transport, advertisedFeatures: features }, 'board', { laneId: f.lanes.A });
  assert.equal(requests[0].laneAfter, undefined);
  assert.equal(requests[1].laneAfter, 5);
});

test('seen exact-notice identities retain the latest 64 per Lane and keep other Lanes independent', t => {
  const { root } = setup(t);
  const ids = Array.from({ length: 100 }, (_, n) => `notice-${n}`);
  writeBoardConflictIds(root, 'first', ids.slice(0, 60));
  writeBoardConflictIds(root, 'second', ['other']);
  writeBoardConflictIds(root, 'first', ids.slice(50));
  assert.deepEqual(readBoardConflictIds(root, 'first'), ids.slice(-64));
  assert.equal(
    JSON.parse(readFileSync(join(`${root}.forge-client`, 'board', 'first.conflicts.json'), 'utf8')).length,
    64,
  );
  assert.deepEqual(readBoardConflictIds(root, 'second'), ['other']);
});

test('a malformed directed watermark cannot hide unread Lane notes', async t => {
  const { f, root, note, directed } = setup(t);
  note(`lane:${f.lanes.A}`, 5, 'Delivered');
  await directed(0);
  const message = { id: randomUUID(), target: `lane:${f.lanes.A}`, text: 'Unread', at: 6 };
  for (const notesAfter of ['invalid', {}, null]) {
    writeFileSync(
      join(`${root}.forge-client`, 'board', `${f.lanes.A}.directed.json`),
      JSON.stringify({ after: 5, notesAfter }),
    );
    assert.deepEqual(unreadBoardNotes(root, [message]), [message]);
  }
});
