// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { workSchema } from '../dist/work-types.js';
import { migrateHostedIntents } from '../dist/work-hosted-intents.js';
const migration = await import(moduleUrl('../convex/projectIntentMigration.ts'));
const index = await import(moduleUrl('../convex/projectWorkIndexStore.ts'));
function setup() {
  const s = state([]),
    operationId = randomUUID();
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    owner: 'owner',
    work: { backupId: 'backup', generationId: 'old', revision: 5, initialRevision: 0 },
  });
  s.tables.projectWorkGenerations.set('old', {
    _id: 'old',
    projectId: 'project',
    backupId: 'backup',
    status: 'ready',
    revision: 5,
    metadata: JSON.stringify({ schema: 15 }),
  });
  const input = {
    projectId: 'project',
    owner: 'owner',
    operationId,
    backupId: 'backup',
    revision: 5,
    metadata: JSON.stringify({ schema: 16 }),
  };
  const begin = (patch = {}) => migration.begin._handler(s.ctx, { ...input, ...patch });
  const publish = (generationId, patch = {}) =>
    migration.publish._handler(s.ctx, {
      projectId: 'project',
      owner: 'owner',
      operationId,
      generationId,
      batches: 0,
      metadata: input.metadata,
      ...patch,
    });
  return { ...s, input, begin, publish };
}
test('migration staging replays the same operation and keeps current generation visible until publication', async () => {
  const s = setup(),
    first = await s.begin();
  assert.equal((await s.begin())._id, first._id);
  assert.equal(s.tables.hostedProjects.get('project').work.generationId, 'old');
  assert.equal(first.status, 'building');
  assert.equal(s.tables.projectWorkGenerations.size, 2);
});
test('migration CAS catches a journal race and reconstructs at the caught-up revision', async () => {
  const s = setup(),
    first = await s.begin();
  s.tables.projectWorkHeads.set('head', {
    _id: 'head',
    projectId: 'project',
    backupId: 'backup',
    revision: 6,
  });
  assert.equal(await s.publish(first._id), false);
  assert.equal(await s.begin(), null);
  const caughtUp = await s.begin({ revision: 6 });
  assert.notEqual(caughtUp._id, first._id);
  assert.equal(await s.publish(caughtUp._id), true);
  assert.equal(s.tables.hostedProjects.get('project').work.intentMigration.revision, 6);
});
test('migration CAS rejects a concurrently selected source backup', async () => {
  const s = setup(),
    first = await s.begin();
  s.tables.hostedProjects.get('project').work.backupId = 'new-backup';
  assert.equal(await s.publish(first._id), false);
  assert.equal(await s.begin(), null);
});
test('migration refuses incomplete batches and a schema-15 projection', async () => {
  const s = setup(),
    first = await s.begin();
  for (const patch of [{ batches: 1 }, { metadata: '{"schema":15}' }])
    await assert.rejects(s.publish(first._id, patch), e => e.code === 'INVALID_WORK_JOURNAL');
  assert.equal(s.tables.hostedProjects.get('project').work.generationId, 'old');
});
test('publication is retry safe and retains both generations plus original backup/event bytes', async () => {
  const s = setup(),
    first = await s.begin();
  s.tables.projectWorkEvents.set('original', { command: 'original command bytes' });
  s.tables.projectBackups.set('backup', { digest: 'original source pin' });
  assert.equal(await s.publish(first._id), true);
  assert.equal(await s.publish(first._id), true);
  assert.equal(s.tables.projectWorkHeads.values().next().value.revision, 5);
  await index.retire._handler(s.ctx, { generationId: 'old' });
  assert.ok(s.tables.projectWorkGenerations.has('old'));
  assert.equal(s.tables.projectWorkEvents.get('original').command, 'original command bytes');
  assert.equal(s.tables.projectBackups.get('backup').digest, 'original source pin');
  assert.equal(await s.publish(first._id, { operationId: randomUUID() }), false);
});
test('staging and final publication require the current active owner', async () => {
  const s = setup();
  await assert.rejects(s.begin({ owner: 'contributor' }), e => e.code === 'PROJECT_UNAVAILABLE');
  const first = await s.begin();
  await assert.rejects(s.publish(first._id, { owner: 'contributor' }), e => e.code === 'PROJECT_UNAVAILABLE');
  s.tables.hostedProjects.get('project').removal = 'trash';
  await assert.rejects(s.publish(first._id), e => e.code === 'PROJECT_UNAVAILABLE');
});
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

