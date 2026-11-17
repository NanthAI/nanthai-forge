// SPDX-License-Identifier: Apache-2.0
// The rebuilt Lanes place (Items e317b6ea, 9e748e41 To read, eb0bbb94): the yard's counts are the shell line's
// counts, "next" comes from the queue order, a count that lists fewer rows says so, and To read keeps read state per
// account with a bounded page and an idempotent mark that Undo can take back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const model = await import(moduleUrl('../web/src/app/lanes/model.ts'));
const reads = await import(moduleUrl('../convex/projectLandingReads.ts'));

const mark = (laneId, stage, extra = {}) => ({
  laneId,
  stage,
  held: false,
  overlap: false,
  changedAt: 1,
  ...extra,
});
const feed = (lanes, more = 0) => ({ lanes, more, moreIsLowerBound: false, main: null, exit: null });
const meta = (laneId, intent, actor = 'mara') => ({
  laneId,
  intentId: `i-${laneId}`,
  intent,
  actor,
  lastSaveAt: null,
  landing: null,
});

test('the yard puts every held Lane under Needs you, so its count equals the shell line count', () => {
  const lanes = [
    mark('a', 'ready', { held: true }),
    mark('b', 'checking', { held: true }),
    mark('c', 'checking'),
    mark('d', 'saved'),
    mark('e', 'editing', { overlap: true }),
  ];
  const queue = {
    total: 1,
    listed: 3,
    more: false,
    entries: [
      // Each entry carries the server's one reading of its submission (src/landing-state.ts).
      {
        position: 1,
        laneId: 'c',
        phase: 'checking',
        landingState: { state: 'checking' },
        submittedAt: '',
        lastProgressAt: '',
      },
      {
        position: null,
        laneId: 'a',
        phase: 'ready',
        landingState: { state: 'held-review' },
        submittedAt: '',
        lastProgressAt: '',
        hold: { kind: 'review', reason: 'protected paths: a', paths: ['a'] },
      },
      {
        position: null,
        laneId: 'b',
        phase: 'terminal-failed',
        landingState: { state: 'check-failed' },
        submittedAt: '',
        lastProgressAt: '',
        lastFailingTests: ['t1', 't2'],
      },
    ],
  };
  const yard = model.buildYard(feed(lanes), [meta('a', 'Approve me'), meta('c', 'Check me')], queue, 0);
  const shellHeld = lanes.filter(lane => lane.held).length;
  assert.equal(yard.counts.needs, shellHeld);
  assert.deepEqual(
    yard.rows.map(row => [row.laneId, row.band, row.word]),
    [
      ['a', 'needs', 'Needs you'],
      ['b', 'needs', 'Check failed'],
      ['c', 'queue', 'Checking'],
      ['d', 'work', 'Saved'],
      ['e', 'work', 'Conflict'],
    ],
  );
  assert.equal(yard.rows[1].why, 't1 and 1 more');
  assert.equal(yard.next.laneId, 'c', 'next is the queue position 1, never a held Lane');
  assert.deepEqual(model.situation(yard), {
    lead: '2 Lanes need you.',
    rest: 'Check me lands next.',
  });
});

test('the yard says when the line feed holds more open Lanes than it lists', () => {
  const yard = model.buildYard(
    { ...feed([mark('a', 'editing')], 41), moreIsLowerBound: true },
    [],
    undefined,
    0,
  );
  assert.equal(yard.open, 42);
  assert.match(model.situation(yard).rest, /41 or more more not shown/);
  assert.equal(
    yard.rows[0].untitled,
    true,
    'a Lane outside the title page is marked untitled, never guessed',
  );
});

test('filters and a stop picked on the top bar narrow the yard by address alone', () => {
  const yard = model.buildYard(
    feed([mark('a', 'editing'), mark('b', 'saved', { held: true })]),
    [meta('a', 'A', 'mara'), meta('b', 'B', 'jun')],
    undefined,
    0,
  );
  assert.deepEqual(
    model.filterRows(yard.rows, 'needs').map(row => row.laneId),
    ['b'],
  );
  assert.deepEqual(
    model.filterRows(yard.rows, 'mine', 'mara').map(row => row.laneId),
    ['a'],
  );
  assert.deepEqual(model.filterRows(yard.rows, 'mine', undefined), []);
  assert.deepEqual(
    model.atStop(yard.rows, 'saved').map(row => row.laneId),
    ['b'],
  );
  assert.equal(model.atStop(yard.rows, 'nonsense').length, 2);
});

test('shared files list only paths saved in two or more Lanes and keep incomplete coverage', () => {
  const view = {
    lanes: [{ laneId: 'a' }, { laneId: 'b' }, { laneId: 'c' }],
    paths: ['x.ts', 'y.ts'],
    edits: [
      { lane: 0, paths: [0, 1] },
      { lane: 1, paths: [0] },
      { lane: 2, paths: [0, 1] },
    ],
    complete: false,
  };
  const { files, complete } = model.sharedFiles(view);
  assert.deepEqual(files, [
    { path: 'x.ts', laneIds: ['a', 'b', 'c'] },
    { path: 'y.ts', laneIds: ['a', 'c'] },
  ]);
  assert.equal(complete, false, 'unknown coverage never becomes a complete list');
});

