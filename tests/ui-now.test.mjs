// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const attention = await import(moduleUrl('../web/src/cockpit/attention.ts'));
const coordination = await import(moduleUrl('../web/src/cockpit/coordination.ts'));
const { NeedsYou } = await import(moduleUrl('../web/src/cockpit/NeedsYou.tsx'));
const overlap = await import(moduleUrl('../web/src/cockpit/overlap-model.ts'));
const nowModel = await import(moduleUrl('../web/src/cockpit/now-model.ts'));

const lane = (id, extra = {}) => ({
  id,
  name: id,
  head: 'h',
  intentId: 'i',
  intent: id,
  owner: '',
  byAgent: false,
  tone: 'active',
  label: 'Working',
  fact: '',
  conflicts: [],
  checkpoints: 1,
  open: true,
  ...extra,
});

test('only passed checks and conflicts on open Lanes ask the viewer for a decision', () => {
  const items = attention.laneDecisions([
    lane('ready', { tone: 'passed' }),
    lane('stuck', { tone: 'conflict', fact: 'Updating from main conflicts in a.ts' }),
    lane('failing', { tone: 'failed' }),
    lane('done', { tone: 'passed', open: false }),
  ]);
  assert.deepEqual(
    items.map(item => [item.kind, item.laneId]),
    [
      ['review', 'ready'],
      ['conflict', 'stuck'],
    ],
  );
});

test('overlaps name what will happen and offer one action', () => {
  const a = lane('a', { tone: 'passed' }),
    b = lane('b');
  const rows = overlap.overlapRows(
    [
      { lane: a, paths: [{ path: 'src/tax.ts', lines: [[40, 61]] }, { path: 'src/a.ts' }] },
      { lane: b, paths: [{ path: 'src/tax.ts', lines: [[48, 70]] }] },
    ],
    [
      { owner: 's1', label: 'codex-2', paths: ['convex/'], laneId: 'b', recipient: 's1' },
      { owner: 's2', label: 'claude-1', paths: ['convex/p.ts'] },
      { owner: 's2', label: 'claude-1', paths: ['convex/q.ts'] },
    ],
    [{ lane: b, paths: ['web/x.tsx', 'src/tax.ts'] }],
  );
  const byPath = Object.fromEntries(rows.map(row => [row.path, row]));
  assert.deepEqual(Object.keys(byPath), ['src/tax.ts', 'web/x.tsx', 'convex/p.ts', 'convex/q.ts']);
  const tax = byPath['src/tax.ts'];
  assert.equal(tax.kind, 'edited');
  assert.equal(tax.detail, 'edited by both · lines 40–61 and 48–70');
  assert.match(tax.meaning, /accepted second/);
  assert.equal(tax.action.laneId, 'b', 'the Lane further from acceptance is the one to compare');
  assert.equal(byPath['web/x.tsx'].kind, 'main');
  assert.equal(byPath['convex/p.ts'].action.tell.recipient, 's1');
  assert.equal(overlap.overlapRows([{ lane: a, paths: [{ path: 'x' }] }]).length, 0);
  assert.equal(overlap.overlapCounts(rows).get('a'), 1);
});

test('claims by the same session never overlap themselves', () => {
  const rows = overlap.overlapRows(
    [],
    [
      { owner: 's1', label: 'codex', paths: ['convex/a.ts'] },
      { owner: 's1', label: 'codex', paths: ['convex/a.ts', 'convex/b.ts'] },
      { owner: 's2', label: 'claude', paths: ['convex/'] },
    ],
  );
  assert.deepEqual(
    rows.map(row => row.path),
    ['convex/a.ts', 'convex/b.ts'],
  );
  assert.deepEqual(
    rows[0].who.map(who => who.label),
    ['codex', 'claude'],
  );
});

test('ready decisions carry their gates; conflicts name the file and who to hand it to', () => {
  const [ready, stuck] = attention.laneDecisions(
    [
      lane('ready', {
        tone: 'passed',
        intent: 'Mark merged',
        mainIncluded: true,
        changes: { add: 212, del: 38, files: 6 },
        startedBy: { kind: 'agent', name: 'claude-3' },
      }),
      lane('stuck', { tone: 'conflict', conflicts: ['scripts/check.mjs'], session: { name: 'codex-4' } }),
    ],
    new Map([['ready', 1]]),
  );
  assert.equal(ready.title, 'Mark merged');
  assert.equal(ready.subtitle, 'ready, claude-3');
  assert.deepEqual(ready.gates, { overlaps: 1, main: true });
  assert.equal(ready.hint, '6 files · +212 −38');
  assert.match(stuck.body, /scripts\/check\.mjs changed on main/);
  assert.equal(stuck.owner, 'codex-4');
});

test('accepted today is named by its Lanes, with who accepted it and the check time', () => {
  const now = Date.parse('2026-10-15T15:00:00');
  const rows = nowModel.acceptedSince(
    {
      moves: [
        {
          id: 'm1',
          channel: 'main',
          viewId: 'v1',
          at: '2026-10-15T14:00:00',
          status: 'accepted',
          acceptedBy: { name: 'claude-3' },
        },
        { id: 'm0', channel: 'main', viewId: 'v0', at: '2026-10-14T14:00:00', status: 'accepted' },
        {
          id: 'm2',
          channel: 'main',
          viewId: 'v2',
          at: '2026-10-15T13:00:00',
          actor: 'u1',
          automatic: { summary: 'Accepted', undo: 'Run x' },
        },
      ],
      views: [
        { id: 'v1', inputs: [{ laneId: 'l1' }] },
        { id: 'v2', inputs: [{ laneId: 'l2' }] },
      ],
      runs: [
        {
          viewId: 'v1',
          status: 'passed',
          startedAt: '2026-10-15T13:50:00Z',
          endedAt: '2026-10-15T13:51:50Z',
        },
      ],
      lanes: [
        { id: 'l1', name: 'merged-detection' },
        { id: 'l2', name: 'rename' },
      ],
      viewer: 'u1',
    },
    nowModel.startOfDay(now),
  );
  assert.deepEqual(
    rows.map(row => [row.title, row.by, row.automatic ? 'auto' : '']),
    [
      ['merged-detection', 'claude-3', ''],
      ['rename', 'you', 'auto'],
    ],
  );
  assert.equal(nowModel.duration(rows[0].checkMs), '1 m 50 s');
  const facts = nowModel.awayFacts(
    0,
    rows,
    [lane('x', { tone: 'passed', lastAt: '2026-10-15T12:00:00Z' })],
    [{ laneId: 'y', at: '2026-10-15T10:00:00Z', files: 18 }],
  );
  assert.deepEqual(
    facts.map(fact => fact.text),
    ['1 Lane accepted automatically', '1 accepted into main', '1 Lane updated from main · 18 files'],
  );
});