test('source-return validation refuses a schema downgrade after unified migration', async () => {
  const { validateSourceReturn } = await import('../dist/work-source-return.js');
  const legacy = workSchema.parse({ schema: 15, revision: 0, intents: [], lanes: [], views: [] });
  const unified = migrateHostedIntents(legacy, { operationId: randomUUID(), revision: 0 });
  assert.throws(
    () => validateSourceReturn(unified, legacy, {}),
    e => e.code === 'WORK_UPGRADE_REQUIRED',
  );
});

test('a schema-15 source return staged before cutover cannot publish after the migration CAS', async () => {
  const s = setup(),
    staged = await s.begin();
  await s.publish(staged._id);
  const work = await import(moduleUrl('../convex/projectWork.ts'));
  await assert.rejects(
    work.returnSource._handler(s.ctx, {
      projectId: 'project',
      owner: 'owner',
      operationId: randomUUID(),
      request: 'a'.repeat(64),
      command: '{}',
      backupId: 'candidate',
      expectedBackupId: 'backup',
      expectedRevision: 5,
      localRevision: 5,
      projection: { generationId: 'old', metadata: '{"schema":15}', entries: [], removed: [] },
    }),
    e => e.data?.code === 'WORK_UPGRADE_REQUIRED',
  );
  assert.equal(s.tables.hostedProjects.get('project').work.generationId, staged._id);
  assert.equal(s.tables.projectWorkEvents.size, 0);
});

test('retaining the previous generation also protects its physical record partition from cleanup', async () => {
  const s = setup();
  s.tables.projectWorkGenerations.get('old').recordsGenerationId = 'partition';
  s.tables.projectWorkGenerations.set('partition', {
    _id: 'partition',
    projectId: 'project',
    status: 'building',
  });
  s.tables.projectWorkRecords.set('legacy-row', {
    _id: 'legacy-row',
    projectId: 'project',
    generationId: 'partition',
  });
  const staged = await s.begin();
  await s.publish(staged._id);
  const partitions = await import(moduleUrl('../convex/projectReturnIndexStage.ts'));
  await partitions.retirePartition._handler(s.ctx, { projectId: 'project', partitionId: 'partition' });
  await index.retire._handler(s.ctx, { generationId: 'partition' });
  assert.ok(s.tables.projectWorkRecords.has('legacy-row'));
  assert.ok(s.tables.projectWorkGenerations.has('partition'));
});

test('migration retries return the original result after later generation selections; another request is a no-op', async () => {
  const s = setup(),
    staged = await s.begin();
  await s.publish(staged._id);
  s.tables.hostedProjects.get('project').work.generationId = 'later-generation';
  const actions = await import(moduleUrl('../convex/projectIntentMigrationActions.ts'));
  const work = await import(moduleUrl('../convex/projectWork.ts'));
  s.ctx.runQuery = (_ref, args) => work.owner._handler(s.ctx, args);
  const input = { projectId: 'project', operationId: s.input.operationId };
  assert.equal(await actions.migrate._handler(s.ctx, input), staged._id);
  assert.equal(await actions.migrate._handler(s.ctx, { ...input, operationId: randomUUID() }), staged._id);
  s.caller('stranger');
  await assert.rejects(actions.migrate._handler(s.ctx, input), e => e.data?.code === 'PROJECT_UNAVAILABLE');
});

