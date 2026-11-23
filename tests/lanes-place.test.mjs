// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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

test('48049998: Needs you holds the held Lanes this reader decides, Held the rest, together the shell line count', () => {
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
  // Needs me's own read (shared with the top bar's count): the review hold waits on this owner, the failed check is
  // its agent's next step.
  const needsRead = {
    held: [
      {
        laneId: 'a',
        title: 'Approve me',
        actor: 'mara',
        agent: null,
        why: 'review',
        note: null,
        submissionId: 's-a',
        since: 0,
      },
      {
        laneId: 'b',
        title: null,
        actor: 'mara',
        agent: null,
        why: 'check-failed',
        note: null,
        submissionId: 's-b',
        since: 0,
      },
    ],
    more: 0,
    moreIsLowerBound: false,
    approvals: '{}',
    canDecide: true,
  };
  const needsYou = model.needsYouLanes(needsRead, 0);
  const yard = model.buildYard(
    feed(lanes),
    [meta('a', 'Approve me'), meta('c', 'Check me')],
    queue,
    0,
    needsYou,
  );
  const shellHeld = lanes.filter(lane => lane.held).length;
  assert.equal(yard.counts.needs + yard.counts.held, shellHeld);
  assert.equal(yard.counts.needs, 1);
  assert.deepEqual(
    yard.rows.map(row => [row.laneId, row.band, row.word]),
    [
      ['a', 'needs', 'Needs you'],
      ['b', 'held', 'Check failed'],
      ['c', 'queue', 'Checking'],
      ['d', 'work', 'Saved'],
      ['e', 'work', 'Editing'], // shares a saved file: no state colour (Item 9b9057a9)
    ],
  );
  assert.equal(yard.rows[1].why, 't1 and 1 more');
  assert.equal(yard.next.laneId, 'c', 'next is the queue position 1, never a held Lane');
  assert.deepEqual(model.situation(yard), {
    lead: '1 Lane needs you.',
    rest: '1 more is held.',
    next: { laneId: 'c', title: 'Check me', words: 'is next to land' },
  });
  // The yard's stop counts are the top bar's (Line.tsx lineStopCounts): Editing, Saved, In queue, Checking, where a
  // failed check is not counted and a passed one is said apart.
  assert.deepEqual(yard.stops, [
    { count: 1, passed: 0, atLeast: false },
    { count: 1, passed: 0, atLeast: false },
    { count: 0, passed: 0, atLeast: false },
    { count: 1, passed: 1, atLeast: false },
  ]);
  assert.equal(yard.needsKnown, 'all');
  // A reader who decides nothing here: no Lane needs them, and every held Lane is Held.
  const viewer = model.buildYard(
    feed(lanes),
    [meta('c', 'Check me')],
    queue,
    0,
    model.needsYouLanes({ ...needsRead, canDecide: false }, 0),
  );
  assert.deepEqual([viewer.counts.needs, viewer.counts.held], [0, 2]);
  assert.deepEqual(model.situation(viewer), {
    lead: 'No Lane needs you.',
    rest: '2 Lanes are held.',
    next: { laneId: 'c', title: 'Check me', words: 'is next to land' },
  });
  // Needs me's read is capped (more held than it lists): never "No Lane needs you", and the count is a floor.
  const capped = model.buildYard(
    feed(lanes),
    [meta('a', 'Approve me'), meta('c', 'Check me')],
    queue,
    0,
    model.needsYouLanes({ ...needsRead, more: 3 }, 0),
  );
  assert.equal(capped.needsKnown, 'partial');
  assert.equal(model.situation(capped).lead, '1 or more Lanes need you.');
  const cappedNone = model.buildYard(
    feed(lanes),
    [meta('c', 'Check me')],
    queue,
    0,
    model.needsYouLanes({ ...needsRead, held: [], more: 2 }, 0),
  );
  assert.equal(model.situation(cappedNone).lead, 'Not every held Lane was checked for you.');
  // Needs me's read failed: the yard still shows, every held Lane is Held, and it says it could not tell.
  const failed = model.buildYard(feed(lanes), [meta('c', 'Check me')], queue, 0, model.NEEDS_UNKNOWN);
  assert.deepEqual([failed.needsKnown, failed.counts.needs, failed.counts.held], ['unknown', 0, 2]);
  assert.equal(model.situation(failed).lead, 'Which held Lanes need you could not be read.');
  // The feed lists fewer Lanes than are open: each stop is a floor.
  const more = model.buildYard({ ...feed(lanes), more: 4 }, [], queue, 0, needsYou);
  assert.ok(more.stops.every(stop => stop.atLeast));
});

