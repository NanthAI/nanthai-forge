// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
let WorkPlanning;
try {
  globalThis.window = { location: { hash: '' } };
  ({ WorkPlanning } = await import(moduleUrl('../web/src/WorkPlanning.tsx')));
} finally {
  delete globalThis.window;
}
test('large planning summaries render while the selected full record is deferred', () => {
  const item = {
    id: 'item',
    operationId: 'operation',
    kind: 'issue',
    title: 'Retained item',
    body: '',
    status: 'open',
    version: 1,
    at: '2026-01-01',
    payloadKey: 'payload',
    payloadParts: 5,
  };
  const html = renderToStaticMarkup(
    createElement(WorkPlanning, {
      data: { revision: 1, intents: [], planningItems: [item], planningComments: [], hostedEvents: [] },
      scope: 'hosted',
      busy: false,
      act: async () => {},
      renderBody: () => null,
      renderDetails: () => null,
    }),
  );
  assert.match(html, /Retained item/);
  assert.match(html, /New Intent/);
  assert.doesNotMatch(html, /undefined/);
});

test('Initiatives with no issues show linked Planned, Working and Done Intents', () => {
  const data = {
    revision: 1,
    planningComments: [],
    hostedEvents: [],
    intents: [
      { id: 'p', outcome: 'Plan later', status: 'active' },
      { id: 'w', outcome: 'Work now', status: 'active' },
      { id: 'd', outcome: 'Already done', status: 'completed' },
    ],
    lanes: [{ intentId: 'w', state: 'abandoned' }],
    planningItems: [
      {
        id: 'initiative',
        kind: 'initiative',
        title: 'Phase 3',
        status: 'open',
        version: 1,
        intentIds: ['p', 'w', 'd'],
      },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(WorkPlanning, { data, scope: 'local', busy: false, act: async () => {} }),
  );
  assert.match(html, /Plan later/);
  assert.match(html, /Planned/);
  assert.match(html, /Working/);
  assert.match(html, /Done/);
  assert.doesNotMatch(html, /Initiative with no matching issues/);
});

test('Planning filters and group totals count the displayed Intent states, including duplicate links', async () => {
  const { planningGroups, planningRowMatches } = await import(moduleUrl('../web/src/planning-rows.ts'));
  const intents = Array.from({ length: 10 }, (_, n) => ({
    id: `i${n}`,
    outcome: `Intent ${n}`,
    status: 'active',
  }));
  const items = [
    {
      id: 'a',
      kind: 'initiative',
      title: 'Receiver reliability',
      intentIds: intents.map(intent => intent.id),
      version: 1,
      status: 'open',
    },
    {
      id: 'linked',
      kind: 'issue',
      title: 'Old link',
      initiativeId: 'a',
      intentIds: ['i0'],
      version: 1,
      status: 'open',
    },
  ];
  const lanes = [{ intentId: 'i0', state: 'abandoned' }];
  const [group] = planningGroups(items, intents, lanes);
  assert.equal(group.rows.length, 10);
  assert.match(group.rows.find(row => row.id === 'i0').searchText, /Old link/);
  for (const [filter, count] of [
    ['all', 10],
    ['proposed', 0],
    ['planned', 9],
    ['in-motion', 1],
    ['done', 0],
  ]) {
    assert.equal(group.rows.filter(row => planningRowMatches(row, filter)).length, count);
  }
  const html = renderToStaticMarkup(
    createElement(WorkPlanning, {
      data: { revision: 1, planningComments: [], hostedEvents: [], planningItems: items, intents, lanes },
      busy: false,
      act: async () => {},
    }),
  );
  assert.match(html, /10 Intents.*1 in motion/);
  assert.match(html, /Planned\s*<span class="fx-count">9/);
  assert.match(html, /In motion\s*<span class="fx-count">1/);
  assert.match(html, /Proposed\s*<span class="fx-count">0/);
  assert.match(html, /Done\s*<span class="fx-count">0/);
  assert.match(html, /Proposed[^]*Planned[^]*In motion[^]*Done[^]*All/);
  assert.match(html, /All\s*<span class="fx-count">10/);
  assert.doesNotMatch(
    html,
    />Issue<|Find an issue|No Intent yet|>Working\s*<span class="fx-count"|New planning item|>Updated</,
  );
  assert.match(html, /Find an Intent/);
  assert.match(html, /<span>Intent<\/span><span>Status<\/span>/);
  assert.match(html, /aria-label="More planning actions"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/);
  assert.doesNotMatch(html, /planning-more|<details[^>]*>[^]*Export planning history/);
});

test('legacy standalone records stay reachable with Intent labels and completed work is Done', async () => {
  const { planningGroups, planningRowMatches } = await import(moduleUrl('../web/src/planning-rows.ts'));
  const items = ['open', 'in-progress', 'closed'].map((status, n) => ({
    id: `old-${n}`,
    kind: 'issue',
    title: status,
    status,
    intentIds: [],
  }));
  const group = planningGroups(items, [], []).find(group => group.id === '');
  assert.deepEqual(
    group.rows.map(row => row.label),
    ['Planned', 'Working', 'Done'],
  );
  assert.ok(group.rows.every(row => row.itemId));
  assert.equal(group.rows.filter(row => planningRowMatches(row, 'done')).length, 1);
  assert.equal(planningRowMatches({ label: 'Ready' }, 'working'), true);
  assert.equal(planningRowMatches({ label: 'Ready' }, 'planned'), false);
  assert.equal(planningRowMatches({ label: 'Abandoned' }, 'done'), true);
  assert.equal(planningRowMatches({ label: 'Abandoned' }, 'working'), false);
});
