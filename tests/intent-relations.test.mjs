// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { workSchema } from '../dist/work-types.js';
import { convertWork15To16 } from '../dist/work-intent-converter.js';
import { applyPlanningMetadata } from '../dist/work-planning-state.js';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-01-01T00:00:00Z',
  hash = 'a'.repeat(64);
function fixture() {
  const intent = n => ({
    id: id(n),
    outcome: `Synthetic outcome ${n}`,
    constraints: '',
    base: hash,
    status: 'active',
    createdAt: at,
    notes: [],
  });
  const item = (n, patch) => ({
    id: id(n),
    operationId: randomUUID(),
    request: hash,
    version: 1,
    previousVersion: 0,
    kind: 'issue',
    title: `Synthetic item ${n}`,
    body: '',
    status: 'open',
    intentIds: [],
    at,
    provenance: 'user-declared-local',
    ...patch,
  });
  const data = workSchema.parse({
    schema: 15,
    revision: 1,
    intents: [intent(1), intent(2)],
    lanes: [],
    views: [],
    planningItems: [
      item(4, { kind: 'initiative', intentIds: [id(2)] }),
      item(3, { intentIds: [id(1), id(2)], initiativeId: id(4) }),
    ],
  });
  return convertWork15To16(data);
}
test('removing a unified planning link clears both related references and only its source placement', () => {
  const data = fixture(),
    originals = JSON.stringify(data.legacyIntentMerge);
  const command = {
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId: id(3),
    expectedVersion: 1,
    kind: 'issue',
    title: 'Same outcome',
    body: '',
    status: 'open',
    intentIds: [id(1)],
    initiativeId: id(4),
  };
  applyPlanningMetadata(data, command, at);
  assert.deepEqual(data.intents.find(i => i.id === id(3)).relatedIntentIds, [id(1)]);
  assert.deepEqual(data.intents.find(i => i.id === id(2)).relatedIntentIds, []);
  assert.deepEqual(data.intents.find(i => i.id === id(1)).relatedIntentIds, [id(3)]);
  assert.deepEqual(
    data.intents.find(i => i.id === id(2)).memberships.map(m => m.sourceId),
    [id(4)],
  );
  assert.equal(data.planningItems.find(i => i.id === id(3) && i.version === 1).intentIds.length, 2);
  assert.equal(JSON.stringify(data.legacyIntentMerge), originals);
});
test('removing every link preserves unrelated Intent identity and source pins', () => {
  const data = fixture();
  applyPlanningMetadata(
    data,
    {
      action: 'put-planning-item',
      operationId: randomUUID(),
      itemId: id(3),
      expectedVersion: 1,
      kind: 'issue',
      title: 'Independent outcome',
      body: '',
      status: 'open',
      intentIds: [],
    },
    at,
  );
  assert.ok(data.intents.every(i => i.relatedIntentIds.length === 0));
  assert.equal(data.intents.find(i => i.id === id(1)).base, hash);
  assert.equal(data.intents.find(i => i.id === id(2)).base, hash);
});
