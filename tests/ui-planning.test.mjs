// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const { WorkPlanning } = await import(moduleUrl('../web/src/WorkPlanning.tsx'));
const { planningGroups, planningRowMatches } = await import(moduleUrl('../web/src/planning-rows.ts'));
const { planningDestination } = await import(moduleUrl('../web/src/shell/route.ts'));
const at = new Date(Date.now() - 3 * 86400000).toISOString();
const item = (id, kind, extra = {}) => ({
  id,
  kind,
  title: id,
  status: 'open',
  intentIds: [],
  version: 1,
  at,
  body: '',
  ...extra,
});
const intents = [
  { id: 'p', outcome: 'Plan later', status: 'active', createdAt: at },
  { id: 'r', outcome: 'Ready to land', status: 'ready', createdAt: at },
  { id: 'w', outcome: 'Working now', status: 'active', createdAt: at },
  { id: 'd', outcome: 'Completed', status: 'completed', createdAt: at },
  { id: 'a', outcome: 'Abandoned work', status: 'abandoned', createdAt: at },
  { id: 'proposal', outcome: 'External proposal', status: 'proposed', createdAt: at },
];
const lanes = [{ intentId: 'r' }, { intentId: 'w' }];
function render(data, readOnly = false) {
  return renderToStaticMarkup(
    h(WorkPlanning, {
      data: { revision: 1, intents: [], planningItems: [], planningComments: [], hostedEvents: [], ...data },
      busy: false,
      readOnly,
      act: async () => {},
      exportHistory: async () => ({}),
    }),
  );
}
test('Planning uses WorkRow, both visible creation actions, and no columns or detail aside', () => {
  const html = render({ intents, lanes });
  assert.equal((html.match(/class="fx-wr-title"/g) ?? []).length, intents.length);
  assert.match(html, />New Initiative<\/button>/);
  assert.match(html, />New Intent<\/button>/);
  assert.doesNotMatch(html, /planning-columns|<aside|planning-detail|Open Intent|Edit item/);
  assert.match(html, /Find an Intent or Initiative/);
});
test('all five Planning buckets cover exactly their displayed rows, including Ready and Abandoned', () => {
  const rows = planningGroups([], intents, lanes).flatMap(group => group.rows);
  for (const [filter, expected] of [
    ['proposed', 1],
    ['planned', 1],
    ['in-motion', 2],
    ['done', 2],
    ['all', 6],
  ])
    assert.equal(rows.filter(row => planningRowMatches(row, filter)).length, expected, filter);
  const html = render({ intents, lanes });
  assert.match(html, /In motion <span class="fx-count">2/);
  assert.match(html, /Done <span class="fx-count">2/);
});
test('Proposed without an Initiative precedes No Initiative and legacy links do not duplicate it', () => {
  const groups = planningGroups(
    [item('linked-proposal', 'issue', { intentIds: ['proposal'] })],
    intents,
    lanes,
  );
  assert.equal(groups.find(group => group.id === 'proposed').rows.length, 1);
  assert.equal(
    groups.find(group => group.id === '').rows.some(row => row.id === 'proposal'),
    false,
  );
  assert.deepEqual(
    groups.slice(-2).map(group => group.title),
    ['Proposed from outside', 'No Initiative'],
  );
});
test('unified memberships and duplicate legacy links give each Initiative one row per Intent', () => {
  const items = [
    item('initiative', 'initiative', { intentIds: ['p', 'p'] }),
    item('old', 'issue', { initiativeId: 'initiative', intentIds: ['p'] }),
  ];
  const groups = planningGroups(
    items,
    [{ ...intents[0], memberships: [{ initiativeId: 'initiative' }] }],
    [],
  );
  assert.equal(groups[0].rows.length, 1);
  assert.equal(groups.find(group => group.id === '').rows.length, 0);
});
test('facts use hosted save summaries and never invent actors, checks or landing times', () => {
  const own = [{ intentId: 'w', checkpointCount: 27, lastCheckpointAt: at }];
  const rows = planningGroups([], intents, own).flatMap(group => group.rows);
  assert.match(rows.find(row => row.id === 'w').fact, /1 Lane · 27 saves · last save 3 d ago/);
  assert.match(rows.find(row => row.id === 'p').fact, /Planned 3 d ago · no Lane yet/);
  assert.doesNotMatch(rows.map(row => row.fact).join(' '), /by Dino|verify passed|Landed on main/);
});
test('full-page row destinations retain existing Intent and Initiative paths', () => {
  assert.deepEqual(planningDestination({ kind: 'intent', id: 'i' }), { projectTab: 'intent', intent: 'i' });
  assert.deepEqual(planningDestination({ kind: 'planning', id: 'p' }), {
    projectTab: 'planning',
    planningItem: 'p',
    planningRoute: 'planning:p',
  });
  assert.equal(planningDestination({ kind: 'initiative', id: 'g' }).planningRoute, 'initiative:g');
});
test('read-only Planning keeps rows and routes without exposing write or export controls', () => {
  const html = render({ intents, lanes }, true);
  assert.match(html, /fx-wr-title/);
  assert.doesNotMatch(html, /New Initiative|New Intent|More planning actions/);
});
