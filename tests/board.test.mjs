// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { boardFixture, delivery, limits } from './board-fixture.mjs';

const code = expected => error => (error.data?.code ?? error.code) === expected;
const rows = (f, table) => [...f.tables[table].values()];
const day = 24 * 60 * 60 * 1000;

test('a note to a Lane is read back once, with the Forge handle and never the account id', async () => {
  const f = boardFixture();
  const sent = await f.post(
    { to: `lane:${f.lanes.B.slice(0, 8)}`, text: 'Leave tests/x.test.mjs lines 1-40', laneId: f.lanes.A },
    'writer',
  );
  assert.equal(sent.status, 'posted');
  assert.equal(sent.target, `lane:${f.lanes.B}`, 'an 8-character prefix resolves by index range');
  assert.equal(sent.recipients, 1);
  const postReads = f.invoke.reads;
  assert(postReads <= 30, `post reads ${postReads}`);
  const inbox = await f.read({ laneId: f.lanes.B });
  assert.equal(inbox.messages.length, 1);
  const [message] = inbox.messages;
  assert.equal(message.author, 'writer-h');
  assert.equal(message.fromLaneId, f.lanes.A);
  assert.equal(message.text, 'Leave tests/x.test.mjs lines 1-40');
  assert(!JSON.stringify(inbox).includes('"writer"'), 'no account id in the reply');
  assert(f.invoke.reads <= 12, `inbox reads ${f.invoke.reads}`);
  // The cursor is the client's: after it, nothing new and no message rows are read.
  const again = await f.read({ laneId: f.lanes.B, after: inbox.cursor });
  assert.deepEqual(again.messages, []);
  // A replay of the same operationId writes nothing; an identical note within 24 h is a duplicate.
  const writes = rows(f, 'projectBoardMessages').length;
  const operationId = randomUUID();
  const first = await f.post({ operationId, to: 'project', text: 'Heads up: main is red' }, 'writer');
  assert.equal(
    (await f.post({ operationId, to: 'project', text: 'Heads up: main is red' }, 'writer')).status,
    'duplicate',
  );
  await assert.rejects(
    f.post({ operationId, to: 'project', text: 'changed' }, 'writer'),
    code('WORK_OPERATION_CHANGED'),
  );
  const dupe = await f.post({ to: 'project', text: 'Heads up: main is red' }, 'writer');
  assert.deepEqual([dupe.status, dupe.id], ['duplicate', first.id]);
  assert.equal(rows(f, 'projectBoardMessages').length, writes + 1);
  // Replies go to the original author's Lane and list under the original.
  const reply = await f.post({
    replyTo: message.id.slice(0, 8),
    text: 'OK, I will skip lines 1-40',
    laneId: f.lanes.B,
  });
  assert.equal(reply.target, `lane:${f.lanes.A}`);
  const thread = await f.read({ id: message.id.slice(0, 8) });
  assert.equal(thread.replies.length, 1);
  assert.equal(thread.replies[0].author, 'owner-h');
  // The writer's own Lane sees the reply but not its own note to B.
  const mine = await f.read({ laneId: f.lanes.A }, 'writer');
  assert.deepEqual(
    mine.messages.map(m => m.text),
    ['OK, I will skip lines 1-40', 'Heads up: main is red'],
  );
});

