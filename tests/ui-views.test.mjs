// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { viewStatus } = await import(moduleUrl('../web/src/views/model.ts'));
const viewHelpers = await import(moduleUrl('../web/src/views/intent-views.ts'));
const { intentViews } = viewHelpers;

test('View status keeps superseded failures grey and terminal runs static', () => {
  assert.deepEqual(viewStatus({ status: 'superseded' }, 'failed'), ['stale', 'Superseded']);
  assert.deepEqual(viewStatus({ status: 'ready' }, 'failed'), ['failed', 'Check failed']);
  assert.deepEqual(viewStatus({ status: 'ready' }, 'cancelled'), ['stale', 'Cancelled']);
  assert.deepEqual(viewStatus({ status: 'ready' }, 'interrupted'), ['stale', 'Interrupted']);
  assert.equal(viewStatus({ status: 'ready' }, 'running')[0], 'running');
  assert.deepEqual(viewStatus({ status: 'accepted' }, 'failed'), ['passed', 'Accepted']);
});

test('work map pins saves at composition time and only supersedes the same Lane family', () => {
  const views = intentViews(
    {
      intents: [],
      lanes: [
        {
          id: 'a',
          name: 'API',
          checkpoints: [
            { head: 'a1', at: '1' },
            { head: 'a2', at: '4' },
          ],
        },
        { id: 'b', name: 'UI', checkpoints: [] },
      ],
      views: [
        {
          id: 'v1',
          intentId: 'i',
          at: '2',
          status: 'clean',
          inputs: [
            { laneId: 'a', head: 'a1' },
            { laneId: 'b', head: 'b1' },
          ],
        },
        {
          id: 'v2',
          intentId: 'i',
          at: '5',
          status: 'clean',
          inputs: [
            { laneId: 'b', head: 'b2' },
            { laneId: 'a', head: 'a2' },
          ],
        },
        { id: 'v3', intentId: 'i', at: '6', status: 'clean', inputs: [{ laneId: 'a', head: 'a2' }] },
      ],
      runs: [{ id: 'r1', viewId: 'v1', status: 'failed' }],
      channelMoves: [{ viewId: 'v2', status: 'accepted' }],
    },
    'i',
  );
  assert.equal(views[0].supersededBy, 'v2');
  assert.equal(views[0].inputs[0].saveIndex, 0);
  assert.equal(views[1].inputs[1].saveIndex, 1);
  assert.equal(views[1].accepted, true);
  assert.equal(views[1].supersededBy, null);
  assert.equal(views[2].supersededBy, null);
  assert.equal(views[0].lanes, 'API + UI');
});

const { createElement: h } = await import('react');
const { renderToStaticMarkup: render } = await import('react-dom/server');
const { WorkMap, mapViews } = await import(moduleUrl('../web/src/views/WorkMap.tsx'));
const { IntentDetailView } = await import(moduleUrl('../web/src/intents/IntentDetail.tsx'));
const history = Array.from({ length: 16 }, (_, i) => ({
  id: `v${i + 1}`,
  at: String(i).padStart(2, '0'),
  status: 'clean',
  lanes: 'Long parent title',
  accepted: i < 15,
  check: 'passed',
  head: 'h',
  checkHead: 'h',
  inputs: [{ laneId: 'l', head: 'h', saveIndex: 26 }],
}));

test('dense maps keep a bounded View window and cluster saves without clipping their labels', () => {
  assert.equal(mapViews(history).earlier, 11);
  assert.deepEqual(
    mapViews(history).visible.map(v => v.id),
    ['v12', 'v13', 'v14', 'v15', 'v16'],
  );
  const html = render(
    h(WorkMap, {
      lanes: [{ id: 'l', name: 'Long parent title', checkpoints: 27 }],
      views: history,
      laneHref: () => '/lane',
      viewHref: id => `/view/${id}`,
      parentTitle: 'Long parent title',
    }),
  );
  assert.match(html, /27 saves/);
  assert.match(html, /11 earlier/);
  assert.match(html, /Long parent title · pinned save 27/);
  assert.doesNotMatch(html, />View 1</);
  assert.match(html, /0 0 1000 246/);
  assert.equal((html.match(/class="fx-map-save"/g) ?? []).length, 5); // one pinned save reference per retained candidate
});

test('Intent exposes passed candidates through Review and omits repeated parent content', () => {
  const row = {
    id: 'i',
    outcome: 'Long parent title',
    status: 'active',
    tone: 'active',
    label: 'Working',
    open: [],
    lanes: [
      {
        id: 'l',
        intentId: 'i',
        intent: 'Long parent title',
        name: 'Long parent title',
        checkpoints: 27,
        tone: 'passed',
        label: 'Accepted',
        accepted: true,
        open: false,
        conflicts: [],
        fact: 'Landed',
        changes: null,
      },
    ],
  };
  const html = render(
    h(IntentDetailView, {
      row,
      views: history,
      notes: [],
      planning: [],
      now: 0,
      laneHref: () => '/lane',
      viewHref: id => `/view/${id}`,
      reviewHref: id => `/review/${id}`,
    }),
  );
  assert.match(html, /class="fx-btn fx-btn-primary" href="\/review\/v16">Review and accept/);
  assert.doesNotMatch(html, /What and why|No Issues|No decisions/);
  assert.equal((html.match(/class="fx-map-label"[^>]*>Long parent title</g) ?? []).length, 1); // Lane row names it once; hidden tooltips list included Lanes
  const accepted = render(
    h(IntentDetailView, {
      row,
      views: history.map(v => ({ ...v, accepted: true })),
      notes: [],
      planning: [],
      now: 0,
      laneHref: () => '/lane',
      reviewHref: id => `/review/${id}`,
    }),
  );
  assert.doesNotMatch(accepted, /Review and accept/);
});

test('Review actions exclude accepted, superseded and mismatched-head evidence', () => {
  const candidate = { ...history[15], accepted: false, supersededBy: null };
  const { canReviewView } = viewHelpers;
  assert.equal(canReviewView(candidate), true);
  assert.equal(canReviewView({ ...candidate, accepted: true }), false);
  assert.equal(canReviewView({ ...candidate, supersededBy: 'later' }), false);
  assert.equal(canReviewView({ ...candidate, checkHead: 'old-head' }), false);
  assert.equal(canReviewView({ ...candidate, head: undefined }), false);
  const html = render(
    h(IntentDetailView, {
      row: {
        id: 'i',
        outcome: 'Done outcome',
        status: 'completed',
        tone: 'plain',
        label: 'Done',
        open: [],
        lanes: [],
      },
      views: [
        { ...candidate, accepted: true },
        { ...candidate, id: 'older', supersededBy: candidate.id },
      ],
      notes: [],
      planning: [],
      now: 0,
      laneHref: () => '/lane',
      reviewHref: id => `/review/${id}`,
    }),
  );
  assert.doesNotMatch(html, /Review and accept|fx-situation/);
});

test('Intent check evidence follows the current View head, not a passing older head', () => {
  const work = {
    intents: [],
    lanes: [],
    channelMoves: [],
    views: [{ id: 'v', intentId: 'i', at: '2', status: 'clean', head: 'current', inputs: [] }],
    runs: [{ id: 'r', viewId: 'v', head: 'old', status: 'passed' }],
  };
  assert.equal(intentViews(work, 'i')[0].check, undefined);
  const current = intentViews(
    { ...work, runs: [...work.runs, { id: 'r2', viewId: 'v', head: 'current', status: 'passed' }] },
    'i',
  )[0];
  assert.equal(viewHelpers.canReviewView(current), true);
});