test('the local feed lists saves, checks and acceptances newest first within the window', () => {
  const items = attention.localFeed(
    {
      lanes: [
        {
          id: 'l',
          name: 'Lane L',
          checkpoints: [{ head: 'c1', message: 'save', at: '2026-10-14T10:00:00Z' }],
        },
      ],
      views: [{ id: 'v', inputs: [{ laneId: 'l' }] }],
      runs: [
        {
          id: 'r',
          viewId: 'v',
          status: 'failed',
          startedAt: '2026-10-14T10:01:00Z',
          check: { name: 'verify' },
        },
        { id: 'r2', viewId: 'v', status: 'running', startedAt: '2026-10-14T10:02:00Z' },
      ],
      channelMoves: [
        {
          id: 'm',
          channel: 'main',
          viewId: 'v',
          head: 'abcdef123',
          at: '2026-10-14T10:03:00Z',
          status: 'accepted',
        },
        {
          id: 'old',
          channel: 'main',
          viewId: 'v',
          head: 'x',
          at: '2026-10-10T10:03:00Z',
          status: 'accepted',
        },
      ],
    },
    Date.parse('2026-10-14T00:00:00Z'),
  );
  assert.deepEqual(
    items.map(item => item.text),
    ['Lane L · accepted into main', 'Lane L · check verify failed', 'Lane L · saved'],
  );
});

const session = (id, extra = {}) => ({
  sessionId: id,
  name: id,
  environment: 'Codex CLI',
  status: 'working',
  summary: '',
  context: {},
  lastSeen: 0,
  ...extra,
});
const event = (operationId, command, extra = {}) => ({ operationId, at: 1, actor: 'u', command, ...extra });

test('hosted decisions come from unacknowledged messages and handoffs addressed to the viewer', () => {
  const items = coordination.hostedDecisions(
    [
      event(
        'm1',
        { kind: 'message', sessionId: 's1', text: 'Rename lastSeen?', context: { laneId: 'l1' } },
        { recipientActor: 'me' },
      ),
      event('h1', {
        kind: 'handoff',
        sessionId: 's2',
        to: 'me',
        summary: 'Your turn',
        head: 'abc',
        laneId: 'l1',
      }),
      event('a1', { kind: 'ack', messageId: 'm0', text: 'ok' }),
    ],
    [session('s1', { name: 'codex-2' }), session('s2', { name: 'claude-1' })],
    [lane('l1', { name: 'heartbeat' })],
  );
  assert.deepEqual(
    items.map(item => [item.kind, item.title, item.quote.from, item.messageId]),
    [
      ['message', 'About heartbeat', 'codex-2', 'm1'],
      ['handoff', 'heartbeat', 'claude-1', 'h1'],
    ],
  );
});

test('Lanes show the freshest unfinished session reporting them, with quiet before folding after ninety minutes', () => {
  const now = 1_000_000;
  const [withLive, withStale, none] = coordination.withSessions(
    [lane('a'), lane('b'), lane('c')],
    [
      session('old', { context: { laneId: 'a' }, lastSeen: now - 60_000 }),
      session('new', { context: { laneId: 'a' }, lastSeen: now - 5_000 }),
      session('gone', { context: { laneId: 'b' }, lastSeen: now - 91 * 60_000 }),
      session('done', { context: { laneId: 'c' }, lastSeen: now, status: 'completed' }),
    ],
    now,
  );
  assert.equal(withLive.session.name, 'new');
  assert.equal(withLive.session.tone, 'active');
  assert.equal(withStale.session.tone, 'stale');
  assert.equal(none.session, undefined);
});

test('the hosted feed drops status chatter and acknowledgements', () => {
  const items = coordination.hostedFeed(
    [
      event('x', {
        kind: 'activity',
        sessionId: 's',
        sequence: 1,
        name: 'n',
        environment: 'e',
        status: 'working',
        summary: '',
        context: {},
      }),
      event('y', { kind: 'ack', messageId: 'm', text: 'ok' }),
      event('z', { kind: 'change', source: 'work', action: 'accept', head: 'abcdef1234567', laneId: 'l' }),
    ],
    [],
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].laneId, 'l');
  assert.match(items[0].text, /accept/);
});

test('every decision ends with its answers, and an empty panel says so calmly', () => {
  const html = renderToStaticMarkup(
    h(NeedsYou, {
      now: 0,
      items: [
        { id: '1', kind: 'review', title: 'One', gates: { overlaps: 0, main: true }, hint: '1 file · +1 −0' },
        {
          id: '2',
          kind: 'message',
          question: true,
          title: 'Two',
          quote: { from: 'codex-2', text: 'Rename?' },
        },
      ],
      answers: item => h('button', null, `answer ${item.title}`),
    }),
  );
  assert.match(html, /includes main/);
  assert.match(html, /no overlaps/);
  assert.match(html, />Question</);
  assert.equal((html.match(/answer /g) ?? []).length, 2);
  assert.match(
    renderToStaticMarkup(
      h(NeedsYou, { now: 0, items: [], answers: () => null, quiet: '4 agents are working.' }),
    ),
    /Nothing needs you\.[\s\S]*4 agents are working/,
  );
});

test('offered choices become one-click answers', () => {
  const [item] = coordination.hostedDecisions(
    [
      event(
        'm1',
        {
          kind: 'message',
          sessionId: 's1',
          text: 'Rename it?',
          choices: ['Yes, rename it', 'Keep lastSeen'],
          context: {},
        },
        { recipientActor: 'me' },
      ),
    ],
    [session('s1', { name: 'codex-2' })],
    [],
  );
  assert.deepEqual(item.choices, ['Yes, rename it', 'Keep lastSeen']);
  assert.equal(item.question, true);
});

test('questions are answered by replying to the sending session; changes lead with their Lane', () => {
  const [item] = coordination.hostedDecisions(
    [
      event(
        'm1',
        { kind: 'message', sessionId: 's1', text: 'Keep the name?', context: {} },
        { recipientActor: 'me' },
      ),
    ],
    [session('s1', { name: 'codex-2' })],
    [],
  );
  assert.equal(item.replyTo, 's1');
  assert.equal(item.question, true);
  const [noSession] = coordination.hostedDecisions(
    [event('m2', { kind: 'message', text: 'FYI', context: {} }, { actor: 'maya', recipientActor: 'me' })],
    [],
    [],
  );
  assert.equal(noSession.replyTo, 'maya');
  assert.equal(noSession.question, false);
  const [change] = coordination.hostedFeed(
    [
      event('c', {
        kind: 'change',
        source: 'work',
        action: 'check failed',
        laneId: 'l',
        head: 'abcdef1234',
        pathCount: 2,
      }),
    ],
    [],
    [{ id: 'l', name: 'inbox-acks' }],
  );
  assert.equal(change.text, 'inbox-acks · check failed · 2 files');
  assert.equal(change.detail, 'abcdef1');
  assert.doesNotMatch(change.text, /Related change/);
});

