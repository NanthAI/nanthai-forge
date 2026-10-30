// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { workSchema } from '../dist/work-types.js';
import { migrateHostedIntents } from '../dist/work-hosted-intents.js';
test('conversion occurs exactly at the journal cutover and preserves original event request bytes', () => {
  const data = workSchema.parse({ schema: 15, revision: 4, intents: [], lanes: [], views: [] });
  const marker = { operationId: randomUUID(), revision: 5 };
  assert.equal(migrateHostedIntents(data, marker), data);
  data.revision = 5;
  const migrated = migrateHostedIntents(data, marker);
  assert.equal(migrated.schema, 18);
  assert.equal(migrateHostedIntents(migrated, marker), migrated);
  assert.equal(data.schema, 15);
  data.revision = 6;
  assert.throws(
    () => migrateHostedIntents(data, marker),
    e => e.code === 'INVALID_WORK_JOURNAL',
  );
});

test('hosted conversion treats journal-proven planning writes on an Intent UUID as edits', () => {
  const id = randomUUID(),
    operationId = randomUUID(),
    at = '2026-01-01T00:00:00Z';
  const command = {
    action: 'put-planning-item',
    operationId,
    itemId: id,
    expectedVersion: 0,
    kind: 'issue',
    title: 'Planning title',
    body: 'Planning description',
    status: 'open',
    intentIds: [],
  };
  const data = workSchema.parse({
    schema: 15,
    revision: 1,
    lanes: [],
    views: [],
    intents: [
      {
        id,
        outcome: 'Execution title',
        constraints: '',
        base: 'a'.repeat(64),
        status: 'active',
        notes: [],
        createdAt: at,
      },
    ],
    planningItems: [
      {
        ...command,
        id,
        version: 1,
        previousVersion: 0,
        request: 'a'.repeat(64),
        at,
        provenance: 'user-declared-local',
      },
    ],
    hostedEvents: [
      {
        id: operationId,
        projectKey: randomUUID(),
        archiveSha256: 'a'.repeat(64),
        previousRevision: 0,
        actor: 'owner',
        at,
        request: 'a'.repeat(64),
        command,
      },
    ],
  });
  const result = migrateHostedIntents(data, { operationId: randomUUID(), revision: 1 });
  assert.equal(result.intents.length, 1);
  assert.equal(result.intents[0].id, id);
  assert.equal(result.intents[0].description, 'Planning description');
  assert.equal(result.intents[0].title, 'Planning title');
  assert.equal(result.intents[0].outcome, 'Planning title');
  assert.equal(result.intentMergeReceipt.counts.before.sameIdentityEdits, 1);
  assert.equal(result.intentMergeReceipt.counts.foldedPairs, 0);
  assert.deepEqual(result.planningItems, data.planningItems);
  assert.deepEqual(result.hostedEvents, data.hostedEvents);
});

test('automatic journal replay retains legacy digests while preserving schema-16 fields after cutover', async () => {
  const { applyHostedEvent, metadataRequest } = await import('../dist/work-metadata.js');
  const legacy = workSchema.parse({ schema: 15, revision: 0, intents: [], lanes: [], views: [] });
  const unified = migrateHostedIntents(legacy, { operationId: randomUUID(), revision: 0 });
  const command = {
    action: 'intent',
    outcome: 'Synthetic automatic outcome',
    constraints: '',
    base: 'a'.repeat(64),
  };
  const event = {
    id: randomUUID(),
    projectKey: randomUUID(),
    archiveSha256: 'a'.repeat(64),
    previousRevision: 0,
    actor: 'owner',
    at: '2026-01-01T00:00:00Z',
    request: metadataRequest(command),
    command,
    automatic: {
      actor: 'owner',
      summary: 'Synthetic automatic operation',
      undo: 'Abandon the retained Intent.',
    },
  };
  applyHostedEvent(legacy, event);
  applyHostedEvent(unified, event);
  assert.equal(legacy.schema, 11, 'preserves the existing historical replay representation');
  assert.equal(unified.schema, 18);
  assert.equal(unified.intents[0].title, command.outcome);
  assert.equal(unified.intents[0].creatorAccountId, 'owner');
});