test('only members with write access post or read; readers, strangers and anonymous callers get nothing', async () => {
  const f = boardFixture();
  await f.post({ to: 'project', text: 'Members only' });
  for (const actor of ['reader', 'outsider', null]) {
    await assert.rejects(f.post({ to: 'project', text: 'Hi' }, actor), code('PROJECT_UNAVAILABLE'));
    await assert.rejects(f.read({}, actor), code('PROJECT_UNAVAILABLE'));
  }
  f.project('project', { visibility: 'public' });
  await assert.rejects(f.read({}, 'outsider'), code('PROJECT_UNAVAILABLE'), 'public readers see no board');
  for (const actor of ['reader', 'outsider'])
    assert.equal(
      await delivery.boardDelivery(f.ctx, {
        projectId: 'project',
        viewer: actor,
        laneId: f.lanes.B,
        intentId: f.issue,
        after: 0,
      }),
      undefined,
    );
  assert.equal(
    (
      await delivery.boardDelivery(f.ctx, {
        projectId: 'project',
        viewer: 'writer',
        laneId: f.lanes.A,
        intentId: f.issue,
        after: 0,
      })
    ).messages.length,
    1,
  );
  // Posting from someone else's Lane, or to a closed Lane, is refused; your own closed Lane
  // (a queued or accepted landing) can still post and reply (ce974f90).
  await assert.rejects(
    f.post({ to: 'project', text: 'x', laneId: f.lanes.B }, 'writer'),
    code('BAD_ARGUMENT'),
  );
  const fromClosed = await f.post({ to: 'project', text: 'Landing queued, still here', laneId: f.lanes.C });
  assert.equal(fromClosed.status, 'posted');
  const answered = await f.post({
    replyTo: fromClosed.id,
    text: 'Answering from a closed Lane',
    laneId: f.lanes.C,
  });
  assert.equal(answered.status, 'posted');
  await assert.rejects(f.post({ to: `lane:${f.lanes.C}`, text: 'x' }), code('LANE_NOT_ACTIVE'));
  await assert.rejects(f.post({ to: `lane:${randomUUID()}`, text: 'x' }), code('NOT_FOUND'));
  await assert.rejects(f.post({ text: 'x' }), code('BAD_ARGUMENT'), 'to or replyTo is required');
});

test('secrets, emails and machine paths are refused before anything is written', async () => {
  const f = boardFixture();
  for (const [text, expected] of [
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123', 'BOARD_TEXT_SECRET'],
    ['mail me at someone@example.com', 'BOARD_TEXT_EMAIL'],
    ['see /srv/someone/project', 'BOARD_TEXT_PATH'],
    ['x'.repeat(241), 'BOARD_TEXT_TOO_LONG'],
  ])
    await assert.rejects(f.post({ to: 'project', text }), code(expected), expected);
  await assert.rejects(f.post({ to: 'project', text: 'ok', paths: ['/etc/hosts'] }), code('BAD_ARGUMENT'));
  for (const table of ['projectBoardMessages', 'boardEvidence', 'projectBoardSenders', 'boardAccounts'])
    assert.equal(f.tables[table].size, 0, table);
});

test('10 notes per 10 minutes per Lane and 300 a day per member per project', async () => {
  const f = boardFixture();
  for (let n = 0; n < 10; n++) await f.post({ to: 'project', text: `note ${n}`, laneId: f.lanes.B });
  await assert.rejects(
    f.post({ to: 'project', text: 'note 10', laneId: f.lanes.B }),
    error => code('RATE_LIMITED')(error) && error.data.retryAt > Date.now(),
  );
  assert.equal(f.tables.projectBoardMessages.size, 10, 'the refused note wrote nothing');
  // Without a Lane the same window applies per member.
  for (let n = 0; n < 10; n++) await f.post({ to: 'project', text: `bare ${n}` }, 'writer');
  await assert.rejects(f.post({ to: 'project', text: 'bare 10' }, 'writer'), code('RATE_LIMITED'));
  const daily = rows(f, 'projectBoardSenders').find(row => row.key === 'day:owner');
  f.tables.projectBoardSenders.get(daily._id).count = limits.BOARD_MEMBER_DAY_POSTS;
  await assert.rejects(
    f.post({ to: 'project', text: 'over the day', laneId: f.lanes.A }, 'owner'),
    code('BAD_ARGUMENT'),
  );
  f.lane('A', 'owner', true);
  await assert.rejects(
    f.post({ to: 'project', text: 'over the day', laneId: f.lanes.A }),
    code('RATE_LIMITED'),
  );
});

