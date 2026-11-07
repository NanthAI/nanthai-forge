// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { landingFixture, api, store } from './hosted-landing-fixture.mjs';
import { boardTextProblem } from '../dist/board-text.js';
import { stackNoticeId, stackNoticeText, STACK_NOTICE_FANOUT } from '../dist/hosted-stack-notice.js';

const tracking = await import(moduleUrl('../convex/projectHostedOverlapStore.ts'));
const stackNotice = await import(moduleUrl('../convex/projectHostedStackNotice.ts'));
const system = await import(moduleUrl('../convex/projectBoardSystem.ts'));
const delivery = await import(moduleUrl('../convex/projectBoardDelivery.ts'));

const hash = char => char.repeat(64);
const touched = ['projectHostedStackDependents', 'projectBoardMessages', 'projectBoardInboxes'];

/** One project, an Intent, and Lane records written through the real overlap tracker. Every query and
 * write is counted by table so a test can state what a Lane without a stack is allowed to touch. */
function fixture() {
  const s = state([]);
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: Date.now() - 86_400_000,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  const intentId = randomUUID();
  const calls = [];
  const tableOf = id => Object.keys(s.tables).find(name => s.tables[name].has(id)) ?? id;
  const { query, insert, patch, replace } = s.ctx.db;
  s.ctx.db.query = table => {
    calls.push(`read:${table}`);
    return query(table);
  };
  s.ctx.db.insert = (table, row) => {
    calls.push(`write:${table}`);
    return insert(table, row);
  };
  s.ctx.db.patch = (id, values) => {
    calls.push(`write:${tableOf(id)}`);
    return patch(id, values);
  };
  s.ctx.db.replace = (id, values) => {
    calls.push(`write:${tableOf(id)}`);
    return replace(id, values);
  };
  let version = new Map();
  const record = (id, extra = {}) => ({
    kind: 'lane',
    id,
    intentId,
    actor: 'owner',
    version: version.get(id) ?? 0,
    at: new Date().toISOString(),
    base: { head: hash('b'), receiptId: 'receipt-0' },
    head: hash('1'),
    state: 'active',
    ...extra,
  });
  /** Write one Lane record; versions advance per Lane like the hosted record chain. */
  const write = async (id, extra = {}) => {
    const next = { ...record(id, extra), version: version.has(id) ? version.get(id) + 1 : 0 };
    version.set(id, next.version);
    await s.transaction(() =>
      tracking.trackHostedOverlapLane(s.ctx, 'project', next, { baseSequence: 0, intent: id.slice(0, 8) }),
    );
    return next;
  };
  const run = fn => s.transaction(() => fn(s.ctx));
  const inbox = async (laneId, after = 0) =>
    (await delivery.boardInbox(s.ctx, { projectId: 'project', laneId, after, limit: 10, order: 'asc' }))
      .messages;
  return { s, calls, write, run, inbox, intentId, record };
}

const stackOn = (parent, head) => ({ stack: { laneId: parent, head } });