test('a Lane with no save is never "Saved": its row says editing, no save yet (owner 2026-11-19, 6ebb58ab)', () => {
  const lanes = [mark('started', 'saved'), mark('saved', 'saved'), mark('unread', 'saved')];
  const yard = model.buildYard(
    feed(lanes),
    [
      meta('started', 'Revert accepted change'),
      { ...meta('saved', 'Saved work'), lastSaveAt: '1970-01-01T00:00:00.000Z' },
    ],
    undefined,
    5 * 60_000,
  );
  const row = id => yard.rows.find(r => r.laneId === id);
  assert.deepEqual(
    [row('started').word, row('started').why, row('started').stage],
    ['Editing', 'no save yet', 'editing'],
  );
  assert.deepEqual(
    [row('saved').word, row('saved').why, row('saved').stage],
    ['Saved', 'saved 5 min ago', 'saved'],
  );
  // Outside the Lane read nothing is known about saves: the line's own word, and no claim either way.
  assert.deepEqual([row('unread').word, row('unread').why], ['Saved', '']);
  assert.ok(
    !yard.rows.some(r => r.word === 'Saved' && r.why === 'no save yet'),
    'never "Saved" beside "no save yet"',
  );
});

test('a running check says its time against the usual check, overdue past the slowest, with a bounded clock (ecd6e610)', () => {
  const start = Date.parse('2026-11-19T10:00:00Z');
  const min = 60_000;
  const time = ms => new Date(ms).toISOString().slice(11, 16);
  const clock = { startedAt: start, usualMs: 10 * min, slowMs: 18 * min, note: null };
  const at = elapsed => model.checkProgress(clock, start + elapsed, time);
  assert.deepEqual(
    [at(20_000).why, at(20_000).detail, at(20_000).nextAt],
    ['under 1 min so far', 'usually about 10 min', start + min],
  );
  const six = at(6.5 * min);
  assert.deepEqual([six.why, six.overdue, six.nextAt], ['6 min so far', false, start + 7 * min]);
  assert.ok(Math.abs(six.at - (model.CHECK_FROM + (model.CHECK_TO - model.CHECK_FROM) * 0.65)) < 1e-9);
  // Between the usual and the slowest it holds at the end of the stop, still counting; the clock stops at overdue.
  const twelve = at(12 * min);
  assert.deepEqual([twelve.at, twelve.overdue, twelve.why], [model.CHECK_TO, false, '12 min so far']);
  assert.equal(at(17.5 * min).nextAt, start + 18 * min);
  assert.equal(
    at(18 * min).nextAt,
    start + 18 * min + 1,
    'at the slowest, the next change is the overdue moment',
  );
  const late = at(40 * min);
  assert.deepEqual(
    [late.why, late.detail, late.overdue, late.at, late.nextAt],
    ['overdue: over 18 min', 'usually about 10 min', true, model.CHECK_TO, Infinity],
  );
  // No usual time reported: the start's clock time, the middle of the stop, and no timer at all.
  const bare = model.checkProgress({ ...clock, usualMs: null, slowMs: null }, start + 5 * min, time);
  assert.deepEqual(
    [bare.why, bare.detail, bare.at, bare.nextAt],
    // The middle of a running check's span on Checking (CHECK_FROM to CHECK_TO), wherever the stop sits.
    ['started 10:00', 'usual time not reported yet', (model.CHECK_FROM + model.CHECK_TO) / 2, Infinity],
  );
  // Waiting for a runner is said first, the time beside it.
  const runner = model.checkProgress({ ...clock, note: 'waiting for a runner' }, start + 3 * min, time);
  assert.deepEqual(
    [runner.why, runner.detail],
    ['waiting for a runner', '3 min so far · usually about 10 min'],
  );
});