test('a rebuild resumes the unified generation instead of reusing a retained schema-15 generation', async () => {
  const s = setup(),
    staged = await s.begin();
  await s.publish(staged._id);
  s.tables.hostedProjects.get('project').work.generationId = undefined;
  const args = {
    projectId: 'project',
    owner: 'owner',
    backupId: 'backup',
    revision: 5,
    initialRevision: 0,
    metadata: '{"schema":16}',
  };
  const rebuilt = await index.begin._handler(s.ctx, args);
  assert.equal(rebuilt._id, staged._id);
  assert.equal(JSON.parse(rebuilt.metadata).schema, 16);
  assert.notEqual(rebuilt._id, 'old');
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

test('a legacy index build cannot publish or continue staging after same-revision unified cutover', async () => {
  const s = setup(),
    staged = await s.begin();
  await s.publish(staged._id);
  assert.equal(
    await index.begin._handler(s.ctx, {
      projectId: 'project',
      owner: 'owner',
      backupId: 'backup',
      revision: 5,
      initialRevision: 0,
      metadata: '{"schema":15}',
    }),
    null,
  );
  assert.equal(
    await index.batch._handler(s.ctx, {
      projectId: 'project',
      owner: 'owner',
      generationId: 'old',
      batch: 0,
      entries: [],
    }),
    false,
  );
  assert.equal(
    await index.publish._handler(s.ctx, {
      projectId: 'project',
      owner: 'owner',
      generationId: 'old',
      batches: 0,
      metadata: '{"schema":15}',
    }),
    false,
  );
  assert.equal(
    await index.publish._handler(s.ctx, {
      projectId: 'project',
      owner: 'owner',
      generationId: staged._id,
      batches: 0,
      metadata: '{"schema":15}',
    }),
    false,
  );
  assert.equal(s.tables.hostedProjects.get('project').work.generationId, staged._id);
  assert.equal(JSON.parse(s.tables.projectWorkHeads.values().next().value.metadata).schema, 16);
});

for (const schema of [16, 18, 20])
  test(`migration generation publication accepts unified format ${schema} during rollout`, async () => {
    const s = setup();
    s.input.metadata = JSON.stringify({ schema });
    const staged = await s.begin();
    assert.equal(staged.workSchema, schema);
    assert.equal(await s.publish(staged._id), true);
    assert.equal(JSON.parse(s.tables.projectWorkHeads.values().next().value.metadata).schema, schema);
  });

for (const [format, size, target] of [
  [17, 4, 18],
  [19, 8, 20],
])
  test(`hosted conversion preserves format${format} ${size}-entry batches in format${target}`, () => {
    const id = randomUUID(),
      hash = 'a'.repeat(64);
    const data = workSchema.parse({
      schema: format,
      revision: 4,
      intents: [],
      lanes: [],
      views: [],
      landingEntries: [
        {
          id,
          request: hash,
          channel: 'main',
          viewId: randomUUID(),
          head: hash,
          checkId: randomUUID(),
          definition: hash,
          environment: hash,
          arrivedAt: 'synthetic',
          submitter: 'synthetic',
          keepOpen: false,
          status: 'queued',
        },
      ],
      landingBatches: [
        {
          id: randomUUID(),
          channel: 'main',
          base: hash,
          previous: null,
          arrivedAt: 'synthetic',
          entryIds: [id, ...Array.from({ length: size - 1 }, () => randomUUID())],
          mode: 'parallel',
          status: 'composing',
          prefixes: [],
          conflicts: [],
        },
      ],
    });
    const migrated = migrateHostedIntents(data, { operationId: randomUUID(), revision: 4 });
    assert.equal(migrated.schema, target);
    assert.deepEqual(migrated.landingEntries, data.landingEntries);
    assert.deepEqual(migrated.landingBatches, data.landingBatches);
    for (const schema of [16, 18, 20]) {
      const unified = { ...migrated, schema };
      assert.equal(migrateHostedIntents(unified, { operationId: randomUUID(), revision: 4 }), unified);
    }
  });