test('a parent save tells its dependent once, with the restack command, and wakes a wait', async () => {
  const f = fixture();
  const parent = randomUUID(),
    child = randomUUID();
  await f.write(parent, { head: hash('1') });
  await f.write(child, { head: hash('1'), ...stackOn(parent, hash('1')) });
  assert.deepEqual(await f.inbox(child), [], 'starting the stack tells nobody');
  const cursor = Date.now() - 1;

  await f.write(parent, { head: hash('2') });
  const [note, ...rest] = await f.inbox(child);
  assert.equal(rest.length, 0);
  assert.equal(note.fromLaneId, parent);
  assert.match(
    note.text,
    /^Stack: parent Lane \w{8} saved new work \(head 22222222\)\. Your next save restacks onto it if clean; now: /,
  );
  assert.ok(note.text.includes(`nforge agent . sync '{"laneId":"${child}"}'`));
  assert.equal(boardTextProblem(note.text), null);
  assert.ok(note.text.length <= 240);

  // The note rides the child's own inbox row, which is all a blocked wait watches.
  const wake = await delivery.boardWake(f.s.ctx, {
    projectId: 'project',
    viewer: 'owner',
    laneId: child,
    after: cursor,
  });
  assert.equal(wake.messages.length, 1);
  assert.equal(wake.messages[0].id, note.id);

  // Further saves before a restack add nothing: the restack command takes the newest head.
  await f.write(parent, { head: hash('3') });
  await f.write(parent, { head: hash('4') });
  assert.equal((await f.inbox(child)).length, 1);

  // A restack (the child pins the new parent head) arms the next save.
  await f.write(child, { head: hash('5'), ...stackOn(parent, hash('4')) });
  await f.write(parent, { head: hash('6') });
  assert.equal((await f.inbox(child)).length, 2);
  // Saving a head the child is already on is not an event.
  await f.write(child, { head: hash('7'), ...stackOn(parent, hash('6')) });
  await f.write(parent, { head: hash('6') });
  assert.equal((await f.inbox(child)).length, 2);
});

test('an abandoned parent tells its dependent once, with the unstack command', async () => {
  const f = fixture();
  const parent = randomUUID(),
    child = randomUUID();
  await f.write(parent);
  await f.write(child, stackOn(parent, hash('1')));
  await f.write(parent, { state: 'abandoned' });
  const [note, ...rest] = await f.inbox(child);
  assert.equal(rest.length, 0);
  assert.match(note.text, /^Stack: parent Lane \w{8} was abandoned\. Unstack onto main: /);
  assert.ok(note.text.includes(`"laneId":"${child}","ontoMain":true`));
  assert.equal(boardTextProblem(note.text), null);
  // A later record of the closed parent (no state change) repeats nothing.
  await f.write(parent, { state: 'abandoned' });
  assert.equal((await f.inbox(child)).length, 1);
  // Unstacking drops the dependency: the child's row goes and the parent is silent for it.
  await f.write(child, { stack: { laneId: parent, head: hash('1'), detached: true } });
  assert.equal([...f.s.tables.projectHostedStackDependents.values()].length, 0);
});

test('a failed or cancelled landing tells the dependents of the Lane it carried, once', async () => {
  const f = fixture();
  const parent = randomUUID(),
    child = randomUUID(),
    sibling = randomUUID();
  await f.write(parent);
  await f.write(child, stackOn(parent, hash('1')));
  await f.write(sibling, stackOn(parent, hash('1')));
  const compose = randomUUID();
  await f.s.ctx.db.insert('projectHostedComposeSelections', {
    projectId: 'project',
    actor: 'owner',
    operationId: compose,
    kind: 'inputs',
    key: parent,
  });
  const ended = (operationId, code) =>
    f.run(ctx =>
      stackNotice.notifyStackedLandingEnded(ctx, {
        projectId: 'project',
        actor: 'owner',
        composeOperationId: compose,
        operationId,
        code,
      }),
    );
  assert.equal(await ended(randomUUID(), 'CHECK_FAILED'), 2);
  for (const lane of [child, sibling]) {
    const [note, ...rest] = await f.inbox(lane);
    assert.equal(rest.length, 0);
    assert.match(note.text, /landing failed \(CHECK_FAILED\)\. Unstack onto main: nforge agent \. sync/);
    assert.ok(note.text.includes('"ontoMain":true') && note.text.includes('restack after its fix'));
    assert.equal(boardTextProblem(note.text), null);
    assert.ok(note.text.length <= 240);
  }
  // The same condition announced again (a retry that fails the same way) is not a new event.
  assert.equal(await ended(randomUUID(), 'CHECK_FAILED'), 0);
  // A parent save re-arms it; a cancellation then reads as cancelled.
  await f.write(parent, { head: hash('2') });
  await f.write(child, { head: hash('3'), ...stackOn(parent, hash('2')) });
  assert.equal(await ended(randomUUID(), 'LANDING_CANCELLED'), 2, 'the parent save re-armed both dependents');
  const notes = await f.inbox(child);
  assert.match(notes.at(-1).text, /landing was cancelled \(LANDING_CANCELLED\)/);
  // No composition id (an older request) and no selection both cost nothing.
  assert.equal(
    await f.run(ctx =>
      stackNotice.notifyStackedLandingEnded(ctx, {
        projectId: 'project',
        actor: 'owner',
        composeOperationId: undefined,
        operationId: randomUUID(),
      }),
    ),
    0,
  );
});