test('the yard gives a clock only to a Lane whose check is running, from the queue read alone (ecd6e610)', () => {
  const started = '2026-11-19T10:00:00.000Z';
  const entry = (laneId, phase, extra = {}) => ({
    position: 1,
    laneId,
    landingState: { state: phase === 'checking' ? 'checking' : 'landing' },
    phase,
    submittedAt: started,
    lastProgressAt: started,
    ...extra,
  });
  const feed = {
    lanes: [mark('a', 'checking'), mark('b', 'checking'), mark('c', 'ready')],
    more: 0,
    main: null,
  };
  const queue = {
    total: 3,
    listed: 3,
    more: false,
    usualCheck: { seconds: 600, slowSeconds: 1080, landings: 12 },
    entries: [
      entry('a', 'checking', { checkStartedAt: started }),
      entry('b', 'checking', { position: 2 }),
      entry('c', 'ready', { position: 3, checkStartedAt: started }),
    ],
  };
  const rows = new Map(
    model.buildYard(feed, [], queue, Date.parse(started)).rows.map(row => [row.laneId, row]),
  );
  assert.deepEqual(rows.get('a').check, {
    startedAt: Date.parse(started),
    usualMs: 600_000,
    slowMs: 1_080_000,
    note: null,
  });
  assert.equal(rows.get('b').check, null, 'no recorded start: no clock, never a guess');
  assert.equal(rows.get('c').check, null, 'a Lane ready to land has no running check');
  const unreported = model.buildYard(feed, [], { ...queue, usualCheck: null }, Date.parse(started));
  assert.deepEqual(
    [unreported.rows.find(row => row.laneId === 'a').check.usualMs, unreported.rows[0].check?.slowMs ?? null],
    [null, null],
  );
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
    { lanes: new Set(['b']), known: 'all' },
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

test('f787005c: each Lane row counts the files it shares and the other Lanes it shares them with, from the one overlap read', () => {
  const view = {
    lanes: [{ laneId: 'a' }, { laneId: 'b' }, { laneId: 'c' }, { laneId: 'd' }],
    paths: ['x.ts', 'y.ts', 'z.ts'],
    edits: [
      { lane: 0, paths: [0, 1] },
      { lane: 1, paths: [0] },
      { lane: 2, paths: [0, 1] },
      { lane: 3, paths: [2] },
    ],
    complete: true,
  };
  const shares = model.sharesByLane(model.sharedFiles(view).files);
  assert.deepEqual(Object.fromEntries(shares), {
    a: { files: 2, lanes: 2 },
    b: { files: 1, lanes: 2 },
    c: { files: 2, lanes: 2 },
  });
  assert.equal(shares.has('d'), false, 'a Lane alone on its files gets no line');
  assert.equal(model.sharesWords(shares.get('a')), 'shares 2 files with 2 Lanes');
  assert.equal(model.sharesWords({ files: 1, lanes: 1 }), 'shares 1 file with 1 Lane');
});

test('f787005c: Lanes rows wait for the overlap read, so a "shares" line never pushes rows down after they paint', () => {
  const ready = { feed: feed([mark('a', 'saved')]), lanes: [], queue: { entries: [] } };
  assert.equal(model.yardReady({ ...ready, shared: { view: undefined } }), false);
  const view = { lanes: [], paths: [], edits: [], complete: true };
  assert.equal(model.yardReady({ ...ready, shared: { view } }), true);
  assert.equal(
    model.yardReady({ ...ready, shared: { view: undefined, error: new Error('x') } }),
    true,
    'a failed overlap read still lets the rows draw (the yard then says it could not read them)',
  );
  assert.equal(model.yardReady(ready), true, "a view without the rows' shares does not wait for them");
});

test("f787005c: a row's shares line opens Who is touching what on that Lane's shared files", () => {
  const route = {
    frame: 'project',
    handle: 'mara',
    project: 'forge',
    place: 'lanes',
    section: 'touching',
    rest: '',
  };
  const href = model.laneFocusHref(hrefFor(route), 'a3cd248a-7ed4-4b01-8590-5e607ac26e75');
  const url = new URL(href, 'https://forge.test');
  const opened = parseAppPath(url.pathname);
  assert.equal(opened.place, 'lanes');
  assert.equal(opened.section, 'touching');
  assert.equal(opened.rest, '', 'the Touching view, never the placeholder a detail path opens');
  const focus = url.searchParams.get(model.LANE_FOCUS);
  assert.equal(focus, 'a3cd248a-7ed4-4b01-8590-5e607ac26e75');
  const files = [
    { path: 'x.ts', laneIds: ['a', focus] },
    { path: 'y.ts', laneIds: ['a', 'b'] },
  ];
  assert.deepEqual(
    model.filesOfLane(files, focus).map(file => file.path),
    ['x.ts'],
  );
  assert.deepEqual(model.filesOfLane(files, null), files, 'no Lane picked: every shared file');
  assert.deepEqual(model.filesOfLane(files, 'gone'), [], 'a Lane that landed since shares nothing now');
});

test('who waits on whom lists the longest wait first and names the Lane each queued Lane waits on', () => {
  const entries = [
    { position: 1, laneId: 'q1', phase: 'checking', submittedAt: '2026-11-17T10:00:00Z', lastProgressAt: '' },
    { position: 2, laneId: 'q2', phase: 'queued', submittedAt: '2026-11-17T10:01:00Z', lastProgressAt: '' },
    {
      position: null,
      laneId: 'h',
      phase: 'ready',
      submittedAt: '',
      lastProgressAt: '2026-11-17T10:30:00Z',
      hold: { kind: 'review', reason: '', paths: null },
    },
  ];
  const pairs = model.waits(entries, id => `T-${id}`);
  assert.deepEqual(
    pairs.map(pair => [pair.laneId, pair.on, pair.onLane, pair.person]),
    [
      ['q2', 'T-q1', 'q1', false],
      ['h', 'a person', null, true],
    ],
    'owner 2026-11-23: longest wait first; only a Lane target is an arrow between Lanes',
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
  // A dependency hold asks nobody (48049998): Held, never Needs you.
  assert.equal(row('d').band, 'held');
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

test('df06081d: History shows agent or person on every landing and filters to agents or to people', async () => {
  const f = readsFixture();
  const agent = run => ({
    actor: { id: 'mara', kind: 'agent' },
    agentRun: run,
    agentClient: 'claude-code:claude-opus-5-5',
  });
  f.accept(1, 'By hand', { who: { actor: { id: 'jon', kind: 'person' } } });
  f.accept(2, 'By an agent', { who: agent('amber-fox') });
  // A person approved an agent's protected change: the receipt names the approver, the stamp the builder.
  f.accept(3, 'Approved agent work', {
    who: { actor: { id: 'mara', kind: 'person' }, authorship: { kind: 'agent', actor: 'mara' } },
  });
  const kind = async value =>
    (await f.list('owner', 'recent', value ? { kind: value } : {})).rows.map(row => [
      row.sequence,
      row.agent,
    ]);
  assert.deepEqual(await kind(), [
    [3, true],
    [2, true],
    [1, false],
  ]);
  assert.deepEqual(await kind('agent'), [
    [3, true],
    [2, true],
  ]);
  assert.deepEqual(await kind('person'), [[1, false]]);
  assert.equal(
    model.historyEmpty(
      { rows: [], next: null, newest: null, started: false },
      { unread: false, by: null, item: null, kind: 'agent' },
    ),
    'no-match',
  );
  await assert.rejects(f.list('owner', 'recent', { kind: 'robot' }), /BAD_ARGUMENT|kind|Validator/);
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
      project: { handle: 'sample-owner', project: 'sample-project' },
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

test('History links published handles and runs and omits a withheld person for public readers', () => {
  const html = renderHistory(
    historyPage([
      historyRow(4),
      historyRow(3, { model: 'unknown' }),
      historyRow(2, { agent: false, agentRun: null, model: null, actor: 'jon' }),
      historyRow(1, { actor: null, agentRun: 'bold-finch', model: 'example-model' }),
    ]),
  );
  assert.match(
    html,
    /href="\/sample-owner\/sample-project\/lanes\/sessions\/mara\/amber-fox"[^>]*>amber-fox</,
  );
  assert.match(html, /href="\/mara"[^>]*>@mara</);
  assert.match(html, /href="\/jon"[^>]*>@jon</);
  assert.match(html, /model not declared/);
  assert.match(html, /<span class="a-run mono"[^>]*>bold-finch<\/span>/);
  assert.doesNotMatch(html, /href="[^"]*bold-finch/);
});

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
    kind: null,
  });
  assert.deepEqual(historyFilter(new URLSearchParams('')), {
    unread: false,
    by: null,
    item: null,
    kind: null,
  });
  assert.equal(historyFilter(new URLSearchParams('kind=agent')).kind, 'agent');
  assert.equal(historyFilter(new URLSearchParams('kind=robot')).kind, null);
});

test("a Lanes layout saved while it still had Landed today or Overlaps gives way to today's regions (f787005c)", () => {
  const now = { top: ['yard'], a: [], b: [] };
  assert.deepEqual(keptLayout({ top: ['yard'], a: ['overlaps'], b: ['landed'] }, now), now);
  assert.deepEqual(keptLayout({ top: ['yard', 'overlaps'], a: [], b: [] }, now), now);
  const moved = { top: [], a: ['yard'], b: [] };
  assert.deepEqual(keptLayout(moved, now), moved, 'a layout of the same regions is kept');
  assert.deepEqual(keptLayout(null, now), now);
});

test('9b9057a9: a saved Lane with an open conflict notice reads Conflict on its row, its Flow block and the legend, with whom and where on hover', async () => {
  // Owner 2026-11-23 10:45Z: the purple needs plain words, with whom, and a shared file alone must read differently.
  const flow = await import(moduleUrl('../web/src/app/flow/model.ts'));
  const { FlowLegend } = await import(moduleUrl('../web/src/app/flow/Checks.tsx'));
  const notes = [{ with: 'peer-lane', goal: 'Rework the queue', files: 3, path: 'src/queue.ts' }];
  const lanes = [
    mark('a', 'saved', { overlap: true }),
    mark('b', 'saved'),
    mark('c', 'checking', { overlap: true }),
  ];
  const yard = model.buildYard(
    feed(lanes),
    [
      { ...meta('a', 'Mine'), lastSaveAt: '2026-11-23T10:00:00Z', conflicts: notes },
      { ...meta('b', 'Shares only'), lastSaveAt: '2026-11-23T10:00:00Z' },
    ],
    undefined,
    0,
  );
  const row = id => yard.rows.find(entry => entry.laneId === id);
  assert.deepEqual(
    [row('a').glyph, row('a').why, row('a').tip],
    [
      'Conflict',
      'conflicts with Rework the queue in 3 files',
      'Conflicts with Rework the queue in 3 files: src/queue.ts…',
    ],
  );
  assert.deepEqual([row('b').glyph, row('b').tip], ['Working', null], 'a shared file alone is not marked');
  assert.equal(row('c').glyph, 'Checking', 'a queued Lane says its stop');
  const blocks = flow
    .flowStations(feed(lanes), [], new Map([['a', notes]]))
    .flatMap(station => station.blocks);
  const block = id => blocks.find(entry => entry.laneId === id);
  assert.deepEqual(
    [block('a').colour, block('a').shape, block('a').word, block('a').why],
    ['conflict', 'conflict', 'Conflict', 'Conflicts with Rework the queue in 3 files: src/queue.ts…'],
  );
  // A held Lane whose Needs you row says Conflict is purple with the notice's words, not the bare word.
  const heldBlock = flow
    .flowStations(
      feed([mark('a', 'saved', { held: true, overlap: true })]),
      [{ laneId: 'a', word: 'Conflict', tag: 'Conflict', head: 'Mine', who: null }],
      new Map([['a', notes]]),
    )
    .flatMap(station => station.blocks)[0];
  assert.deepEqual(
    [heldBlock.colour, heldBlock.why],
    ['conflict', 'Conflicts with Rework the queue in 3 files: src/queue.ts…'],
  );
  assert.equal(block('b').colour, 'active');
  // A saved Lane in conflict is drawn on its own but is not a hold: the Saved drawer counts no held Lane.
  const { laneDrawer } = await import(moduleUrl('../web/src/app/flow/drawer-model.ts'));
  assert.equal(laneDrawer(feed(lanes), [], 'saved', [], 0).held, 0);
  // Without the notice in hand the hover says what Conflict means.
  const bare = flow
    .flowStations(feed(lanes), [])
    .flatMap(station => station.blocks)
    .find(entry => entry.laneId === 'a');
  assert.match(bare.why, /^Conflict: this Lane’s changes clash with another Lane’s on the same lines/);
  // The legend says one word per look; the meaning is a hover (title), never text on the page (owner 2026-11-23 14:09Z).
  const legend = renderToStaticMarkup(h(FlowLegend));
  const shown = legend.replace(/ title="[^"]*"/g, '').replace(/<[^>]+>/g, '|');
  assert.deepEqual(shown.split('|').filter(Boolean), [
    'Working',
    'Waiting its turn',
    'Held',
    'Check failed',
    'Conflict',
  ]);
  assert.match(
    legend,
    /title="This Lane’s changes clash with another Lane’s on the same lines; one must be redone before both can land\. Lanes that only share a file/,
  );
});

test('9b9057a9: the Flow legend has an entry for every look the picture can draw, and none it cannot', async () => {
  // Owner 2026-11-23 14:35Z: the legend draws each distinct block look. It is checked against the one rule the picture
  // draws with (blockLook), over every input that rule takes, so adding a look without a legend entry fails here.
  const flow = await import(moduleUrl('../web/src/app/flow/model.ts'));
  const { stateWords } = await import(moduleUrl('../web/src/ds/marks.tsx'));
  const stages = ['editing', 'saved', 'queued', 'checking', 'ready'];
  const rows = [undefined, ...Object.keys(stateWords)];
  const drawn = new Set();
  for (const mainRed of [false, true])
    for (const held of [false, true])
      for (const conflict of [false, true])
        for (const stage of stages)
          for (const row of rows) {
            const { colour, shape } = flow.blockLook({ mainRed, held, conflict, stage, row });
            drawn.add(`${colour}/${shape}`);
          }
  assert.deepEqual(
    [...flow.looks.map(look => `${look.colour}/${look.shape}`)].sort(),
    [...drawn].sort(),
    'each drawn look has one legend entry and the legend lists no other',
  );
  assert.equal(new Set(flow.looks.map(look => look.word)).size, flow.looks.length, 'one word each');
  // And the picture's blocks use that same rule: a held Lane with no row is the hole, a plain queued Lane is not.
  const station = flow
    .flowStations(feed([mark('h', 'saved', { held: true }), mark('q', 'queued'), mark('w', 'editing')]), [])
    .flatMap(entry => entry.blocks);
  assert.deepEqual(station.map(block => `${block.colour}/${block.shape}`).sort(), [
    'active/',
    'waiting/',
    'waiting/waiting',
  ]);
});

test('e1633718: a parked Lane’s yard row says who it waits on and since when, with the parker’s reason under it', () => {
  const park = {
    to: 'sample-lead',
    named: true,
    reason: 'Waits for the bench window.',
    at: -45 * 60_000,
    by: 'sample-one/quiet-otter',
  };
  const yard = model.buildYard(
    feed([mark('a', 'saved'), mark('b', 'saved'), mark('c', 'editing', { overlap: true })]),
    [
      { ...meta('a', 'Parked work'), park },
      {
        ...meta('b', 'Nobody named'),
        park: { reason: 'Until the lead decides.', named: false, at: -5 * 60 * 60_000, by: 'mara' },
      },
      { ...meta('c', 'Conflicting'), park },
    ],
    undefined,
    0,
  );
  const row = id => yard.rows.find(entry => entry.laneId === id);
  assert.deepEqual(
    [row('a').why, row('a').detail],
    ['parked for @sample-lead 45 min ago', 'Waits for the bench window.'],
  );
  assert.deepEqual(
    [row('b').why, row('b').detail],
    ['parked, no one named 5 h ago', 'Until the lead decides.'],
  );
  assert.equal(
    row('c').why,
    'parked for @sample-lead 45 min ago',
    'an editing Lane has no saved head, so no conflict notice: the park is what it waits on (Item 9b9057a9)',
  );
  const hidden = model.buildYard(
    feed([mark('a', 'saved')]),
    [{ ...meta('a', 'Parked work'), park: { ...park, to: undefined } }],
    undefined,
    0,
  );
  assert.equal(
    hidden.rows[0].why,
    'parked for a member 45 min ago',
    'a name the reader may not see never reads as none',
  );
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

test('9b9057a9: the yard says Conflict only for a landing Forge observed ending in conflict; a shared file or a failed check is not one', () => {
  const ended = (laneId, cause) => ({
    ...meta(laneId, laneId),
    landing: { submissionId: `s-${laneId}`, state: 'terminal-failed', cause },
  });
  const yard = model.buildYard(
    feed([
      mark('c', 'saved', { held: true, overlap: false }),
      mark('f', 'saved', { held: true, overlap: true }),
      mark('s', 'saved', { overlap: true }),
    ]),
    [ended('c', 'conflict'), ended('f', 'check-failed'), meta('s', 'shares a file')],
    undefined,
    0,
  );
  const row = id => yard.rows.find(entry => entry.laneId === id);
  assert.equal(row('c').state, 'conflict', 'the observed cause is a conflict');
  assert.equal(
    row('f').state,
    'failed',
    'a failed check stays a failed check whatever the overlap flag says',
  );
  assert.notEqual(row('s').state, 'conflict', 'a saved Lane that only shares a file is no conflict');
});

test('incident replay 9b9057a9 (Lane 106d1da6): every Lane of a several-Lane review is under Needs you with its own approve word, not "Held · held"', () => {
  const lanes = [mark('rep', 'ready', { held: true }), mark('sib', 'ready', { held: true })];
  const needsRead = {
    held: [
      {
        laneId: 'rep',
        laneIds: ['rep', 'sib'],
        title: 'Licence',
        actor: 'mara',
        agent: null,
        why: 'review',
        note: null,
        submissionId: 's-1',
        attemptId: 'a-1',
        since: 0,
      },
    ],
    more: 0,
    moreIsLowerBound: false,
    approvals: '{}',
    canDecide: true,
  };
  const yard = model.buildYard(
    feed(lanes),
    [meta('rep', 'Licence'), meta('sib', 'Licence')],
    undefined,
    0,
    model.needsYouLanes(needsRead, 0),
  );
  assert.deepEqual(
    yard.rows.map(row => [row.laneId, row.band, row.word]),
    [
      ['rep', 'needs', 'Needs you'],
      ['sib', 'needs', 'Needs you'],
    ],
  );
});