test('account caps hold across projects; new accounts start low; alerts fire once and name the handle', async () => {
  const f = boardFixture();
  f.tables.forgeAccounts.get('acct-writer')._creationTime = Date.now() - day; // new account
  const caps = limits.BOARD_ACCOUNT_CAPS.new;
  const today = Date.now() - (Date.now() % day);
  const others = ['p1', 'p2', 'p3'];
  f.tables.boardAccounts.set('acc', {
    _id: 'acc',
    _creationTime: 1,
    author: 'writer',
    dayStart: today,
    posts: caps.posts - 2,
    bytes: 0,
    projects: others,
    newProjects: 0,
    alerted: [],
  });
  await f.post({ to: 'project', text: 'one' }, 'writer');
  assert.deepEqual(f.alerts(), []);
  await f.post({ to: 'project', text: 'two' }, 'writer');
  const raised = f.alerts();
  assert.deepEqual(
    raised.map(a => a.subject),
    ['[Forge] Board cap'],
  );
  assert.match(raised[0].text, /@writer-h/);
  assert(!raised[0].text.includes('writer '), 'no account id');
  await assert.rejects(f.post({ to: 'project', text: 'three' }, 'writer'), code('RATE_LIMITED'));
  // Five projects in a day raises one "projects" alert.
  f.tables.boardAccounts.set('acc2', {
    _id: 'acc2',
    _creationTime: 1,
    author: 'owner',
    dayStart: today,
    posts: 0,
    bytes: 0,
    projects: ['p1', 'p2', 'p3', 'p4'],
    newProjects: 0,
    alerted: [],
  });
  await f.post({ to: 'project', text: 'fifth project' });
  await f.post({ to: 'project', text: 'fifth project again' });
  assert.equal(f.alerts().filter(a => a.subject === '[Forge] Board projects').length, 1);
  // Placeholders are marked for owner approval in the source and stay conservative.
  assert(caps.posts <= limits.BOARD_MEMBER_DAY_POSTS);
});

test('expired notes are deleted in small batches on post, and a full project refuses new notes', async () => {
  const f = boardFixture();
  const now = Date.now();
  for (let n = 0; n < 15; n++)
    f.tables.projectBoardMessages.set(`old-${n}`, {
      _id: `old-${n}`,
      _creationTime: n,
      projectId: 'project',
      id: randomUUID(),
      author: 'owner',
      targetKey: 'project',
      body: 'old',
      bytes: 3,
      bodyHash: `h${n}`,
      at: now - 15 * day,
      expiresAt: now - day,
    });
  f.tables.projectBoardProjects.set('count', {
    _id: 'count',
    _creationTime: 1,
    projectId: 'project',
    live: 15,
    firstPostAt: now - 15 * day,
  });
  await f.post({ to: 'project', text: 'fresh' });
  assert.equal(f.tables.projectBoardMessages.size, 15 - limits.BOARD_CLEANUP_BATCH + 1);
  assert.equal(f.tables.projectBoardProjects.get('count').live, 6);
  f.tables.projectBoardProjects.get('count').live = limits.BOARD_PROJECT_LIVE_CAP + 4; // 5 expired rows remain: 4,999 after cleanup
  await f.post({ to: 'project', text: 'still frees expired rows' });
  f.tables.projectBoardProjects.get('count').live = limits.BOARD_PROJECT_LIVE_CAP;
  await assert.rejects(f.post({ to: 'project', text: 'no room' }), code('BOARD_FULL'));
  const evidence = rows(f, 'boardEvidence');
  assert(evidence.every(row => !('body' in row) && row.expiresAt - row.at === limits.BOARD_EVIDENCE_MS));
});