test('who waits on whom puts waits on a person first and each queued Lane on the one ahead', () => {
  const entries = [
    { position: 1, laneId: 'q1', phase: 'checking', submittedAt: '2026-11-17T10:00:00Z', lastProgressAt: '' },
    { position: 2, laneId: 'q2', phase: 'queued', submittedAt: '2026-11-17T10:01:00Z', lastProgressAt: '' },
    {
      position: null,
      laneId: 'h',
      phase: 'ready',
      submittedAt: '',
      lastProgressAt: '2026-11-17T09:00:00Z',
      hold: { kind: 'review', reason: '', paths: null },
    },
  ];
  const pairs = model.waits(entries, id => `T-${id}`);
  assert.deepEqual(
    pairs.map(pair => [pair.laneId, pair.on, pair.person]),
    [
      ['h', 'a person', true],
      ['q2', 'T-q1', false],
    ],
  );
});

function readsFixture() {
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'public',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  const accept = (sequence, message) => {
    const id = randomUUID();
    s.insert('projectHostedAcceptances', {
      projectId,
      receiptId: id,
      submissionId: randomUUID(),
      attemptId: randomUUID(),
      sequence,
      value: JSON.stringify({
        id,
        at: new Date(Date.UTC(2026, 10, 17, 9, sequence)).toISOString(),
        message,
        actor: { id: 'owner', kind: 'agent' },
        automatic: true,
      }),
    });
  };
  const list = (actor, view) =>
    s.call('list', reads.list, { projectId, ...(view ? { view } : {}) }, actor).then(JSON.parse);
  const set = (actor, args) => s.call('mark', reads.mark, { projectId, ...args }, actor);
  return { s, projectId, accept, list, set };
}

test('To read keeps read state per account: one reader marking does not clear another', async () => {
  const f = readsFixture();
  for (let i = 1; i <= 3; i++) f.accept(i * 10, `Landing ${i}\n\nbody`);
  const first = await f.list('owner');
  assert.deepEqual(
    first.rows.map(row => [row.sequence, row.title]),
    [
      [30, 'Landing 3'],
      [20, 'Landing 2'],
      [10, 'Landing 1'],
    ],
  );
  assert.equal(first.started, false);
  await f.set('owner', { read: [20] });
  assert.deepEqual(
    (await f.list('owner')).rows.map(row => row.sequence),
    [30, 10],
  );
  assert.deepEqual(
    (await f.list('reader')).rows.map(row => row.sequence),
    [30, 20, 10],
  );
  await f.set('owner', { read: [20] });
  assert.deepEqual(
    (await f.list('owner')).rows.map(row => row.sequence),
    [30, 10],
    'marking twice is marking once',
  );
  await f.set('owner', { unread: [20] });
  assert.deepEqual(
    (await f.list('owner')).rows.map(row => row.sequence),
    [30, 20, 10],
    'Undo brings it back',
  );
});

test('mark all folds into one read line, a new landing is unread again, and Undo restores the line', async () => {
  const f = readsFixture();
  for (let i = 1; i <= 3; i++) f.accept(i, `L${i}`);
  await f.set('owner', { read: [2] });
  const before = await f.list('owner');
  const reply = JSON.parse(await f.set('owner', { through: before.newest }));
  const after = await f.list('owner');
  assert.deepEqual(after.rows, []);
  const row = [...f.s.tables.projectLandingReads.values()][0];
  assert.deepEqual([row.through, row.read], [3, []], 'one row per account, its one-by-one set folded');
  f.accept(4, 'L4');
  assert.deepEqual(
    (await f.list('owner')).rows.map(r => r.title),
    ['L4'],
  );
  assert.deepEqual(
    (await f.list('owner', 'recent')).rows.map(r => [r.title, r.read]),
    [
      ['L4', false],
      ['L3', true],
      ['L2', true],
      ['L1', true],
    ],
  );
  await f.set('owner', { restoreThrough: reply.previous.through, read: reply.previous.read });
  assert.deepEqual(
    (await f.list('owner')).rows.map(r => r.title),
    ['L4', 'L3', 'L1'],
  );
});

test('To read lists a bounded page and says when more are unread', async () => {
  const f = readsFixture();
  for (let i = 1; i <= reads.TO_READ_PAGE + 5; i++) f.accept(i, `L${i}`);
  const page = await f.list('owner');
  assert.equal(page.rows.length, reads.TO_READ_PAGE);
  assert.equal(page.more, true);
  const last = f.s.counts.at(-1);
  assert(
    last.documents <= reads.TO_READ_PAGE + 2 + reads.TO_READ_PAGE * 2,
    `${last.documents} documents read`,
  );
});

test('To read refuses an account without access to a private project', async () => {
  const f = readsFixture();
  const project = f.s.tables.hostedProjects.get(f.projectId);
  f.s.tables.hostedProjects.set(f.projectId, { ...project, visibility: 'private' });
  await assert.rejects(f.list('stranger'), /PROJECT_UNAVAILABLE|unavailable/);
  await assert.rejects(f.set('stranger', { read: [1] }), /PROJECT_UNAVAILABLE|unavailable/);
});