test('an abandonment cancels the parent landing without a second notice', async () => {
  const f = fixture();
  const parent = randomUUID(),
    child = randomUUID(),
    compose = randomUUID();
  await f.write(parent);
  await f.write(child, stackOn(parent, hash('1')));
  await f.s.ctx.db.insert('projectHostedComposeSelections', {
    projectId: 'project',
    actor: 'owner',
    operationId: compose,
    kind: 'inputs',
    key: parent,
  });
  await f.write(parent, { state: 'abandoned' });
  await f.run(ctx =>
    stackNotice.notifyStackedLandingEnded(ctx, {
      projectId: 'project',
      actor: 'owner',
      composeOperationId: compose,
      operationId: randomUUID(),
      code: 'LANDING_CANCELLED',
    }),
  );
  const notes = await f.inbox(child);
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /was abandoned/);
});

test('a two-deep chain is told level by level, oldest to newest', async () => {
  const f = fixture();
  const [oldest, middle, newest] = [randomUUID(), randomUUID(), randomUUID()];
  await f.write(oldest);
  await f.write(middle, { head: hash('1'), ...stackOn(oldest, hash('1')) });
  await f.write(newest, { head: hash('1'), ...stackOn(middle, hash('1')) });

  await f.write(oldest, { head: hash('2') });
  assert.equal((await f.inbox(middle)).length, 1, 'the direct dependent is told');
  assert.equal((await f.inbox(newest)).length, 0, 'the grandchild waits for its own parent to change');

  // The middle Lane restacks onto the oldest: that is a save of the middle Lane, which tells the newest.
  await f.write(middle, { head: hash('3'), ...stackOn(oldest, hash('2')) });
  const [note] = await f.inbox(newest);
  assert.match(note.text, /^Stack: parent Lane \w{8} saved new work \(head 33333333\)/);
  assert.equal(note.fromLaneId, middle);
  assert.equal((await f.inbox(middle)).length, 1, 'the middle Lane is not told twice');

  // The oldest Lane's abandonment reaches only its direct dependent too.
  await f.write(oldest, { state: 'abandoned' });
  assert.equal((await f.inbox(middle)).length, 2);
  assert.equal((await f.inbox(newest)).length, 1);
});

test('Lanes without a stack read and write nothing new on save, abandon and landing failure', async () => {
  const f = fixture();
  const lane = randomUUID();
  await f.write(lane);
  f.calls.length = 0;
  await f.write(lane, { head: hash('2') });
  await f.write(lane, { state: 'abandoned' });
  const extra = f.calls.filter(call => touched.some(table => call.endsWith(table)) || /Board/.test(call));
  assert.deepEqual(extra, [], 'no dependents lookup, no board access');
  // A Lane that is only a parent keeps the same bill until it is stacked on.
  const parent = randomUUID(),
    child = randomUUID();
  await f.write(parent);
  f.calls.length = 0;
  await f.write(parent, { head: hash('2') });
  assert.deepEqual(
    f.calls.filter(call => call.endsWith('projectHostedStackDependents')),
    [],
  );
  await f.write(child, stackOn(parent, hash('2')));
  f.calls.length = 0;
  await f.write(parent, { head: hash('3') });
  assert.ok(f.calls.includes('read:projectHostedStackDependents'), 'once stacked, the parent looks it up');
});

