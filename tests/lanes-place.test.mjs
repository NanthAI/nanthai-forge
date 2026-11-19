// SPDX-License-Identifier: Apache-2.0
// The rebuilt Lanes place (Items e317b6ea, 9e748e41 To read, eb0bbb94): the yard's counts are the shell line's
// counts, "next" comes from the queue order, a count that lists fewer rows says so, and To read keeps read state per
// account with a bounded page and an idempotent mark that Undo can take back. History (c613e6bc) replaced To read and
// Landed today: it pages with a cursor, filters by person, agent run and Item, and shows an empty state only when its
// read came back with no rows (35f62c2c).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const model = await import(moduleUrl('../web/src/app/lanes/model.ts'));
const reads = await import(moduleUrl('../convex/projectLandingReads.ts'));
const { successorIntentId } = await import(moduleUrl('../src/hosted-intent-chain.ts'));
const { digest } = await import(moduleUrl('../src/state/hash.ts'));
const { HistoryView, historyFilter } = await import(moduleUrl('../web/src/app/lanes/History.tsx'));
const { parseAppPath, hrefFor, ROOT } = await import(moduleUrl('../web/src/app/paths.ts'));
const { keptLayout } = await import(moduleUrl('../web/src/ds/interactive.tsx'));

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
    lead: '2 Lanes are held.',
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

test('who waits on whom traces a stuck landing to what holds the front of the queue (9e748e41 blocked path)', () => {
  const at = '2026-11-17T10:00:00Z';
  const entries = [
    { position: 1, laneId: 'q1', phase: 'checking', recomposeCount: 2, submittedAt: at, lastProgressAt: at },
    { position: 2, laneId: 'q2', phase: 'queued', submittedAt: at, lastProgressAt: at },
    { position: 3, laneId: 'q3', phase: 'queued', submittedAt: at, lastProgressAt: at },
    {
      position: 4,
      laneId: 'q4',
      phase: 'needs-sync',
      needsSync: { paths: ['src/a.ts', 'src/b.ts'], more: 3 },
      submittedAt: at,
      lastProgressAt: at,
    },
  ];
  const byLane = new Map(model.waits(entries, id => `T-${id}`).map(pair => [pair.laneId, pair]));
  // Directly behind the front: the one hop is the whole path.
  assert.equal(byLane.get('q2').on, 'T-q1');
  assert.equal(byLane.get('q2').why, 'its check restarted 2 times because main moved');
  assert.equal(byLane.get('q2').front, undefined);
  // Further back: the Lanes ahead are counted and the front's own cause is named.
  assert.equal(byLane.get('q3').on, 'T-q2');
  assert.deepEqual(byLane.get('q3').front, {
    laneId: 'q1',
    title: 'T-q1',
    ahead: 2,
    why: 'its check restarted 2 times because main moved',
  });
  // A landing that must update from main waits on its own Lane, naming the files main already took.
  assert.equal(byLane.get('q4').on, 'its own update from main');
  assert.equal(byLane.get('q4').why, 'main already changed src/a.ts, src/b.ts and 3 more of its files');
  assert.equal(byLane.get('q4').front, undefined);
});

test('a Lane behind one that must update from main names that, never the old sync wording', () => {
  const at = '2026-11-17T10:00:00Z';
  const entries = [
    {
      position: 1,
      laneId: 'q1',
      phase: 'needs-sync',
      needsSync: { paths: ['x.ts'] },
      submittedAt: at,
      lastProgressAt: at,
    },
    { position: 2, laneId: 'q2', phase: 'queued', submittedAt: at, lastProgressAt: at },
    { position: 3, laneId: 'q3', phase: 'queued', submittedAt: at, lastProgressAt: at },
  ];
  const byLane = new Map(model.waits(entries, id => `T-${id}`).map(pair => [pair.laneId, pair]));
  assert.equal(byLane.get('q2').why, 'it must update from main first');
  assert.equal(byLane.get('q3').front.why, 'it must update from main first: main already changed x.ts');
  for (const pair of byLane.values()) assert.doesNotMatch(`${pair.why} ${pair.front?.why ?? ''}`, /sync/i);
});