test('hosted Lanes without line counts show the file count of their latest change event', () => {
  const [a, b] = coordination.withChangedFiles(
    [lane('a'), lane('b', { changes: { add: 1, del: 0, files: 1 } })],
    [
      event('new', { kind: 'change', source: 'exchange', laneId: 'a', pathCount: 3 }),
      event('old', { kind: 'change', source: 'exchange', laneId: 'a', pathCount: 9 }),
      event('b', { kind: 'change', source: 'exchange', laneId: 'b', pathCount: 5 }),
    ],
  );
  assert.deepEqual(a.changes, { files: 3 });
  assert.deepEqual(b.changes, { add: 1, del: 0, files: 1 });
});

test('acceptance groups keep Intent identity; Accepted lists each acceptance as a row', async () => {
  const rows = nowModel.acceptedSince(
    {
      moves: [
        { id: 'old', channel: 'main', viewId: 'v1', at: '2026-10-15T10:00:00Z' },
        { id: 'new', channel: 'main', viewId: 'v2', at: '2026-10-15T12:00:00Z' },
        { id: 'other', channel: 'main', viewId: 'v3', at: '2026-10-15T11:00:00Z' },
        { id: 'unknown', channel: 'main', viewId: 'missing', at: '2026-10-15T09:00:00Z' },
      ],
      views: [
        { id: 'v1', intentId: 'i', inputs: [{ laneId: 'a' }] },
        { id: 'v2', intentId: 'i', inputs: [{ laneId: 'b' }] },
        { id: 'v3', intentId: 'other' },
      ],
      lanes: [
        { id: 'a', name: 'First Lane' },
        { id: 'b', name: 'Second Lane' },
      ],
      intents: [
        { id: 'i', outcome: 'Cockpit UI rebuild' },
        { id: 'other', outcome: 'Cockpit UI rebuild' },
      ],
      runs: [],
    },
    0,
  );
  const groups = nowModel.acceptanceGroups(rows);
  assert.equal(groups.length, 3, 'same titles never merge distinct Intents');
  assert.equal(groups[0].title, 'Cockpit UI rebuild');
  assert.equal(groups[0].latest.at, '2026-10-15T12:00:00Z');
  assert.deepEqual(
    groups[0].acceptances.map(row => row.id),
    ['new', 'old'],
  );
  const { Ledger } = await import(moduleUrl('../web/src/cockpit/Ledger.tsx'));
  const html = renderToStaticMarkup(
    h(Ledger, { rows, now: Date.parse('2026-10-15T13:00:00Z'), laneHref: id => `/lane/${id}` }),
  );
  assert.doesNotMatch(html, /<details/, 'Accepted lists every acceptance as its own row');
  assert.equal((html.match(/class="fx-ledger-r"/g) ?? []).length, 4);
  assert.match(html, /href="\/lane\/a"/);
  assert.match(html, /href="\/lane\/b"/);
  assert.match(html, /Candidate of 1 Lane/);
});

test('main strip joins the indexed Channel selection to its acceptance receipt', async () => {
  const { latestAcceptedMain } = await import(moduleUrl('../web/src/shell/main-model.ts'));
  const hosted = {
    id: 'hosted',
    channel: 'main',
    head: 'old',
    viewId: 'old-view',
    at: '2026-10-12T10:00:00Z',
  };
  const pushed = {
    id: 'pushed',
    channel: 'main',
    status: 'accepted',
    head: 'new',
    viewId: 'new-view',
    at: '2026-10-15T10:00:00Z',
  };
  const pending = { ...pushed, id: 'pending', status: 'pending', at: '2026-10-15T11:00:00Z' };
  const other = { ...pushed, channel: 'release', at: '2026-10-15T12:00:00Z' };
  assert.equal(latestAcceptedMain([pushed, pending, other, hosted], { head: 'new' }), pushed);
  assert.equal(latestAcceptedMain([hosted]), hosted);
  assert.equal(latestAcceptedMain([]), undefined);
  const newerHosted = { ...hosted, at: '2026-10-15T13:00:00Z' };
  assert.equal(latestAcceptedMain([pushed, newerHosted]), newerHosted);
});

test('a hosted selection of an imported acceptance appears once in the ledger', () => {
  const local = [
    { id: 'a', channel: 'main', at: '2026-10-14', viewId: 'v' },
    { id: 'b', channel: 'main', at: '2026-10-15', viewId: 'v2' },
  ];
  const hosted = [{ id: 'h', acceptanceId: 'a', channel: 'main', at: '2026-10-14', viewId: 'v' }];
  assert.deepEqual(
    nowModel.publishedMoves(local, hosted).map(move => move.id),
    ['a', 'b'],
  );
});