test('fan-out is bounded to direct dependents and the note id repeats nothing', async () => {
  const f = fixture();
  const parent = randomUUID();
  await f.write(parent);
  const children = [];
  for (let i = 0; i < STACK_NOTICE_FANOUT + 3; i++) {
    children.push(randomUUID());
    await f.write(children[i], stackOn(parent, hash('1')));
  }
  await f.write(parent, { head: hash('2') });
  const told = (await Promise.all(children.map(child => f.inbox(child)))).filter(list => list.length).length;
  assert.equal(told, STACK_NOTICE_FANOUT);
  // A replay of the same event id writes no second note.
  const id = stackNoticeId(children[0], parent, `saved:${hash('2')}`);
  const again = await f.run(ctx =>
    system.postSystemLaneNote(ctx, {
      projectId: 'project',
      id,
      toLaneId: children[0],
      fromLaneId: parent,
      author: 'owner',
      text: stackNoticeText({ kind: 'saved', head: hash('2') }, parent, children[0]),
    }),
  );
  assert.equal(again, 'duplicate');
  assert.equal((await f.inbox(children[0])).length, 1);
});

test('the note respects the board switches and stays inside the text rules', async () => {
  const f = fixture();
  const parent = randomUUID(),
    child = randomUUID();
  f.s.tables.boardSwitches.set('off', { _id: 'off', key: 'project:project', off: true, at: 1 });
  await f.write(parent);
  await f.write(child, stackOn(parent, hash('1')));
  await f.write(parent, { head: hash('2') });
  assert.deepEqual(await f.inbox(child), [], 'a stopped board gets no system note either');
  for (const event of [
    { kind: 'saved', head: hash('a') },
    { kind: 'abandoned', key: '1' },
    { kind: 'landing', outcome: 'failed', operationId: randomUUID(), code: 'X'.repeat(80) },
    { kind: 'landing', outcome: 'cancelled', operationId: randomUUID(), code: 'LANDING_CANCELLED' },
  ]) {
    const text = stackNoticeText(event, randomUUID(), randomUUID());
    assert.equal(boardTextProblem(text), null, text);
    assert.ok(text.length <= 240, `${text.length}: ${text}`);
  }
});

test('writeLanding announces a cancelled landing of a stacked Lane through the real cancel path', async () => {
  const f = await landingFixture();
  // The fixture's landing request has no composition id; give it one the way a finish does.
  const parent = randomUUID(),
    child = randomUUID(),
    compose = randomUUID(),
    request = f.request();
  // Seed Lanes and a dependent directly: the landing fixture has no overlap tracking of its own.
  f.tables.projectHostedOverlapLanes ??= new Map();
  const lane = (laneId, extra = {}) =>
    f.insert('projectHostedOverlapLanes', {
      projectId: f.projectId,
      laneId,
      intentId: randomUUID(),
      actor: 'owner',
      intent: 'x',
      head: hash('1'),
      baseHead: hash('b'),
      baseReceiptId: 'r',
      baseSequence: 0,
      recordVersion: 0,
      open: true,
      changes: '[]',
      complete: true,
      ...extra,
    });
  lane(parent, { stacked: true });
  lane(child);
  f.insert('projectHostedStackDependents', {
    projectId: f.projectId,
    parentLaneId: parent,
    laneId: child,
    parentHead: hash('1'),
  });
  f.insert('projectHostedComposeSelections', {
    projectId: f.projectId,
    actor: 'owner',
    operationId: compose,
    kind: 'inputs',
    key: parent,
  });
  const state = await f.enqueue(request);
  // A finish gives its landing a composition id; the fixture's plain request has none, so set it on the
  // stored state (request and previous state stay equal, which is what writeLanding checks).
  const stored = [...f.tables.projectHostedLandingRequests.entries()].find(
    ([, row]) => row.submissionId === state.id,
  );
  const value = JSON.parse(stored[1].value);
  value.request.finish = { composeOperationId: compose, after: null };
  f.patch('projectHostedLandingRequests', stored[0], { value: JSON.stringify(value) });
  // Raw transaction: the landing fixture's budget guard (no compose selections) is for projects without stacks.
  const cancelled = JSON.parse(
    await f.transaction('landingCancel', api.cancel, {
      projectId: f.projectId,
      request: JSON.stringify({ submissionId: state.id, operationId: randomUUID(), authorityEpoch: 1 }),
    }),
  );
  assert.equal(cancelled.error.code, 'LANDING_CANCELLED');
  const notes = [...f.tables.projectBoardMessages.values()].filter(
    note => note.targetKey === `lane:${child}`,
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /landing was cancelled \(LANDING_CANCELLED\)/);
  assert.equal(notes[0].fromLaneId, parent);
  assert.ok(store.writeLanding, 'cancel ends in writeLanding');
});