test('a Lane held for a dependency names the Lane it lands after and why that one has not landed (9e748e41)', () => {
  const at = '2026-11-17T10:00:00Z';
  const dep = (laneId, parent) => ({
    position: null,
    laneId,
    phase: 'ready',
    submittedAt: at,
    lastProgressAt: at,
    hold: { kind: 'dependency', reason: 'Waiting for a dependency to land', paths: null },
    dependsOn: { submissionId: parent },
  });
  const entries = [
    { position: 1, laneId: 'p1', submissionId: 's1', phase: 'checking', submittedAt: at, lastProgressAt: at },
    {
      position: null,
      laneId: 'p2',
      submissionId: 's2',
      phase: 'ready',
      submittedAt: at,
      lastProgressAt: at,
      hold: { kind: 'review', reason: 'A person approves each landing.', paths: null },
    },
    dep('d1', 's1'),
    dep('d2', 's2'),
    dep('d3', 'gone'),
  ];
  const byLane = new Map(model.waits(entries, id => `T-${id}`).map(pair => [pair.laneId, pair]));
  assert.deepEqual(
    [byLane.get('d1').on, byLane.get('d1').why],
    ['T-p1', 'it lands after it; its check is running'],
  );
  assert.deepEqual(
    [byLane.get('d2').on, byLane.get('d2').why],
    ['T-p2', 'it lands after it; that one waits on a person'],
  );
  // The landing it depends on is not in the listed queue: say so, never guess a Lane.
  assert.deepEqual(
    [byLane.get('d3').on, byLane.get('d3').why],
    ['the Lane it depends on', 'Waiting for a dependency to land'],
  );
});

test('the yard names the Lane a dependency-held Lane lands after, from the queue read alone (9e748e41)', () => {
  const lanes = [
    mark('p', 'checking'),
    mark('d', 'ready', { held: true }),
    mark('g', 'ready', { held: true }),
  ];
  const held = (laneId, parent) => ({
    position: null,
    laneId,
    submissionId: `s-${laneId}`,
    phase: 'ready',
    landingState: { state: 'held-dependency' },
    submittedAt: '',
    lastProgressAt: '',
    hold: { kind: 'dependency', reason: 'Waiting for a dependency to land', paths: null },
    dependsOn: { submissionId: parent },
  });
  const queue = {
    total: 1,
    listed: 3,
    more: false,
    entries: [
      {
        position: 1,
        laneId: 'p',
        submissionId: 's-p',
        phase: 'checking',
        submittedAt: '',
        lastProgressAt: '',
      },
      held('d', 's-p'),
      held('g', 'gone'),
    ],
  };
  const yard = model.buildYard(feed(lanes), [meta('p', 'Parent work'), meta('d', 'Child work')], queue, 0);
  const row = id => yard.rows.find(r => r.laneId === id);
  assert.equal(row('d').band, 'needs');
  assert.equal(row('d').why, 'waits for Parent work to land');
  // The landing it depends on is not listed: the shared words, never a guessed Lane.
  assert.equal(row('g').why, 'waits for the Lane it depends on');
});