test('What changing lists every open Lane by attention with one fold and no accepted-today link', async () => {
  const { LaneList } = await import(moduleUrl('../web/src/cockpit/LaneList.tsx'));
  const now = Date.now();
  const lanes = [
    lane('working-1', { lastAt: new Date(now - 60_000).toISOString() }),
    lane('quiet', { checkpoints: 0 }),
    lane('review-me', { tone: 'passed', label: 'Ready' }),
    lane('conflicted', { tone: 'conflict', label: 'Conflict' }),
    lane('working-2'),
    lane('waiting', { tone: 'waiting', label: 'Waiting' }),
    lane('working-3'),
  ];
  const html = renderToStaticMarkup(h(LaneList, { lanes, now, href: l => `/${l.id}` }));
  const order = [...html.matchAll(/class="fx-row-lane" href="\/([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(order.slice(0, 3), ['conflicted', 'review-me', 'waiting']);
  assert.equal(order.length, 5);
  assert.match(html, /7 in motion/);
  assert.match(html, /2 more Lanes<\/b><span class="fx-faint">· 2 working<\/span>/);
  assert.match(html, /no saves/, 'a Lane with no saves is an ordinary row');
  assert.doesNotMatch(html, /accepted today|no saved changes|waiting for you →|Unassigned/);
});

test('historical failed checks are muted only within their H17 family and link to the later Candidate', async () => {
  const { checkMeaning } = await import(moduleUrl('../web/src/cockpit/check-meaning.ts'));
  const views = [
    { id: 'old', intentId: 'i', at: '2026-10-15T12:00:00Z', inputs: [{ laneId: 'a' }, { laneId: 'b' }] },
    { id: 'new', intentId: 'i', at: '2026-10-15T13:00:00Z', inputs: [{ laneId: 'b' }, { laneId: 'a' }] },
  ];
  const records = { views, runs: [{ viewId: 'new', status: 'passed' }] };
  assert.deepEqual(checkMeaning(records, 'old', 'failed'), {
    tone: 'plain',
    glyph: 'plain',
    label: 'Check failed · fixed in a later Candidate (passed)',
    laterViewId: 'new',
  });
  assert.equal(checkMeaning(records, 'new', 'failed').tone, 'failed');
  views[1].inputs = [{ laneId: 'c' }];
  assert.equal(checkMeaning(records, 'old', 'failed').tone, 'failed');
  views[1].inputs = views[0].inputs;
  records.runs[0].status = 'cancelled';
  assert.doesNotMatch(checkMeaning(records, 'old', 'failed').label, /fixed|passed/);
});

test('Activity keeps pending messages in Needs you and deduplicates multi-Lane check events', async () => {
  const { activityItems } = await import(moduleUrl('../web/src/cockpit/activity-model.ts'));
  const records = {
    lanes: [
      { id: 'a', name: 'A', checkpoints: [] },
      { id: 'b', name: 'B', checkpoints: [] },
    ],
    views: [
      { id: 'v', intentId: 'i', at: '2026-10-15T12:00:00Z', inputs: [{ laneId: 'a' }, { laneId: 'b' }] },
    ],
    runs: [{ id: 'r', viewId: 'v', status: 'cancelled', startedAt: '2026-10-15T12:01:00Z' }],
  };
  const items = activityItems(
    records,
    [],
    [{ messageId: 'pending' }],
    [
      { id: 'pending', at: '2026-10-15T12:02:00Z', glyph: 'message', text: 'Open question' },
      { id: 'answered', at: '2026-10-15T12:03:00Z', glyph: 'message', text: 'Answered question' },
    ],
  );
  assert.deepEqual(
    items.map(item => item.id),
    ['answered', 'run:r'],
  );
  assert.equal(items[1].tone, 'plain');
  assert.equal(items[1].glyph, 'check');
});

test('a Lane pinned to an earlier failed Candidate never presents that superseded failure as current', async () => {
  const { cockpitLanes } = await import(moduleUrl('../web/src/cockpit/model.ts'));
  const [result] = cockpitLanes({
    intents: [{ id: 'i', outcome: 'Outcome' }],
    lanes: [
      {
        id: 'l',
        intentId: 'i',
        name: 'Earlier head',
        head: 'old-head',
        base: 'base',
        state: 'active',
        assignment: '',
        checkpoints: [],
      },
    ],
    views: [
      {
        id: 'old',
        intentId: 'i',
        base: 'base',
        head: 'old-view',
        status: 'clean',
        at: '2026-10-15T12:00:00Z',
        inputs: [{ laneId: 'l', head: 'old-head' }],
      },
      {
        id: 'new',
        intentId: 'i',
        base: 'base',
        head: 'new-view',
        status: 'clean',
        at: '2026-10-15T13:00:00Z',
        inputs: [{ laneId: 'l', head: 'new-head' }],
      },
    ],
    runs: [
      { id: 'r-old', viewId: 'old', status: 'failed' },
      { id: 'r-new', viewId: 'new', status: 'passed' },
    ],
  });
  assert.equal(result.tone, 'plain');
  assert.equal(result.laterViewId, 'new');
  assert.equal(result.fact, 'Check failed · fixed in a later Candidate (passed)');
});

test('Now actors prefer the session name and hide unknown automatic workflow actors', async () => {
  const { LaneRow } = await import(moduleUrl('../web/src/cockpit/LaneRow.tsx'));
  const render = extra =>
    renderToStaticMarkup(
      h(LaneRow, {
        lane: lane('actor', {
          byAgent: true,
          startedBy: { kind: 'agent', name: 'Agent workflow' },
          ...extra,
        }),
        now: 1000,
        href: '/lane/actor',
      }),
    );
  const fallback = render({});
  assert.match(fallback, /class="fx-row-who"><\/div>/);
  assert.doesNotMatch(fallback, /Agent workflow|fx-agent-tag/);
  assert.match(
    render({ session: { name: 'gpt-u1', tone: 'active', lastSeen: 1000 } }),
    /title="gpt-u1">gpt-u1<\/span>/,
  );
  assert.match(render({ startedBy: { kind: 'agent', name: 'gpt-u8' } }), /title="gpt-u8">gpt-u8<\/span>/);
  assert.match(render({ startedBy: undefined }), /class="fx-row-who"><\/div>/);
});

test('Accepted rows show who accepted with auto, the check with its duration, diff and an Undo hint today', async () => {
  const { Ledger } = await import(moduleUrl('../web/src/cockpit/Ledger.tsx'));
  const now = Date.parse('2026-10-15T13:00:00Z');
  const html = renderToStaticMarkup(
    h(Ledger, {
      rows: [
        {
          id: 'a',
          viewId: 'v',
          title: 'Fix the layout',
          intentId: 'i',
          intentTitle: 'Layout outcome',
          at: new Date(now - 3_600_000).toISOString(),
          by: 'Agent workflow',
          checkMs: 337000,
          checkName: 'verify',
          laneCount: 2,
          diff: { add: 42, del: 3 },
          automatic: {
            summary: 'Accepted under project autonomy',
            undo: 'Select an earlier View to roll back',
          },
        },
      ],
      now,
      laneHref: id => `/lane/${id}`,
      viewHref: id => `/view/${id}`,
      historyHref: '/activity',
    }),
  );
  assert.match(html, /What landed on main[\s\S]*Intent[\s\S]*Who accepted[\s\S]*Check[\s\S]*Diff[\s\S]*When/);
  assert.match(html, /<b>Today<\/b> · 1/);
  assert.match(html, /href="\/view\/v">Fix the layout/);
  assert.match(html, /Candidate of 2 Lanes/);
  assert.match(html, />Undo</);
  assert.match(html, /Select an earlier View to roll back/);
  assert.match(html, /Layout outcome/);
  assert.match(html, /fx-auto/);
  assert.match(html, /verify · 5 m 37 s/);
  assert.match(html, /\+42/);
  assert.match(html, /1 today/);
  assert.match(html, /href="\/activity">Full history/);
  assert.match(
    html,
    /title="Agent workflow\. Accepted under project autonomy\. Select an earlier View to roll back"/,
  );
});

test('Now check names ending in failed never duplicate the failure verb', async () => {
  const { cockpitLanes } = await import(moduleUrl('../web/src/cockpit/model.ts'));
  const records = {
    intents: [{ id: 'i', outcome: 'Fix it' }],
    lanes: [
      { id: 'l', intentId: 'i', name: 'Fix it', head: 'h', base: 'b', state: 'active', checkpoints: [] },
    ],
    views: [
      {
        id: 'v',
        intentId: 'i',
        head: 'h',
        base: 'b',
        status: 'ready',
        at: '2026-10-15T12:00:00Z',
        inputs: [{ laneId: 'l', head: 'h' }],
      },
    ],
    runs: [{ id: 'r', viewId: 'v', status: 'failed', checkName: 'X failed', exitCode: 1 }],
  };
  const [result] = cockpitLanes(records);
  assert.equal(result.fact, 'X failed · exit 1 · nobody’s on it');
  assert.doesNotMatch(result.fact, /failed failed/);
  delete records.runs[0].checkName;
  assert.equal(cockpitLanes(records)[0].fact, 'Check failed · exit 1 · nobody’s on it');
  const [attached] = coordination.withSessions(
    cockpitLanes(records),
    [session('fixer', { context: { laneId: 'l' } })],
    Date.now(),
  );
  assert.equal(attached.fact, 'Check failed · exit 1');
  records.lanes[0].startedBy = { kind: 'agent', name: 'Agent' };
  assert.equal(cockpitLanes(records)[0].fact, 'Check failed · exit 1');
});

test('messages fold by Lane or Intent with latest answers and all earlier acknowledgement ids', () => {
  const items = [
    { id: 'a', kind: 'message', laneId: 'l', messageId: 'a', at: 1, title: 'old' },
    { id: 'b', kind: 'message', laneId: 'l', messageId: 'b', at: 3, title: 'latest', question: true },
    { id: 'c', kind: 'message', laneId: 'l', messageId: 'c', at: 2, title: 'middle' },
    { id: 'd', kind: 'handoff', laneId: 'l', at: 4, title: 'handoff' },
    { id: 'e', kind: 'message', intentId: 'i', at: 1, title: 'intent' },
    { id: 'f', kind: 'message', intentId: 'i', at: 2, title: 'intent latest' },
  ];
  const grouped = attention.groupDecisions(items);
  assert.equal(grouped.length, 3);
  assert.equal(grouped[0].id, 'b');
  assert.deepEqual(
    grouped[0].earlier.map(item => item.messageId),
    ['c', 'a'],
  );
  assert.equal(grouped[0].question, true);
  assert.equal(attention.groupDecisions(items.filter(item => item.id !== 'b'))[0].id, 'c');
  assert.equal(attention.groupDecisions(items.filter(item => !['a', 'b', 'c'].includes(item.id))).length, 2);
  const html = renderToStaticMarkup(h(NeedsYou, { items, now: 10, answers: () => null }));
  assert.match(html, /\+2 earlier/);
  assert.equal((html.match(/fx-dec-title/g) ?? []).length, 3);
});

test('automatic workflow observations cannot replace a named agent or inflate the people count', async () => {
  const { sessionTreeRows } = await import(moduleUrl('../web/src/cockpit/session-tree.ts'));
  const now = 10000000;
  const sessions = [
    session('real', { name: 'gpt-b5', lastSeen: now - 1000, context: { laneId: 'a' } }),
    session('auto', { name: 'Agent workflow', lastSeen: now, context: { laneId: 'a' } }),
    session('ended', { name: 'gpt-done', lastSeen: now, context: { laneId: 'done' } }),
    session('stale', { name: 'old', lastSeen: now - 100 * 60000 }),
  ];
  assert.equal(coordination.withSessions([lane('a')], sessions, now)[0].session.name, 'gpt-b5');
  const facts = nowModel.workingFacts(sessions, { activeAgents: 99 }, now, ['done']);
  assert.equal(facts.total, sessionTreeRows(sessions, now, false, ['done']).listed);
  assert.equal(facts.total, 1);
});

test('quiet Now panels have short text and no empty icon tiles or in-motion badge', async () => {
  const { LaneList } = await import(moduleUrl('../web/src/cockpit/LaneList.tsx'));
  const html = renderToStaticMarkup(h(LaneList, { lanes: [], now: 1, href: () => '#' }));
  assert.match(html, /No work in motion\./);
  assert.doesNotMatch(html, /fx-empty|0 in motion/);
});

test('Accepted shows five of today, folds the rest and keeps earlier days as collapsed bands', async () => {
  const { Ledger } = await import(moduleUrl('../web/src/cockpit/Ledger.tsx'));
  const now = new Date(2026, 9, 15, 18, 0).getTime();
  const rows = [
    ...Array.from({ length: 8 }, (_, n) => ({
      id: `a${n}`,
      intentId: `i${n}`,
      title: `Outcome ${n}`,
      viewId: `v${n}`,
      at: new Date(2026, 9, 15, 12, n).toISOString(),
      diff: { add: 10, del: 1 },
    })),
    { id: 'y', title: 'Yesterday work', viewId: 'vy', at: new Date(2026, 9, 14, 9).toISOString() },
  ];
  const html = renderToStaticMarkup(h(Ledger, { rows, now, laneHref: () => '#', historyHref: '/activity' }));
  assert.equal((html.match(/class="fx-ledger-r"/g) ?? []).length, 5);
  assert.match(html, /3 more today/);
  assert.match(html, /<b>Today<\/b> · 8[\s\S]*\+80[\s\S]*8 Intents/);
  assert.match(html, /<b>Yesterday<\/b> · 1[\s\S]*aria-expanded="false">Show</);
  assert.doesNotMatch(html, /Yesterday work/);
  assert.match(html, /8 today/);
});

test('Acknowledge all stops at a failed receipt and retry sends only remaining messages', async () => {
  const { acknowledgeMessages } = await import(moduleUrl('../web/src/cockpit/HostedAnswers.tsx'));
  const receipts = [];
  const acknowledge = async id => {
    receipts.push(id);
    return id !== 'failed';
  };
  assert.equal(await acknowledgeMessages(['latest', 'failed', 'oldest'], acknowledge), false);
  assert.deepEqual(receipts, ['latest', 'failed']);
  const retried = [];
  assert.equal(
    await acknowledgeMessages(['failed', 'oldest'], async id => {
      retried.push(id);
      return true;
    }),
    true,
  );
  assert.deepEqual(retried, ['failed', 'oldest']);
});

test('a quiet established project stays calm while first-run guidance is explicit', async () => {
  const { NowSituation } = await import(moduleUrl('../web/src/cockpit/NowLayout.tsx'));
  const facts = { decisions: 0, open: 0, stopped: 0, overlaps: 0 };
  const quiet = renderToStaticMarkup(h(NowSituation, { facts }));
  assert.match(quiet, /Nothing needs you/);
  assert.doesNotMatch(quiet, /Start with/);
  assert.match(renderToStaticMarkup(h(NowSituation, { facts, firstRun: true })), /Start with one Intent/);
});

test('broadcasts stay in Activity and direct messages show their title sentence only once', () => {
  const message = event(
    'broadcast',
    {
      kind: 'message',
      sessionId: 's1',
      text: 'Ready for review. Three checks passed.',
      context: {},
    },
    { actorDisplayName: 'Owner' },
  );
  const sessions = [session('s1', { name: 'gpt-qa-a', kind: 'agent' })];
  assert.deepEqual(coordination.hostedDecisions([message], sessions, []), []);
  assert.equal(coordination.hostedFeed([message], sessions)[0].text, 'gpt-qa-a → everyone');
  const [item] = coordination.hostedDecisions([{ ...message, recipientActor: 'me' }], sessions, []);
  assert.equal(item.title, 'Ready for review.');
  assert.equal(item.quote.text, 'Three checks passed.');
  assert.deepEqual(item.sender, { name: 'gpt-qa-a', agent: true });
  const html = renderToStaticMarkup(h(NeedsYou, { items: [item], now: 10, answers: () => null }));
  assert.equal((html.match(/>Ready for review\.</g) ?? []).length, 1);
  assert.match(html, /Three checks passed/);
  const [single] = coordination.hostedDecisions(
    [
      {
        ...message,
        recipientActor: 'me',
        command: { ...message.command, text: 'Keep this name?' },
      },
    ],
    sessions,
    [],
  );
  assert.equal(single.quote.text, '');
  assert.doesNotMatch(
    renderToStaticMarkup(h(NeedsYou, { items: [single], now: 10, answers: () => null })),
    /fx-quote/,
  );
});

test('declared agent senders survive shared account credentials and nested sessions', async () => {
  const { activityAuthor } = await import(moduleUrl('../web/src/coordination-view.ts'));
  const message = event(
    'm',
    { kind: 'message', text: 'gpt-s1: Ready for review.', context: {} },
    { actorDisplayName: 'Owner', recipientActor: 'me' },
  );
  assert.equal(activityAuthor(message, []), 'gpt-s1');
  assert.deepEqual(coordination.hostedDecisions([message], [], [])[0].sender, {
    name: 'gpt-s1',
    agent: true,
  });
  const nested = [session('parent', { subagents: [session('child', { name: 'named-child' })] })];
  assert.equal(
    activityAuthor({ ...message, command: { ...message.command, sessionId: 'child' } }, nested),
    'named-child',
  );
  assert.equal(
    activityAuthor({ ...message, command: { kind: 'activity', name: 'gpt-announced' } }, []),
    'gpt-announced',
  );
});

test('native header selection ignores the historical hosted selection and preserves Git selections', async () => {
  const { selectedMain, latestAcceptedMain } = await import(moduleUrl('../web/src/shell/main-model.ts'));
  const native = { name: 'main', head: 'new', moveId: 'native' };
  const hosted = { id: 'hosted', channel: 'main', head: 'old', viewId: 'old-view', at: '2026-10-12' };
  assert.equal(selectedMain([native], [hosted], 'native'), native);
  assert.equal(selectedMain([native], [hosted], 'git'), hosted);
  assert.equal(selectedMain([], [hosted], 'native'), hosted);
  const move = {
    id: 'native',
    channel: 'main',
    status: 'accepted',
    head: 'new',
    viewId: 'new-view',
    at: '2026-10-16',
    acceptedBy: { name: 'Agent workflow' },
  };
  assert.equal(latestAcceptedMain([hosted, move], selectedMain([native], [hosted], 'native')), move);
});

test('Work reference chips resolve full ids and unique prefixes, without guessing ambiguous or unknown records', async () => {
  const { referenceParts, WorkText, WorkReferenceContext } = await import(
    moduleUrl('../web/src/cockpit/WorkReferences.tsx')
  );
  const laneId = '8392ffa1-acff-473e-900d-f838ff163afa';
  const refs = [
    { id: laneId, kind: 'Lane', name: 'Native acceptance', href: '/lanes/native' },
    {
      id: 'c3a91839-1234-4567-8901-123456789abc',
      kind: 'Intent',
      name: 'Review UI',
      href: '/intents/review',
    },
    { id: '1a2b3c4d-1234-4567-8901-123456789abc', kind: 'Candidate', name: '', href: '/views/candidate' },
  ];
  const text = `Lane ${laneId}, Intent c3a91839 and View 1a2b3c4d1234. Also 8392ffa1-acff.`;
  const parts = referenceParts(text, refs).filter(part => typeof part !== 'string');
  assert.deepEqual(
    parts.map(part => part.reference?.href),
    ['/lanes/native', '/intents/review', '/views/candidate', '/lanes/native'],
  );
  const html = renderToStaticMarkup(h(WorkReferenceContext.Provider, { value: refs }, h(WorkText, { text })));
  assert.match(html, /href="\/lanes\/native"/);
  assert.match(html, /Native acceptance/);
  assert.match(html, /Candidate 1a2b3c4d/);
  // Older messages still say View; the chip resolves to the same Candidate.
  assert.equal(referenceParts('Candidate 1a2b3c4d', refs)[1].reference?.href, '/views/candidate');
  const ambiguous = referenceParts('Lane 8392ffa1', [
    ...refs,
    { ...refs[0], id: '8392ffa1-0000-0000-0000-000000000000' },
  ]);
  assert.equal(ambiguous.find(part => typeof part !== 'string').reference, undefined);
  const truncated = referenceParts('Lane 8392ffa1-acff-…', refs);
  assert.equal(truncated.find(part => typeof part !== 'string').reference.href, '/lanes/native');
  assert.equal(truncated.at(-1), '');
  const unknown = renderToStaticMarkup(h(WorkText, { text: 'Lane 00000000-1111-2222-3333-444444444444' }));
  assert.match(unknown, /Lane 00000000/);
  assert.doesNotMatch(unknown, /<a /);
});

test('light metadata text meets AA against every light neutral surface', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../web/src/ui/tokens.css', import.meta.url), 'utf8');
  const light = css.split(":root[data-theme='dark']")[0];
  const token = name => light.match(new RegExp(`--fx-${name}: (#[0-9a-f]{6})`))[1];
  const luminance = color =>
    color
      .slice(1)
      .match(/../g)
      .map(hex => parseInt(hex, 16) / 255)
      .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index], 0);
  const foreground = luminance(token('text-3'));
  for (const surface of ['bg', 'surface', 'surface-2', 'surface-3', 'hover']) {
    const background = luminance(token(surface));
    assert.ok((background + 0.05) / (foreground + 0.05) >= 4.5, surface);
  }
});

