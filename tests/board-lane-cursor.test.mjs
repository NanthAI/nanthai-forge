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
  readBoardProjectCursor,
  readBoardConflictIds,
  writeBoardConflictIds,
  rememberBoardServerFeatures,
  unreadBoardNotes,
  rememberBoardReader,
} from '../dist/board-local.js';
import { printedReceipt } from '../dist/receipt-slim.js';
import { boardEnvelope } from '../dist/board-local.js';
import { hostedEditContext, readHostedEditPeers } from '../dist/agent-edit-hosted.js';

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
  function note(targetKey, at, body, fromLaneId) {
    const id = randomUUID();
    f.tables.projectBoardMessages.set(id, {
      _id: id,
      projectId: 'project',
      id,
      author: 'owner',
      targetKey,
      ...(fromLaneId ? { fromLaneId } : {}),
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

test('70b38346 line 1: project notes read in another Lane cannot hide an older unread Issue note on a fresh Lane', async t => {
  const { f, root, note } = setup(t);
  rememberBoardReader(root, 'project', 'writer');
  [...f.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === f.lanes.B).intentId =
    randomUUID();
  note(`issue:${f.issue}`, 1, 'Unread Issue note');
  for (let at = 2; at <= 11; at++) note('project', at, `Project note ${at}`);
  const transport = {
    root,
    advertisedFeatures: features,
    query: async (_name, args) => f.read(args, 'writer'),
  };
  const other = await boardHostedSource(transport, 'board', { laneId: f.lanes.B });
  assert.equal(other.notices.length, 10);
  assert.equal(readBoardCursor(root, f.lanes.A), 0);
  const fresh = await boardHostedSource(transport, 'board', { laneId: f.lanes.A });
  assert.equal(fresh.notices.length, 1);
  assert.match(fresh.notices[0], /Unread Issue note/);
});

test('70b38346: ordinary continuation reaches all eleven unread notes without dropping or repeating a page', async t => {
  const { f, root, note } = setup(t);
  rememberBoardReader(root, 'project', 'writer');
  for (let at = 1; at <= 11; at++) note('project', at, `Unread ${at}`);
  const transport = {
    root,
    advertisedFeatures: features,
    query: async (_name, args) => f.read(args, 'writer'),
  };
  const first = await boardHostedSource(transport, 'board', { laneId: f.lanes.A });
  assert.equal(first.notices.length, 10);
  assert.equal(first.more, 1);
  const next = await boardHostedSource(transport, 'board', { laneId: f.lanes.A });
  assert.equal(next.notices.length, 1);
  assert.equal(next.more, 0);
  assert.equal(new Set([...first.messages, ...next.messages].map(message => message.id)).size, 11);
});

test('70b38346 M1: an exact newer project-note read leaves every older unread note on the next ordinary page', async t => {
  const { f, root, note } = setup(t);
  rememberBoardReader(root, 'project', 'writer');
  for (let at = 1; at <= 4; at++) note('project', at, `Unread project note ${at}`);
  const newer = [...f.tables.projectBoardMessages.values()].find(row => row.at === 4);
  let calls = 0;
  const transport = {
    root,
    advertisedFeatures: features,
    query: async (_name, args) => {
      calls++;
      return f.read(args, 'writer');
    },
  };
  const exact = await boardHostedSource(transport, 'board', { id: newer.id });
  assert.equal(exact.message.text, 'Unread project note 4');
  const positions = [readBoardCursor(root, f.lanes.A), readBoardProjectCursor(root)];
  const ordinary = await boardHostedSource(transport, 'board', { laneId: f.lanes.A });
  assert.equal(ordinary.messages.length, 4, 'the server returned the whole unread page');
  assert.equal(ordinary.notices.length, 4, 'the exact read must not suppress older unread project notes');
  for (let at = 1; at <= 4; at++)
    assert(ordinary.notices.some(line => line.includes(`Unread project note ${at}`)));
  assert.deepEqual(positions, [0, 0], 'exact reads acknowledge neither ordinary nor project progress');
  assert.equal(calls, 2, 'one exact read and one ordinary page; no added calls');
});

test('70b38346 M1: reading newest history acknowledges neither Lane nor project unread positions', async t => {
  const { f, root, note } = setup(t);
  rememberBoardReader(root, 'project', 'writer');
  for (let at = 1; at <= 15; at++) note('project', at, `Unread ${at}`);
  const transport = {
    root,
    advertisedFeatures: features,
    query: async (_name, args) => f.read(args, 'writer'),
  };
  const history = await boardHostedSource(transport, 'board', { laneId: f.lanes.A, all: true });
  assert.deepEqual(
    history.messages.map(message => message.at),
    [15, 14, 13, 12, 11, 10, 9, 8, 7, 6],
  );
  assert.equal(readBoardCursor(root, f.lanes.A), 0);
  assert.equal(readBoardProjectCursor(root), 0);
  const unread = await boardHostedSource(transport, 'board', { laneId: f.lanes.A });
  assert.deepEqual(
    unread.messages.slice(0, 5).map(message => message.at),
    [1, 2, 3, 4, 5],
  );
  assert.equal(unread.notices.length, 10);
});

for (const kind of ['board', 'hook']) {
  test(`70b38346 L2: ${kind} excludes own notes before filling the unread page`, async t => {
    const { f, root, note } = setup(t);
    const own = kind === 'board' ? 11 : 3;
    for (let at = 1; at <= own; at++) note('project', at, `Own ${at}`, f.lanes.A);
    note('project', own + 1, 'Other unread', f.lanes.B);
    let calls = 0;
    const result =
      kind === 'board'
        ? await boardHostedSource(
            {
              root,
              advertisedFeatures: features,
              query: async (_name, args) => {
                calls++;
                return f.read(args, 'writer');
              },
            },
            'board',
            { laneId: f.lanes.A },
          )
        : (
            await readHostedEditPeers(
              {
                root,
                project: 'project',
                url: 'https://synthetic.invalid',
                laneId: f.lanes.A,
                path: 'src/file.ts',
              },
              async (_name, args) => {
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
              },
            )
          ).board;
    assert.equal(calls, 1);
    assert.equal(result.notices.length, 1);
    assert.match(result.notices[0], /Other unread/);
    assert.equal(readBoardCursor(root, f.lanes.A), own + 1);
  });
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

test('70b38346: a receipt continuation run from the project root retains its Lane and reaches the unread Issue note', async t => {
  const { f, root, note } = setup(t);
  for (let at = 1; at <= 3; at++) note(`issue:${f.issue}`, at, `Issue note ${at}`);
  const page = await delivery.boardDelivery(f.ctx, {
    projectId: 'project',
    viewer: 'writer',
    laneId: f.lanes.A,
    intentId: f.issue,
    after: 0,
  });
  const envelope = boardEnvelope(root, f.lanes.A, page);
  const command = JSON.parse(envelope.notices.at(-1).match(/board '([^']+)'/)[1]);
  assert.equal(command.laneId, f.lanes.A, 'start and save hints carry the originating Lane');
  let calls = 0;
  const read = await boardHostedSource(
    {
      root,
      advertisedFeatures: features,
      query: async (_name, args) => {
        calls++;
        return f.read(args, 'writer');
      },
    },
    'board',
    command,
  );
  assert.equal(read.messages.length, 1);
  assert.equal(read.messages[0].text, 'Issue note 3');
  assert.equal(read.more, 0);
  assert.equal(calls, 1, 'following the page hint uses one ordinary bounded read');
  t.diagnostic(
    `continuation: ${f.invoke.reads} fixture document probes, ${Buffer.byteLength(JSON.stringify(envelope))} envelope bytes`,
  );
});

test('70b38346: default lists and first-write claims keep a working exact-note continuation', async t => {
  const { f, root, note } = setup(t);
  f.tables.forgeAccounts.get('acct-owner').handle = 'a'.repeat(39);
  note('project', 1, '😀'.repeat(240), f.lanes.B);
  const row = [...f.tables.projectBoardMessages.values()][0];
  Object.assign(row, {
    agent: 'tranquil-antelope',
    replyTo: randomUUID(),
    resolvedAt: 2,
    resolvedBy: 'owner',
    resolvedAgent: 'tranquil-antelope',
    resolvedText: 'r'.repeat(240),
  });
  let calls = 0;
  const transport = {
    root,
    advertisedFeatures: features,
    query: async (_name, args) => {
      calls++;
      return f.read(args, 'writer');
    },
  };
  const listed = await boardHostedSource(transport, 'board', { laneId: f.lanes.A, all: true });
  const listReads = f.invoke.reads;
  const compact = printedReceipt(
    { action: 'board', transport: 'hosted', result: listed },
    { agent: true, detail: false, landChild: false },
  );
  assert.equal('messages' in compact.result, false, 'exercise the real default list projection');
  const command = JSON.parse(compact.result.notices[0].match(/Read: board (\{[^}]+\})/)[1]);
  assert.equal(command.id, row.id);
  const whole = await boardHostedSource(transport, 'board', command);
  const printed = printedReceipt(
    { action: 'board', transport: 'hosted', result: whole },
    { agent: true, detail: false, landChild: false },
  );
  assert.equal(printed.result.message.text, row.body);
  assert.equal(printed.result.message.resolved.text, row.resolvedText);
  assert.equal(calls, 2, 'one list page plus one explicitly requested continuation; no per-note reads');
  // A hook adds a path prefix to the same rendered notice. It must not clip its command.
  const writtenPath = `src/${'nested/'.repeat(40)}file.ts`;
  const hook = await readHostedEditPeers(
    {
      root,
      project: 'project',
      url: 'https://synthetic.invalid',
      laneId: f.lanes.A,
      path: writtenPath,
    },
    async (_name, args) => {
      calls++;
      assert.equal(args.path, writtenPath, 'shortening display text never changes the written path query');
      return {
        board: { messages: [], more: 0, cursor: 0, claims: [{ ...whole.message, resolved: undefined }] },
      };
    },
  );
  const context = hostedEditContext(hook);
  assert(context.includes(`Read: board {"id":"${row.id}"}`), context);
  assert(context.includes(`Reply: board --reply {"id":"${row.id.slice(0, 8)}"}`), context);
  assert(context.isWellFormed());
  assert.equal(calls, 3, 'the hook reuses its single existing query');
  t.diagnostic(
    `list: ${listReads} fixture document probes, ${Buffer.byteLength(JSON.stringify(compact))} default bytes; hook: ${Buffer.byteLength(context)} bytes`,
  );
});