test('a Lane held for a queued dependency says where that one stands and what holds the front (9e748e41 review fix 1)', () => {
  const at = '2026-11-17T10:00:00Z';
  const q = (position, laneId, phase = 'queued') => ({
    position,
    laneId,
    submissionId: `s-${laneId}`,
    phase,
    submittedAt: at,
    lastProgressAt: at,
  });
  const entries = [
    q(1, 'f', 'checking'),
    q(2, 'a'),
    q(3, 'b'),
    q(4, 'p'),
    {
      position: null,
      laneId: 'd',
      phase: 'ready',
      submittedAt: at,
      lastProgressAt: at,
      hold: { kind: 'dependency', reason: 'Waiting for a dependency to land', paths: null },
      dependsOn: { submissionId: 's-p' },
    },
  ];
  const d = model.waits(entries, id => `T-${id}`).find(pair => pair.laneId === 'd');
  assert.equal(d.on, 'T-p');
  assert.equal(d.why, 'it lands after it; that one is number 4 in the queue');
  // Three Lanes stand ahead of the parent: the dependent is traced to the front, never told "it lands first".
  assert.deepEqual(d.front, { laneId: 'f', title: 'T-f', ahead: 4, why: 'its check is running' });
  // A parent at the front needs no front line.
  const first = model
    .waits([q(1, 'p', 'checking'), { ...entries[4] }], id => `T-${id}`)
    .find(pair => pair.laneId === 'd');
  assert.equal(first.why, 'it lands after it; its check is running');
  assert.equal(first.front, undefined);
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
  /** One accepted landing. `intentId` adds its finish row (the Intent it landed for); `who` overrides the builder. */
  const accept = (sequence, message, { intentId, who = {} } = {}) => {
    const id = randomUUID();
    const submissionId = randomUUID();
    s.insert('projectHostedAcceptances', {
      projectId,
      receiptId: id,
      submissionId,
      attemptId: randomUUID(),
      sequence,
      value: JSON.stringify({
        id,
        at: new Date(Date.UTC(2026, 10, 17, 9, sequence)).toISOString(),
        message,
        actor: { id: 'owner', kind: 'agent' },
        automatic: true,
        ...who,
      }),
    });
    if (intentId)
      s.insert('projectHostedFinishes', {
        projectId,
        submissionId,
        composeOperationId: null,
        parentSubmissionId: null,
        waiting: false,
        wake: null,
        value: JSON.stringify({ source: { intentId } }),
      });
  };
  /** A planned Item: its Issue head with the value inline, as the record store keeps it. */
  const plan = (id, title) =>
    s.insert('projectHostedRecordHeads', {
      projectId,
      kind: 'issue',
      key: id,
      version: 1,
      parent: '',
      status: 'open',
      recordId: `issue-record-${id}`,
      value: JSON.stringify({ id, kind: 'issue', title, status: 'open' }),
    });
  /** An Intent record with its goal inline (a follow-up of a reopened Item, or unplanned work). */
  const intent = (key, outcome) => {
    const inline = JSON.stringify({ id: key, outcome });
    const recordId = s.insert('projectHostedRecords', {
      projectId,
      kind: 'intent',
      key,
      parent: 'owner',
      status: 'active',
      version: 0,
      inline,
      bodyId: `intent-body-${key}`,
      digest: digest(inline),
      bytes: new TextEncoder().encode(inline).length,
    });
    s.insert('projectHostedRecordHeads', {
      projectId,
      kind: 'intent',
      key,
      version: 0,
      parent: 'owner',
      status: 'active',
      recordId,
    });
  };
  const list = (actor, view, extra = {}) =>
    s.call('list', reads.list, { projectId, ...(view ? { view } : {}), ...extra }, actor).then(JSON.parse);
  const set = (actor, args) => s.call('mark', reads.mark, { projectId, ...args }, actor);
  return { s, projectId, accept, plan, intent, list, set };
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

test('History pages with a cursor: each page is bounded and the next one starts below it', async () => {
  const f = readsFixture();
  const total = reads.HISTORY_PAGE + 5;
  for (let i = 1; i <= total; i++) f.accept(i, `L${i}`);
  const first = await f.list('owner', 'recent');
  assert.equal(first.rows.length, reads.HISTORY_PAGE);
  assert.equal(first.rows[0].sequence, total);
  assert.equal(first.newest, total);
  const last = f.s.counts.at(-1);
  // 1 read-state row + the page and one more receipt + finish, Lane and Item heads per listed landing.
  assert(
    last.documents <= reads.HISTORY_PAGE + 2 + reads.HISTORY_PAGE * 3,
    `${last.documents} documents read`,
  );
  const second = await f.list('owner', 'recent', { before: first.next });
  assert.deepEqual(
    second.rows.map(row => row.sequence),
    [5, 4, 3, 2, 1],
  );
  assert.equal(second.next, null, 'nothing is left below the last page');
  const exact = readsFixture();
  for (let i = 1; i <= reads.HISTORY_PAGE; i++) exact.accept(i, `L${i}`);
  assert.equal((await exact.list('owner', 'recent')).next, null, 'a page that holds everything has no next');
});

test("History filters by person, by agent run and by Item, including the Item's follow-up Intents", async () => {
  const f = readsFixture();
  const itemId = randomUUID();
  const followUp = successorIntentId(itemId);
  f.plan(itemId, 'History replaces To read');
  const agent = (run, model) => ({
    actor: { id: 'mara', kind: 'agent' },
    agentRun: run,
    agentClient: `claude-code:${model}`,
  });
  f.accept(1, 'Unplanned fix', { who: { actor: { id: 'jon', kind: 'person' } } });
  f.accept(2, 'History: read and filter', { intentId: itemId, who: agent('amber-fox', 'claude-opus-5-5') });
  f.accept(3, 'Other work', { intentId: randomUUID(), who: agent('copper-moth', 'gpt-6.1-sol') });
  f.accept(4, 'History: follow-up', { intentId: followUp, who: agent('amber-fox', 'claude-opus-5-5') });
  const all = await f.list('owner', 'recent');
  assert.deepEqual(
    all.rows.map(row => [row.sequence, row.actor, row.agent, row.agentRun, row.model]),
    [
      [4, 'mara', true, 'amber-fox', 'claude-opus-5-5'],
      [3, 'mara', true, 'copper-moth', 'gpt-6.1-sol'],
      [2, 'mara', true, 'amber-fox', 'claude-opus-5-5'],
      [1, 'jon', false, null, null],
    ],
    'each row says who landed it: a person, or an agent run with its declared model',
  );
  assert.deepEqual(
    all.rows.find(row => row.sequence === 2).item,
    { id: itemId, title: 'History replaces To read' },
    "a landing for an Item's first Intent carries the Item's title",
  );
  assert.equal(all.rows.find(row => row.sequence === 1).item, null, 'unplanned work has no Item');
  assert.equal(all.rows.find(row => row.sequence === 2).goal, null, 'an Item row reads no Intent goal');
  const by = async filter => (await f.list('owner', 'recent', filter)).rows.map(row => row.sequence);
  assert.deepEqual(await by({ by: 'mara' }), [4, 3, 2], 'a person with the agents acting for them');
  assert.deepEqual(await by({ by: 'mara/amber-fox' }), [4, 2], 'one agent run');
  assert.deepEqual(await by({ by: 'jon' }), [1]);
  assert.deepEqual(await by({ item: itemId }), [4, 2], 'an Item, through its follow-up Intent too');
  assert.deepEqual(await by({ item: itemId, by: 'jon' }), []);
  await assert.rejects(f.list('owner', 'recent', { by: '' }), /BAD_ARGUMENT|handle/);
});

test('a filtered page looks through a bounded number of receipts and resumes below them', async () => {
  const f = readsFixture();
  const total = reads.HISTORY_SCAN + 10;
  for (let i = 1; i <= total; i++)
    f.accept(i, `L${i}`, i === 3 ? { who: { actor: { id: 'jon', kind: 'person' } } } : {});
  const first = await f.list('owner', 'recent', { by: 'jon' });
  assert.deepEqual(first.rows, [], 'the one match is older than the scan reaches');
  assert.equal(first.scanned, reads.HISTORY_SCAN);
  assert.equal(first.next, total - reads.HISTORY_SCAN + 1);
  const second = await f.list('owner', 'recent', { by: 'jon', before: first.next });
  assert.deepEqual(
    second.rows.map(row => row.sequence),
    [3],
  );
  assert.equal(second.next, null);
});

test('To read refuses an account without access to a private project', async () => {
  const f = readsFixture();
  const project = f.s.tables.hostedProjects.get(f.projectId);
  f.s.tables.hostedProjects.set(f.projectId, { ...project, visibility: 'private' });
  await assert.rejects(f.list('stranger'), /PROJECT_UNAVAILABLE|unavailable/);
  await assert.rejects(f.set('stranger', { read: [1] }), /PROJECT_UNAVAILABLE|unavailable/);
});

const historyRow = (sequence, extra = {}) => ({
  sequence,
  receiptId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  at: new Date(Date.UTC(2026, 10, 17, 9, sequence)).toISOString(),
  title: `Landing ${sequence}`,
  message: `Landing ${sequence}\n\nWhy it changed.`,
  item: null,
  goal: null,
  actor: 'mara',
  agent: true,
  agentRun: 'amber-fox',
  model: 'claude-opus-5-5',
  automatic: true,
  laneId: null,
  read: false,
  ...extra,
});
const historyPage = (rows, extra = {}) => ({
  started: false,
  through: null,
  newest: rows[0]?.sequence ?? null,
  rows,
  next: null,
  scanned: rows.length,
  ...extra,
});
const renderHistory = (page, filter = { unread: false, by: null, item: null }) =>
  renderToStaticMarkup(
    h(HistoryView, {
      trail: [],
      page,
      error: false,
      filter,
      approvals: 0,
      needsMe: '/needs',
      laneHref: id => `/lanes/${id}`,
      receiptHref: id => `/code/${id}`,
      onFilter: () => {},
      onMark: () => {},
      onMarkAll: () => {},
      showEarlier: () => {},
      busy: false,
      earlierFailed: false,
      status: null,
    }),
  );
const EMPTY = /Nothing has landed yet|Nothing landed that matches|You have read everything/;

test('History never shows the empty state while it reads or when the read returned landings (35f62c2c)', () => {
  const loading = renderHistory(undefined);
  assert.doesNotMatch(loading, EMPTY, 'still reading is not empty');
  assert.match(loading, /aria-busy="true"/);
  const rows = renderHistory(
    historyPage([
      historyRow(2, { item: { id: 'i-1', title: 'History replaces To read' } }),
      historyRow(1, { agent: false, agentRun: null, model: null, actor: 'jon', read: true }),
    ]),
  );
  assert.doesNotMatch(rows, EMPTY, 'a project with landings never renders the empty state');
  assert.match(rows, /History replaces To read/, "the row's title is its Item's");
  assert.match(rows, /claude-opus-5-5/, "an agent row shows the run's declared model");
  assert.match(rows, /@jon/, 'a person row shows the person');
  assert.match(rows, /Unread: <\/span>History replaces To read/);
  assert.match(rows, /Mark all as read/);
  assert.match(
    renderHistory(historyPage([])),
    /Nothing has landed yet/,
    'empty only when the read returned none',
  );
  const further = renderHistory(historyPage([], { next: 40, newest: 160 }), {
    unread: false,
    by: 'jon',
    item: null,
  });
  assert.doesNotMatch(further, EMPTY, 'a filtered page with more to look through is not empty');
  assert.match(further, /Show earlier landings/);
  assert.match(
    renderHistory(historyPage([], { newest: null }), { unread: false, by: 'jon', item: null }),
    /Nothing landed that matches/,
  );
  assert.match(
    renderHistory(historyPage([], { started: true }), { unread: true, by: null, item: null }),
    /You have read everything/,
  );
});

test('the old To read address opens History, and History keeps its filters in the address', () => {
  const route = parseAppPath(`${ROOT}/mara/tide-pool/lanes/to-read`);
  assert.deepEqual([route.place, route.section, route.rest], ['lanes', 'history', '']);
  assert.equal(hrefFor(route), `${ROOT}/mara/tide-pool/lanes/history`);
  assert.deepEqual(historyFilter(new URLSearchParams('unread=1&by=mara/amber-fox&item=i-1')), {
    unread: true,
    by: 'mara/amber-fox',
    item: 'i-1',
  });
  assert.deepEqual(historyFilter(new URLSearchParams('')), { unread: false, by: null, item: null });
});

test("a Lanes layout saved while it still had Landed today gives way to today's regions", () => {
  const now = { top: ['yard', 'overlaps'], a: [], b: [] };
  assert.deepEqual(keptLayout({ top: ['yard'], a: ['overlaps'], b: ['landed'] }, now), now);
  const moved = { top: [], a: ['overlaps'], b: ['yard'] };
  assert.deepEqual(keptLayout(moved, now), moved, 'a layout of the same regions is kept');
  assert.deepEqual(keptLayout(null, now), now);
});

test("a landing from a reopened Item's follow-up Intent is titled with the goal its Intent was started with", async () => {
  const f = readsFixture();
  const itemId = randomUUID();
  const followUp = successorIntentId(itemId);
  f.plan(itemId, 'History replaces To read');
  f.intent(followUp, 'History replaces To read');
  f.accept(1, 'Follow-up: phone rows', { intentId: followUp });
  const [row] = (await f.list('owner', 'recent')).rows;
  assert.equal(row.item, null, 'a follow-up Intent has no stored link back to its Item');
  assert.equal(row.goal, 'History replaces To read');
  assert.match(
    renderHistory(historyPage([historyRow(1, { goal: row.goal, title: row.title })])),
    /History replaces To read/,
  );
  assert.deepEqual(
    (await f.list('owner', 'recent', { item: itemId })).rows.map(r => r.sequence),
    [1],
  );
});
