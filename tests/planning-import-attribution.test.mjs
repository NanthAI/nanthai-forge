// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { planningItemSchema } from '../dist/work-planning-types.js';
import { planningSummary, planningSearchEntry } from '../dist/planning-search.js';
import { exportPlanning } from '../dist/work-planning-state.js';

const record = () => ({
  id: '00000000-0000-4000-8000-000000000001',
  operationId: '00000000-0000-4000-8000-000000000002',
  request: 'a'.repeat(64),
  version: 1,
  previousVersion: 0,
  kind: 'issue',
  title: 'Previous milestone',
  body: '',
  status: 'closed',
  intentIds: [],
  at: '2026-11-17T12:00:00.000Z',
  provenance: 'user-declared-local',
});
const imported = {
  source: 'docs/milestones/m3.md',
  key: 'm3/task-1',
  createdAt: '2024-01-02T10:00:00+02:00',
  closedAt: '2024-02-03T10:00:00+02:00',
  originalHandle: '@river',
  batchId: '00000000-0000-4000-8000-000000000003',
};

test('retained import attribution survives exact reads, summaries, search and planning export with separate original dates', () => {
  const item = planningItemSchema.parse({ ...record(), imported });
  assert.deepEqual(item.imported, imported);
  assert.equal(item.at, record().at);
  assert.deepEqual(planningSummary(item).imported, imported);
  assert.deepEqual(JSON.parse(planningSearchEntry(item, 0).value).imported, imported);
  const exported = exportPlanning({ revision: 1, planningItems: [item], planningComments: [], intents: [] });
  assert.deepEqual(planningItemSchema.parse(JSON.parse(exported.json).items[0]).imported, imported);
});

test('original attribution never invents a public identity or accepts an ambiguous date', () => {
  for (const patch of [
    { originalHandle: 'person@example.invalid' },
    { originalHandle: 'A Person' },
    { createdAt: 'January 2' },
  ])
    assert.equal(
      planningItemSchema.safeParse({ ...record(), imported: { ...imported, ...patch } }).success,
      false,
    );
  assert.equal(Object.hasOwn(planningItemSchema.parse(record()), 'imported'), false);
});

test('source dates retain their known precision and unknown dates stay absent', () => {
  for (const dates of [{ createdAt: '2024-01-02', closedAt: '2024-02-03' }, {}]) {
    const { createdAt, closedAt, ...source } = imported;
    const expected = { ...source, ...dates, originalHandle: '@River' };
    const item = planningItemSchema.parse({ ...record(), imported: expected });
    assert.deepEqual(item.imported, expected);
    assert.equal(item.at, record().at);
    assert.deepEqual(planningSummary(item).imported, expected);
    const exported = exportPlanning({
      revision: 1,
      planningItems: [item],
      planningComments: [],
      intents: [],
    });
    assert.deepEqual(planningItemSchema.parse(JSON.parse(exported.json).items[0]).imported, expected);
  }
});
