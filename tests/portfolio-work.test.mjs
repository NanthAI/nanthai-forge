// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { portfolioWork, projectWorkLink } = await import(moduleUrl('../web/src/portfolio-work.ts'));
test('Home attention counts the Lanes the Needs you panel lists, never Lane or Intent "ready" words (M16)', () => {
  const conflict = {
    id: 'c',
    name: 'Conflict',
    intentId: 'a',
    state: 'active',
    pendingMerge: { conflicts: [{ path: 'a.ts' }] },
  };
  const data = {
    intents: [
      { id: 'a', outcome: 'A', status: 'active' },
      { id: 'b', outcome: 'B', status: 'completed' },
      { id: 'c', outcome: 'C', status: 'ready' },
    ],
    lanes: [
      { id: 'l', name: 'Still active', intentId: 'b', state: 'active' },
      { id: 'r', name: 'Ready', intentId: 'a', state: 'ready' },
      conflict,
    ],
    views: [
      { id: 'v1', intentId: 'a', status: 'conflict', at: '2026-01-01' },
      { id: 'v2', intentId: 'a', status: 'clean', at: '2026-01-02' },
      { id: 'v3', intentId: 'b', status: 'conflict', at: '2026-01-03' },
    ],
    plans: [],
  };
  const before = structuredClone(data),
    result = portfolioWork(data);
  // Old main counted intent:c (status ready), lane:r (state ready) and the conflict Views, and missed
  // the hosted conflict Lane that the panel lists.
  assert.deepEqual(
    result.attention.map(item => item.id),
    ['lane:c'],
  );
  assert.equal(result.active.find(item => item.laneId === 'l').detail, 'Nobody working · B');
  assert.deepEqual(
    result.completed.map(item => item.id),
    ['intent:b'],
  );
  assert.equal(result.recent[0].viewId, 'v3');
  assert.deepEqual(data, before);
});
test('links keep project and exact contribution identity without inheriting another project selection', () => {
  const a = new URL(projectWorkLink('project-a', { laneId: 'lane-a' }), 'https://example.test/');
  assert.equal(a.searchParams.get('project'), 'project-a');
  assert.equal(a.searchParams.get('lane'), 'lane-a');
  assert.equal(a.searchParams.has('intent'), false);
  const b = new URL(
    projectWorkLink('project-b', { intentId: 'intent-b', viewId: 'view-b' }),
    'https://example.test/',
  );
  assert.equal(b.searchParams.get('project'), 'project-b');
  assert.equal(b.searchParams.get('reviewView'), 'view-b');
  assert.equal(b.searchParams.get('intentTab'), 'delivery');
});

test('recent projects retain the newest View once per Intent, keeping unrelated same titles', () => {
  const result = portfolioWork({
    intents: [
      { id: 'a', outcome: 'Same title' },
      { id: 'b', outcome: 'Same title' },
    ],
    lanes: [],
    plans: [],
    views: [
      { id: 'old', intentId: 'a', at: '2026-10-14', status: 'clean' },
      { id: 'new', intentId: 'a', at: '2026-10-16', status: 'clean' },
      { id: 'other', intentId: 'b', at: '2026-10-15', status: 'clean' },
    ],
  });
  assert.deepEqual(
    result.recent.map(item => item.viewId),
    ['new', 'other'],
  );
});
test('an Issue with empty legacy intentIds shows its planned Intent link (0b12fcfe)', async () => {
  const { plannedLinkIds } = await import(moduleUrl('../src/work-planning-lifecycle.ts'));
  const { exportPlanning } = await import(moduleUrl('../src/work-planning-state.ts'));
  const issue = {
    id: 'issue-1',
    kind: 'issue',
    title: 'Issue',
    status: 'in-progress',
    at: '2026-01-02',
    intentIds: [],
  };
  const initiative = {
    id: 'init-1',
    kind: 'initiative',
    title: 'Init',
    status: 'open',
    at: '2026-01-01',
    intentIds: [],
  };
  const legacy = { ...issue, id: 'issue-2', at: '2026-01-03', intentIds: ['old', 'issue-2'] };
  assert.deepEqual(plannedLinkIds(issue), ['issue-1']);
  assert.deepEqual(plannedLinkIds(initiative), []);
  assert.deepEqual(plannedLinkIds(legacy), ['issue-2', 'old'], 'the planned id is not counted twice');
  const detail = (...plans) =>
    Object.fromEntries(
      portfolioWork({ intents: [], lanes: [], views: [], plans }).recent.map(item => [
        item.planId,
        item.detail,
      ]),
    );
  assert.deepEqual(detail(issue, initiative, legacy), {
    'issue-1': 'issue · 1 linked Intents',
    'init-1': 'initiative · 0 linked Intents',
    'issue-2': 'issue · 2 linked Intents',
  });
  // Export: the planned Intent (id = Issue id) is listed although the stored item has no intentIds.
  const intents = [
    { id: 'issue-1', outcome: 'Issue', status: 'completed' },
    { id: 'other', outcome: 'Other', status: 'active' },
  ];
  const manifest = JSON.parse(
    exportPlanning({
      revision: 1,
      intents,
      planningItems: [issue, initiative],
      planningComments: [],
      hostedEvents: [],
    }).json,
  );
  assert.deepEqual(
    manifest.linkedIntents.map(item => item.id),
    ['issue-1'],
  );
});