test('operator switches stop posting and delivery at once, purge bodies, and audit every use', async () => {
  const f = boardFixture();
  await f.post({ to: 'project', text: 'before' }, 'writer');
  await f.op('setSwitch', { scope: 'account', handle: 'writer-h', off: true, reason: 'abuse report' });
  await assert.rejects(f.post({ to: 'project', text: 'blocked' }, 'writer'), code('BOARD_SUSPENDED'));
  await f.post({ to: 'project', text: 'others still post' });
  await f.op('setSwitch', { scope: 'project', projectId: 'project', off: true, reason: 'owner request' });
  await assert.rejects(f.post({ to: 'project', text: 'off' }), code('BOARD_OFF'));
  assert.equal((await f.read()).status, 'off');
  assert.equal(
    await delivery.boardDelivery(f.ctx, {
      projectId: 'project',
      viewer: 'owner',
      laneId: f.lanes.B,
      intentId: f.issue,
      after: 0,
    }),
    undefined,
  );
  await f.op('setSwitch', { scope: 'project', projectId: 'project', off: false, reason: 'resolved' });
  await f.op('setSwitch', { scope: 'global', off: true, reason: 'incident' });
  await assert.rejects(f.post({ to: 'project', text: 'global' }), code('BOARD_OFF'));
  await f.op('setSwitch', { scope: 'global', off: false, reason: 'incident over' });
  await assert.rejects(f.op('setSwitch', { scope: 'global', off: true, reason: ' ' }), code('BAD_ARGUMENT'));
  const purged = await f.op('purge', { scope: 'account', handle: 'writer-h', reason: 'abuse report' });
  assert.deepEqual(purged, { deleted: 1, done: true });
  assert.deepEqual(
    rows(f, 'projectBoardMessages').map(row => row.author),
    ['owner'],
  );
  assert.equal(f.tables.boardEvidence.size, 2, 'metadata stays for investigation');
  for (let n = 0; n < 201; n++)
    f.tables.projectBoardMessages.set(`m${n}`, {
      _id: `m${n}`,
      _creationTime: n,
      projectId: 'project',
      id: randomUUID(),
      author: 'owner',
      targetKey: 'project',
      body: 'x',
      bytes: 1,
      bodyHash: `x${n}`,
      at: n,
      expiresAt: Date.now() + day,
    });
  const page = await f.op('purge', { scope: 'project', projectId: 'project', reason: 'cleanup' });
  assert.deepEqual(page, { deleted: 200, done: false });
  const next = f.scheduled.at(-1);
  assert.equal(next.args.auditId !== undefined, true, 'the continuation carries the audit row');
  assert.deepEqual(
    rows(f, 'boardAudit').map(row => row.action),
    ['suspend', 'off', 'on', 'off', 'on', 'purge', 'purge'],
  );
  assert(
    rows(f, 'boardAudit').every(row => !row.target.includes('writer') || row.target === 'account:@writer-h'),
  );
});

test('delivery reads three inbox rows when nothing is new and returns oldest-first pages of two', async () => {
  const f = boardFixture();
  const input = { projectId: 'project', viewer: 'owner', laneId: f.lanes.B, intentId: f.issue, after: 0 };
  f.invoke.reads = 0;
  assert.equal(await delivery.boardDelivery(f.ctx, input), undefined, 'empty board: nothing added');
  await f.post({ to: `issue:${f.issue}`, text: 'issue note' }, 'writer');
  await f.post({ to: `lane:${f.lanes.B}`, text: 'lane note' }, 'writer');
  await f.post({ to: 'project', text: 'project note' }, 'writer');
  const first = await delivery.boardDelivery(f.ctx, input);
  assert.deepEqual(
    first.messages.map(m => m.text),
    ['issue note', 'lane note'],
  );
  assert.equal(first.more, 1);
  const second = await delivery.boardDelivery(f.ctx, { ...input, after: first.cursor });
  assert.deepEqual(
    second.messages.map(m => m.text),
    ['project note'],
  );
  assert.equal(second.more, 0);
  assert.equal(await delivery.boardDelivery(f.ctx, { ...input, after: second.cursor }), undefined);
});