test('session activity renders named Work links instead of raw ids', async () => {
  const { Sessions } = await import(moduleUrl('../web/src/cockpit/Sessions.tsx'));
  const { WorkReferenceContext } = await import(moduleUrl('../web/src/cockpit/WorkReferences.tsx'));
  const id = '8392ffa1-acff-473e-900d-f838ff163afa';
  const html = renderToStaticMarkup(
    h(
      WorkReferenceContext.Provider,
      { value: [{ id, kind: 'Lane', name: 'Native acceptance', href: '/lanes/native' }] },
      h(Sessions, {
        sessions: [session('s1', { name: 'gpt-u10', lastSeen: 1000, summary: `Reviewing Lane ${id}` })],
        now: 1000,
        laneName: () => undefined,
      }),
    ),
  );
  assert.match(html, /href="\/lanes\/native"/);
  assert.match(html, /Native acceptance/);
  assert.doesNotMatch(html, new RegExp(`>${id}<`));
});

test('failed main audit stays in Needs you after completion and until a newer pass', () => {
  const failed = {
    id: 'failed-main',
    viewId: 'main-view',
    status: 'failed',
    startedAt: '2026-10-15T10:00:00Z',
    endedAt: '2026-10-15T10:01:00Z',
    mainCheck: { channel: 'main' },
    failureSummary: 'synthetic verify failure',
  };
  const item = attention.mainCheckDecisions([failed])[0];
  assert.equal(item.runId, 'failed-main');
  assert.equal(item.viewId, 'main-view');
  assert.equal(item.kind, 'failed');
  assert.match(item.title, /main full check failed after acceptance/);
  assert.match(item.body, /synthetic verify failure/);
  assert.match(item.body, /Fix main Intent's agent prompt/);
  assert.match(item.body, /Fix forward from current main/);
  const running = { ...failed, id: 'later-main', status: 'running', startedAt: '2026-10-15T11:00:00Z' };
  assert.equal(attention.mainCheckDecisions([failed, running]).length, 1);
  assert.equal(attention.mainCheckDecisions([failed, { ...running, status: 'passed' }]).length, 0);
});

test('Accepted today names pinned View dependencies without guessing mismatched heads', () => {
  const input = {
    moves: [
      { id: 'm', channel: 'main', viewId: 'combined', at: '2026-10-16', acceptedBy: { name: 'gpt-c1' } },
    ],
    views: [
      { id: 'combined', dependencies: [{ kind: 'view', viewId: 'v', head: 'h' }] },
      { id: 'v', head: 'h', inputs: [{ laneId: 'l' }] },
    ],
    lanes: [{ id: 'l', name: 'Scope-aware checks' }],
    runs: [],
  };
  assert.equal(nowModel.acceptedSince(input, 0)[0].title, 'Scope-aware checks');
  input.views[1].head = 'different';
  assert.equal(nowModel.acceptedSince(input, 0)[0].title, 'Accepted change');
});

test('mobile Now uses compact decision and movement counts', async () => {
  const { NowSituation } = await import(moduleUrl('../web/src/cockpit/NowLayout.tsx'));
  const html = renderToStaticMarkup(
    h(NowSituation, {
      facts: {
        decisions: 3,
        open: 13,
        stopped: 0,
        overlaps: 0,
        working: { total: 1, agents: 1, people: [] },
      },
    }),
  );
  assert.match(html, /fx-now-mobile-situation[\s\S]*3 need you[\s\S]*13 in motion/);
});

test('hosted accepted work waits for paged titles instead of flashing generic acceptance rows', async () => {
  const { HostedNowView } = await import(moduleUrl('../web/src/cockpit/HostedNow.tsx'));
  const now = Date.now();
  const html = renderToStaticMarkup(
    h(HostedNowView, {
      now,
      records: {
        intents: [{ id: 'i', outcome: 'Outcome' }],
        lanes: [],
        views: [],
        runs: [],
        channelMoves: [{ id: 'm', channel: 'main', viewId: 'v', at: new Date(now).toISOString() }],
      },
      live: { sessions: [], events: [], unacked: [], claims: [], sessionsLoading: false },
      loading: true,
      ack: { busy: '', error: '', retrying: () => false },
      newIntent: () => {},
    }),
  );
  assert.match(html, /Reading accepted work/);
  assert.doesNotMatch(html, /Accepted change/);
  const resolved = renderToStaticMarkup(
    h(HostedNowView, {
      now,
      records: {
        intents: [{ id: 'i', outcome: 'Resolved outcome' }],
        lanes: [],
        views: [{ id: 'v', intentId: 'i', inputs: [] }],
        runs: [],
        channelMoves: [{ id: 'm', channel: 'main', viewId: 'v', at: new Date(now).toISOString() }],
      },
      live: { sessions: [], events: [], unacked: [], claims: [], sessionsLoading: false },
      loading: true,
      ack: { busy: '', error: '', retrying: () => false },
      newIntent: () => {},
    }),
  );
  assert.match(resolved, /Resolved outcome/);
  assert.doesNotMatch(resolved, /Reading accepted work/);
});

test('session-addressed messages remain decisions when recipientActor is unavailable', () => {
  const [item] = coordination.hostedDecisions(
    [
      event('session-directed', {
        kind: 'message',
        recipient: 'my-session',
        text: 'Can you review?',
        context: {},
      }),
    ],
    [],
    [],
  );
  assert.equal(item.broadcast, false);
  assert.equal(item.audience, 'to you');
  assert.equal(item.question, true);
});

test('an aliasing hosted selection cannot replace the native acceptance actor or timestamp', () => {
  const native = {
    id: 'a',
    channel: 'main',
    viewId: 'v',
    at: '2026-10-16T01:00:00Z',
    acceptedBy: { name: 'gpt-c1' },
  };
  const alias = {
    id: 'h',
    acceptanceId: 'a',
    channel: 'main',
    viewId: 'v',
    at: '2026-10-16T02:00:00Z',
    actorDisplayName: 'Owner',
  };
  assert.deepEqual(nowModel.publishedMoves([native], [alias]), [native]);
});

test('owner refresh skips appear in Needs you with exact recovery and clear on success', () => {
  const notice = {
    status: 'skipped',
    head: 'a'.repeat(64),
    message: 'Owner edits were preserved.',
    recovery: "nforge owner refresh '/tmp/synthetic-owner'",
  };
  const [item] = attention.ownerRootDecisions(notice);
  assert.equal(item.kind, 'conflict');
  assert.equal(item.title, 'Owner folder needs refresh');
  assert.equal(item.body, notice.message);
  assert.equal(item.hint, notice.recovery);
  assert.deepEqual(attention.ownerRootDecisions({ ...notice, status: 'updated' }), []);
  assert.deepEqual(attention.ownerRootDecisions(), []);
});

test('browser bootstrap can show its next steps once without the persistent workflow explainer', async () => {
  const { HostedNowView } = await import(moduleUrl('../web/src/cockpit/HostedNow.tsx'));
  const props = {
    now: Date.now(),
    records: { intents: [], lanes: [], views: [], runs: [] },
    live: { sessions: [], events: [], unacked: [], claims: [], sessionsLoading: false },
    loading: false,
    ack: { busy: '', error: '', retrying: () => false },
    newIntent: () => {},
  };
  assert.match(renderToStaticMarkup(h(HostedNowView, props)), /Hand it to an agent/);
  assert.doesNotMatch(
    renderToStaticMarkup(h(HostedNowView, { ...props, showFirstRun: false })),
    /Hand it to an agent|Accept when it’s green/,
  );
});

test('initial hosted main is source authority without inventing a completed code change', () => {
  const initial = { id: 'create', viewId: 'create', channel: 'main', at: '2026-10-18T00:00:00Z' };
  const change = { id: 'change', viewId: 'view', channel: 'main', at: '2026-10-18T01:00:00Z' };
  assert.deepEqual(nowModel.publishedMoves([initial, change], [], 'create'), [change]);
  assert.deepEqual(nowModel.publishedMoves([initial, change], []), [initial, change]);
});

test('GitHub divergence becomes a Needs you conflict with both retained heads', () => {
  const status = {
    status: 'needs-you',
    operationId: 'op',
    repository: 'example/project',
    state: 'forge-state',
    localHead: 'forge-git',
    remoteHead: 'outside-git',
    expectedHead: 'expected-git',
    at: '2026-10-17',
  };
  const [item] = attention.githubPushDecisions(status);
  assert.equal(item.kind, 'conflict');
  assert.equal(item.githubMirror, true);
  assert.match(item.body, /forge-state/);
  assert.match(item.body, /forge-git/);
  assert.match(item.body, /outside-git/);
  assert.match(item.body, /expected-git/);
  assert.deepEqual(attention.githubPushDecisions({ ...status, status: 'pushed' }), []);
  assert.deepEqual(attention.githubPushDecisions(undefined), []);
});

test('the situation counts Lanes in motion and links accepted today to the Accepted section', async () => {
  const { NowSituation, NowLayout } = await import(moduleUrl('../web/src/cockpit/NowLayout.tsx'));
  const html = renderToStaticMarkup(
    h(NowSituation, { facts: { decisions: 2, open: 9, overlaps: 0, acceptedToday: 10 } }),
  );
  assert.match(html, /9 Lanes<\/a> in motion/);
  assert.match(html, /<a href="#fx-accepted-title">10 accepted today<\/a>/);
  assert.doesNotMatch(html, /stopped for your review|in progress/);
  const layout = renderToStaticMarkup(
    h(NowLayout, {
      situation: 's',
      needs: h('section', { id: 'n' }),
      changing: h('section', { id: 'c' }),
      people: h('section', { id: 'p' }),
      accepted: h('section', { id: 'a' }),
    }),
  );
  assert.match(layout, /id="n"[\s\S]*id="c"[\s\S]*id="p"[\s\S]*<\/div><section id="a">/);
});

test('Lane rows on Now take the pill, glyph and fact line from lane-facts', async () => {
  const { LaneRow } = await import(moduleUrl('../web/src/cockpit/LaneRow.tsx'));
  const html = renderToStaticMarkup(
    h(LaneRow, {
      lane: lane('docs', { checkpoints: 2, owner: 'claude-docmerge' }),
      fact: {
        open: true,
        tone: 'waiting',
        label: 'Waiting',
        glyph: 'person',
        text: 'Nobody working · last save 3 h ago by claude-docmerge · 2 saves',
      },
      now: 1000,
      href: '/lane/docs',
    }),
  );
  assert.match(html, /fx-row-waiting/);
  assert.match(html, /Waiting<\/span>/);
  assert.match(html, /Nobody working · last save 3 h ago by claude-docmerge · 2 saves/);
  assert.doesNotMatch(html, /Working|Unassigned|Active/);
});

test('recovery decisions map workspace notices without invented ages and keep record ids folded', () => {
  const notices = [
    {
      intentId: 'i1',
      state: 'reverted',
      auditRunId: 'audit-one',
      receiptId: 'receipt-one',
      head: 'h',
      summary: 'Reverted receipt r: tests/a.test.mjs, tests/b.test.mjs failed on h',
      undo: 'undo-one',
    },
    {
      intentId: 'i2',
      state: 'needs-fix',
      auditRunId: 'audit-two',
      head: 'h',
      summary: 'Fix needed for receipt r: tests/c.test.mjs failed on h',
      undo: 'undo-two',
    },
  ];
  const items = attention.needsFixDecisions(notices, [
    { id: 'i1', outcome: 'Restore bytes' },
    { id: 'i2', outcome: 'Fix headers' },
  ]);
  assert.deepEqual(
    items.map(item => [item.id, item.kind, item.title, item.subtitle]),
    [
      ['needsfix:i1', 'revert', 'Restore bytes', 'main audit failed 2 tests after it landed'],
      [
        'needsfix:i2',
        'needs-fix',
        'Fix headers',
        'main audit failed 1 test; no single culprit, main unchanged',
      ],
    ],
  );
  assert.ok(items.every(item => item.at === undefined));
  assert.deepEqual(items[0].tests, ['tests/a.test.mjs', 'tests/b.test.mjs']);
  assert.equal(items[1].exact.reverted, undefined);
  const html = renderToStaticMarkup(h(NeedsYou, { items, now: 0, answers: () => null }));
  assert.match(html, /fx-dec-revert/);
  assert.match(html, /fx-dec-needs-fix/);
  assert.equal((html.match(/<details class="fx-dec-exact">/g) ?? []).length, 2);
  assert.doesNotMatch(html, /fx-dec-age|<details[^>]+open/);
  assert.match(html, /<dt>Reverted<\/dt><dd>receipt-one/);
  assert.match(html, /<dt>Audit<\/dt><dd>audit-two/);
  assert.match(html, /<dt>Undo<\/dt><dd><code>undo-two/);
  const visible = html.replace(/<details class="fx-dec-exact">.*?<\/details>/g, '');
  assert.doesNotMatch(visible, /receipt-one|audit-one|audit-two|undo-one/);
});

test('recovery tests cap at three, retain the server remainder, and never parse a truncated path', () => {
  const notice = {
    intentId: 'i',
    state: 'reverted',
    auditRunId: 'audit',
    head: 'h',
    undo: 'undo',
    summary: 'Reverted receipt r: a.test.mjs, b.test.mjs, c.test.mjs (+9 more) failed on h',
  };
  const [item] = attention.needsFixDecisions([notice], []);
  assert.equal(item.subtitle, 'main audit failed 12 tests after it landed');
  const html = renderToStaticMarkup(
    h(NeedsYou, { items: [item], now: 0, href: () => '#intent', answers: () => null }),
  );
  assert.match(html, /href="#intent">\+9 more/);
  assert.equal((html.match(/<code>/g) ?? []).length, 4);
  for (const summary of [
    'Main audit r failed. Missing receipt range',
    notice.summary.slice(0, 50),
    'Reverted receipt r: static/unknown failure failed on h',
  ]) {
    const [unknown] = attention.needsFixDecisions([{ ...notice, summary }], []);
    assert.deepEqual(unknown.tests, []);
    assert.equal(unknown.subtitle, 'main audit failed after it landed');
  }
});
