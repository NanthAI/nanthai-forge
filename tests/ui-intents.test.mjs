// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { intentRows, filterIntents, linkedPlanning } = await import(moduleUrl('../web/src/intents/model.ts'));

const lane = (id, intentId, tone, extra = {}) => ({
  id,
  intentId,
  name: id,
  tone,
  label: tone,
  open: true,
  ...extra,
});
const intents = [
  {
    id: 'a',
    outcome: 'A',
    status: 'active',
    createdAt: '2026-10-14T09:00:00Z',
    notes: [{ kind: 'decision', at: '2026-10-14T11:00:00Z' }],
  },
  { id: 'b', outcome: 'B', status: 'active', createdAt: '2026-10-14T08:00:00Z' },
  { id: 'c', outcome: 'C', status: 'completed', createdAt: '2026-10-13T08:00:00Z' },
  { id: 'd', outcome: 'D', status: 'ready', createdAt: '2026-10-14T07:00:00Z' },
];

test('an active Intent takes the most urgent state of its open Lanes', () => {
  const rows = intentRows(intents, [
    lane('l1', 'a', 'active', { lastAt: '2026-10-14T10:00:00Z' }),
    lane('l2', 'a', 'conflict'),
    lane('l3', 'a', 'passed', { open: false }),
    lane('l4', 'b', 'passed'),
  ]);
  const by = Object.fromEntries(rows.map(row => [row.id, row]));
  assert.equal(by.a.tone, 'conflict');
  assert.equal(by.a.open.length, 2);
  assert.equal(by.a.lanes.length, 3);
  assert.equal(by.a.decisions, 1);
  assert.equal(by.a.lastAt, '2026-10-14T11:00:00Z');
  assert.equal(by.b.tone, 'passed');
  assert.equal(by.c.label, 'Done');
  assert.equal(by.c.tone, 'passed');
  assert.equal(by.d.label, 'Ready');
});

test('filters keep finished work out of the open list and sort by attention', () => {
  const rows = intentRows(intents, [lane('l2', 'a', 'conflict'), lane('l4', 'b', 'passed')]);
  assert.deepEqual(
    filterIntents(rows, 'open').map(row => row.id),
    ['a', 'b', 'd'],
  );
  assert.deepEqual(
    filterIntents(rows, 'done').map(row => row.id),
    ['c'],
  );
  assert.deepEqual(
    filterIntents(rows, 'ready')
      .map(row => row.id)
      .sort(),
    ['b', 'd'],
  );
  assert.equal(filterIntents(rows, 'all').length, 4);
});

test('linked planning uses the latest version of each item', () => {
  const items = [
    { id: 'p', version: 1, intentIds: ['a'], title: 'old' },
    { id: 'p', version: 2, intentIds: [], title: 'unlinked now' },
    { id: 'q', version: 1, intentIds: ['a'], title: 'linked' },
  ];
  assert.deepEqual(
    linkedPlanning(items, 'a').map(item => item.title),
    ['linked'],
  );
});

test('Intent status words use the shared vocabulary, including waiting without open Lanes', () => {
  for (const [tone, label] of [
    ['active', 'Working'],
    ['waiting', 'Waiting'],
    ['passed', 'Ready'],
    ['failed', 'Check failed'],
    ['conflict', 'Conflict'],
    ['stale', 'Stale'],
  ]) {
    const [row] = intentRows([intents[0]], [lane('l', 'a', tone)]);
    assert.equal(row.label, label);
    assert.equal(row.tone, tone);
  }
  const [waiting] = intentRows([intents[0]], [lane('closed', 'a', 'active', { open: false })]);
  assert.equal(waiting.label, 'Waiting');
  assert.equal(waiting.tone, 'waiting');
  const [abandoned] = intentRows([{ ...intents[0], status: 'abandoned' }], []);
  assert.equal(abandoned.label, 'Abandoned');
  assert.equal(abandoned.tone, 'stale');
});

test('only active Intents that never had any Lane are Planned, and starting work removes Planned', () => {
  const input = [{ id: 'p', outcome: 'Backlog', status: 'active' }];
  const [planned] = intentRows(input, []);
  assert.equal(planned.planned, true);
  assert.equal(planned.status, 'active');
  assert.equal(planned.label, 'Planned');
  assert.equal(planned.tone, 'plain');
  assert.equal(filterIntents([planned], 'open').length, 0);
  assert.equal(filterIntents([planned], 'ready').length, 0);
  assert.equal(filterIntents([planned], 'planned').length, 1);
  for (const open of [true, false]) {
    const [started] = intentRows(input, [lane('l', 'p', 'active', { open })]);
    assert.equal(started.planned, false);
    assert.equal(filterIntents([started], 'planned').length, 0);
    assert.equal(filterIntents([started], 'open').length, 1);
  }
  for (const status of ['ready', 'completed', 'abandoned']) {
    assert.equal(intentRows([{ ...input[0], status }], [])[0].planned, false);
  }
});
