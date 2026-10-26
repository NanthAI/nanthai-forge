// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup as html } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const { initiativeLinks, groupByInitiative } = await import(moduleUrl('../web/src/cockpit/scale-model.ts'));
const { PagedList, ScaleGroups } = await import(moduleUrl('../web/src/cockpit/ScaleList.tsx'));
const { LaneList } = await import(moduleUrl('../web/src/cockpit/LaneList.tsx'));
const { Sessions } = await import(moduleUrl('../web/src/cockpit/Sessions.tsx'));
const { NeedsYou } = await import(moduleUrl('../web/src/cockpit/NeedsYou.tsx'));
const { IntentListView } = await import(moduleUrl('../web/src/intents/IntentList.tsx'));
const { intentRows } = await import(moduleUrl('../web/src/intents/model.ts'));

const plan = (id, kind, intentIds, extra = {}) => ({ id, kind, title: id, intentIds, version: 1, ...extra });
test('Initiatives use current links, resolve child issues, keep unassigned and count shared Intents once', () => {
  const links = initiativeLinks([
    plan('a', 'initiative', ['i1']),
    plan('a', 'initiative', ['i2'], { version: 2, title: 'Current title' }),
    plan('b', 'issue', ['i3'], { initiativeId: 'a' }),
    plan('c', 'initiative', ['i2', 'i4']),
    plan('d', 'issue', ['i5'], { initiativeId: 'missing' }),
  ]);
  assert.equal(links.has('i1'), false);
  assert.equal(links.get('i2').title, 'Current title');
  assert.equal(links.get('i3').id, 'a');
  const rows = ['i1', 'i2', 'i3', 'i4', 'i5'].map(id => ({ id }));
  const groups = groupByInitiative(rows, links, row => row.id);
  assert.equal(groups.flatMap(group => group.rows).length, 5);
  assert.deepEqual(
    groups.map(group => [group.title, group.rows.length]),
    [
      ['Current title', 2],
      ['c', 1],
      ['No Initiative', 2],
    ],
  );
  assert.equal(initiativeLinks([]).size, 0);
});
test('ordinary lists bound first paint with a reachable continuation and empty lists are quiet', () => {
  const render = n => h('li', { key: n }, `row-${n}`);
  const markup = html(h(PagedList, { rows: Array.from({ length: 500 }, (_, n) => n), render }));
  assert.equal((markup.match(/<li/g) ?? []).length, 20);
  assert.match(markup, /480 remaining/);
  assert.doesNotMatch(html(h(PagedList, { rows: [], render })), /button/);
});
test('collapsed groups do not mount their rows or actions', () => {
  const markup = html(
    h(ScaleGroups, {
      groups: [{ id: 'one', title: 'Receiver', rows: [1, 2] }],
      noun: 'Intent',
      render: () => {
        throw Error('Must stay lazy');
      },
    }),
  );
  assert.match(markup, /Receiver/);
  assert.match(markup, /title="2 Intents"/);
  assert.doesNotMatch(markup, /open=""/);
});
const now = Date.now();
const lanes = Array.from({ length: 200 }, (_, n) => ({
  id: `l${n}`,
  intentId: `i${n}`,
  name: `Lane ${n}`,
  intent: `Intent ${n}`,
  tone: 'active',
  label: 'Working',
  fact: '2 saves',
  open: true,
  checkpoints: 2,
  byAgent: true,
  owner: '',
  conflicts: [],
  lastAt: new Date(now).toISOString(),
}));
test('200 Lanes render aggregate groups with every open Lane counted once', () => {
  const markup = html(h(LaneList, { lanes, now, href: lane => `#${lane.id}` }));
  assert.match(markup, /title="200 Lanes"/);
  assert.match(markup, /200 in motion/);
  assert.doesNotMatch(markup, /waiting for you →/);
  assert.doesNotMatch(markup, /fx-lane-row/);
});
test('large triage groups retain exact counts and expose five next decisions', () => {
  const items = Array.from({ length: 100 }, (_, n) => ({
    id: `d${n}`,
    kind: n < 40 ? 'review' : 'conflict',
    title: `Decision ${n}`,
  }));
  const markup = html(
    h(NeedsYou, {
      items,
      now,
      answers: () => h('button', null, 'Review item'),
    }),
  );
  assert.match(markup, /40 items/);
  assert.match(markup, /60 items/);
  assert.match(markup, /Ready to accept/);
});
test('500 Intents group without losing Intents with no Lane', () => {
  const rows = intentRows(
    Array.from({ length: 500 }, (_, n) => ({ id: `i${n}`, outcome: `Long Intent ${n}`, status: 'active' })),
    lanes,
  );
  const markup = html(h(IntentListView, { rows, now, intentHref: id => `#${id}` }));
  assert.match(markup, /200 Intents/);
  assert.doesNotMatch(markup, /open Lanes|by agents/);
  assert.doesNotMatch(markup, /href="#i499"/);
});

test('Not seen Lanes stay outside in-motion totals at scale and keep their word', () => {
  const facts = new Map(
    lanes.map(lane => [
      lane.id,
      { open: true, tone: 'stale', label: 'Not seen', text: 'Not seen since 05:10' },
    ]),
  );
  const markup = html(h(LaneList, { lanes, facts, now, href: lane => `#${lane.id}` }));
  assert.doesNotMatch(markup, /in motion/);
  assert.match(markup, /title="200 Lanes"/);
});

test('unknown workflow attribution is not presented as a person in the triage queue', () => {
  const markup = html(
    h(NeedsYou, {
      items: [{ id: 'unknown', kind: 'review', title: 'Retain source', subtitle: 'Agent workflow' }],
      now,
      answers: () => null,
    }),
  );
  assert.doesNotMatch(markup, /Agent workflow/);
  assert.match(markup, /Retain source/);
});

test('nested agent lists keep the tree and page descendants without mounting all children', () => {
  const child = n => ({
    sessionId: `s${n}`,
    actor: '',
    name: `child-${n}`,
    environment: 'fixture',
    status: 'working',
    summary: '',
    context: {},
    lastSeen: now,
    lastActivity: now,
  });
  const markup = html(
    h(Sessions, {
      sessions: [
        { ...child('root'), name: 'Parent', subagents: Array.from({ length: 50 }, (_, n) => child(n)) },
      ],
      now,
      laneName: () => undefined,
    }),
  );
  assert.match(markup, /fx-session-children/);
  assert.match(markup, /child-4/);
  assert.doesNotMatch(markup, /child-5<|child-49/);
  assert.match(markup, /45 remaining/);
});
