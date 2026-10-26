// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { portfolioWork, projectWorkLink } = await import(moduleUrl('../web/src/portfolio-work.ts'));
test('attention excludes old conflicts and completed Intents while keeping independent Lane states honest', () => {
  const data = {
    intents: [
      { id: 'a', outcome: 'A', status: 'active' },
      { id: 'b', outcome: 'B', status: 'completed' },
      { id: 'c', outcome: 'C', status: 'ready' },
    ],
    lanes: [
      { id: 'l', name: 'Still active', intentId: 'b', state: 'active' },
      { id: 'r', name: 'Ready', intentId: 'a', state: 'ready' },
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
  assert.deepEqual(
    result.attention.map(item => item.id),
    ['intent:c', 'lane:r'],
  );
  assert.equal(result.active.find(item => item.laneId === 'l').detail, 'Nobody working · B');
  assert.deepEqual(
    result.completed.map(item => item.id),
    ['intent:b'],
  );
  assert.equal(result.recent[0].viewId, 'v3');
  assert.deepEqual(data, before);
  data.views.push({ id: 'v4', intentId: 'a', status: 'conflict', at: '2026-01-04' });
  assert.equal(portfolioWork(data).attention.at(-1).viewId, 'v4');
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
