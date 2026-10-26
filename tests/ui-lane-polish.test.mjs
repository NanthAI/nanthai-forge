// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const { LaneSaves } = await import(moduleUrl('../web/src/lane/LaneSaves.tsx'));
const { WorkMap } = await import(moduleUrl('../web/src/views/WorkMap.tsx'));
const { RunLog } = await import(moduleUrl('../web/src/lane/RunLog.tsx'));
globalThis.location = new URL('http://local/local/project/lanes/l');

test('save messages replace ordinal titles; short hashes copy exact source with full hashes in disclosure', () => {
  const html = render(
    h(LaneSaves, {
      saves: [
        { message: '', head: 'a'.repeat(64), at: '2026-10-16T10:00:00Z' },
        { message: 'Preserve filename', head: 'b'.repeat(64), at: '2026-10-16T11:00:00Z' },
      ],
      base: 'c'.repeat(64),
      head: 'b'.repeat(64),
      now: Date.parse('2026-10-16T12:00:00Z'),
    }),
  );
  assert.match(html, /<b>Preserve filename<\/b>/);
  assert.match(html, /<b>Saved changes<\/b>/);
  assert.match(html, /1 h ago/);
  assert.match(html, /<code>bbbbbbbb<\/code>/);
  assert.match(html, /Copy full hash bbbbbbbb/);
  assert.match(html, /aria-label="Save actions"/);
  assert.match(html, /Saves and exact snapshots/);
  assert.doesNotMatch(html, />Save [12]</);
});

test('all candidate states remain in the map with distinct markers and accessible descriptions', () => {
  const views = [
    { id: 'old', supersededBy: 'current' },
    { id: 'accepted', accepted: true },
    { id: 'failed', check: 'failed', checkName: 'verify' },
    { id: 'current', check: 'passed' },
  ].map((view, i) => ({ at: String(i), lanes: 'API', inputs: [{ laneId: 'l', saveIndex: 0 }], ...view }));
  const html = render(
    h(WorkMap, {
      lanes: [{ id: 'l', name: 'API', checkpoints: 1 }],
      views,
      laneHref: () => '/lane',
      viewHref: id => `/view/${id}`,
    }),
  );
  for (const state of ['old', 'accepted', 'failed', 'current'])
    assert.match(html, new RegExp(`class="fx-map-${state}"`));
  for (const label of ['Superseded', 'Accepted', 'Check failed', 'Ready'])
    assert.match(html, new RegExp(`aria-label="[^"]*${label}`));
  assert.equal((html.match(/class="fx-map-node"/g) ?? []).length, 4);
  assert.match(html, /role="tooltip"/);
  assert.match(html, />Open<\/a>/);
  assert.match(html, /<span>API · verify<\/span>/);
  assert.doesNotMatch(html, /<span>Check failed<\/span>/);
  assert.doesNotMatch(html, /API · save/);
});

test('hosted running output starts with the recorded machine and no endless reading message', () => {
  const html = render(
    h(RunLog, {
      runId: 'r',
      status: 'running',
      remoteMachine: 'Owner Mac',
      read: async () => ({ available: false }),
    }),
  );
  assert.match(html, /Running on Owner Mac · output appears when it finishes/);
  assert.doesNotMatch(html, /Reading output/);
  const queued = render(
    h(RunLog, {
      runId: 'r',
      status: 'queued',
      remoteMachine: 'Owner Mac',
      read: async () => ({ available: false }),
    }),
  );
  assert.match(queued, /Queued on Owner Mac/);
});

test('candidate labels use state and recorded acceptance age; joins stay in their event column', async () => {
  const { candidateState } = await import(moduleUrl('../web/src/views/WorkMap.tsx'));
  assert.equal(candidateState({ check: 'running' }), 'Checking');
  assert.equal(candidateState({ check: 'passed' }), 'Ready');
  assert.equal(candidateState({ check: 'failed', supersededBy: 'new' }), 'Superseded');
  assert.equal(candidateState({ check: 'running', accepted: true }), 'Accepted');
  const now = Date.parse('2026-10-16T12:00:00Z');
  const html = render(
    h(WorkMap, {
      now,
      lanes: [{ id: 'l', name: 'API', checkpoints: 6 }],
      views: Array.from({ length: 6 }, (_, index) => ({
        id: String(index),
        at: '2026-10-16T01:00:00Z',
        accepted: index === 0,
        acceptedAt: '2026-10-16T06:00:00Z',
        check: index === 4 ? 'running' : 'passed',
        inputs: [{ laneId: 'l', saveIndex: index }],
      })),
      laneHref: () => '/lane',
      viewHref: id => `/view/${id}`,
    }),
  );
  assert.match(html, /Accepted · 6 h/);
  assert.match(html, />Checking</);
  assert.match(html, />Ready</);
  assert.doesNotMatch(html, /API · save/);
  const joins = [...html.matchAll(/class="fx-map-join" d="M([\d.]+) [\d.]+V[\d.]+H([\d.]+)"/g)];
  assert.equal(joins.length, 6);
  for (const [, source, marker] of joins) assert.equal(source, marker);
});

test('shared count labels cover zero, singular, plural and an explicit plural', async () => {
  const { countLabel } = await import(moduleUrl('../web/src/ui/count.ts'));
  for (const noun of ['save', 'file', 'Lane', 'View']) {
    assert.equal(countLabel(0, noun), `0 ${noun}s`);
    assert.equal(countLabel(1, noun), `1 ${noun}`);
    assert.equal(countLabel(2, noun), `2 ${noun}s`);
  }
  assert.equal(countLabel(2, 'person', 'people'), '2 people');
});