test('a project with no stacked Lane keeps the landing budget: cancel and failure read no compose selections', async () => {
  const f = await landingFixture();
  const compose = randomUUID();
  const state = await f.enqueue(f.request());
  const stored = [...f.tables.projectHostedLandingRequests.entries()].find(
    ([, row]) => row.submissionId === state.id,
  );
  const value = JSON.parse(stored[1].value);
  value.request.finish = { composeOperationId: compose, after: null };
  f.patch('projectHostedLandingRequests', stored[0], { value: JSON.stringify(value) });
  // f.call applies the fixture guard: a touch of projectHostedComposeSelections would fail the call.
  const cancelled = JSON.parse(
    await f.call('landingCancel', api.cancel, {
      projectId: f.projectId,
      request: JSON.stringify({ submissionId: state.id, operationId: randomUUID(), authorityEpoch: 1 }),
    }),
  );
  assert.equal(cancelled.error.code, 'LANDING_CANCELLED');
  const counts = f.counts.filter(c => c.name === 'landingCancel');
  assert.ok(counts.length);
  assert.ok(counts.every(c => !c.touched.includes('projectHostedComposeSelections')));
  assert.equal(f.tables.projectBoardMessages.size, 0);
});

test('budget: the calls one parent event costs, per table', async () => {
  const f = fixture();
  const parent = randomUUID(),
    child = randomUUID();
  const tally = () => {
    const out = {};
    for (const call of f.calls) out[call] = (out[call] ?? 0) + 1;
    return out;
  };
  await f.write(parent);
  f.calls.length = 0;
  await f.write(parent, { head: hash('2') });
  const plain = tally();
  f.calls.length = 0;
  await f.write(child, stackOn(parent, hash('2')));
  const stacking = tally();
  f.calls.length = 0;
  await f.write(parent, { head: hash('3') });
  const withDependent = tally();
  // A Lane nobody stacked on: the same four calls as before this change, no new table.
  assert.deepEqual(plain, {
    'read:projectHostedOverlapLanes': 1,
    'write:projectHostedOverlapLanes': 1,
    'read:projectHostedOverlapPeers': 1,
    'write:projectHostedOverlapPeers': 1,
  });
  // Stacking a child: its own dependents row (1 read, 1 write) and the parent's flag (1 overlap read and
  // patch, which re-derives the unchanged slim peer row: 1 read, no write).
  assert.equal(stacking['read:projectHostedStackDependents'], 1);
  assert.equal(stacking['write:projectHostedStackDependents'], 1);
  // A parent save with one dependent: 1 dependents range, 1 child overlap read, then the note
  // (replay, 2 switches and counter reads; message, inbox and counter writes) and 1 mark write.
  assert.deepEqual(withDependent, {
    'read:projectHostedOverlapLanes': 2,
    'write:projectHostedOverlapLanes': 1,
    'read:projectHostedOverlapPeers': 1,
    'write:projectHostedOverlapPeers': 1,
    'read:projectHostedStackDependents': 1,
    'write:projectHostedStackDependents': 1,
    'read:projectBoardMessages': 1,
    'read:boardSwitches': 2,
    'read:projectBoardProjects': 1,
    'write:projectBoardMessages': 1,
    'read:projectBoardInboxes': 1,
    'write:projectBoardInboxes': 1,
    'write:projectBoardProjects': 1,
  });
});
