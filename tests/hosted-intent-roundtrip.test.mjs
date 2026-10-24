// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { setup, actions } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { WorkStore } from '../dist/work-store.js';
import { restoreNativeWork } from '../dist/native-backup.js';
import { mergeCompanion } from '../dist/native-companion.js';
const migration = await import(moduleUrl('../convex/projectIntentMigration.ts'));
const migrationActions = await import(moduleUrl('../convex/projectIntentMigrationActions.ts'));
const commands = await import(moduleUrl('../convex/projectWorkCommand.ts'));
async function fixture(t) {
  const s = await setup(t, true, (_root, local) => {
    const data = local.store.load();
    data.schema = 15;
    local.store.save(data);
  });
  const original = s.ctx.runMutation;
  s.ctx.runMutation = async (ref, args) => {
    const [module, name] = getFunctionName(ref).split(':');
    return module === 'projectIntentMigration' ? migration[name]._handler(s.ctx, args) : original(ref, args);
  };
  const migrate = operationId =>
    migrationActions.migrate._handler(s.ctx, { projectId: s.projectId, operationId });
  return { ...s, migrate };
}
test('hosted cutover, subsequent journal writes and recovery into a fresh schema-16 owner preserve original commands', async t => {
  const s = await fixture(t),
    issue = s.item({ title: 'One unified outcome' });
  await s.send(issue);
  const original = JSON.stringify([...s.tables.projectWorkEvents.values()]);
  const operationId = randomUUID(),
    generationId = await s.migrate(operationId);
  assert.equal(await s.migrate(operationId), generationId);
  assert.equal(JSON.stringify([...s.tables.projectWorkEvents.values()]), original);
  const migrated = await s.read();
  assert.equal(migrated.data.schema, 18);
  assert.equal(migrated.data.intents.find(i => i.id === issue.itemId).title, issue.title);
  const note = { action: 'note', intentId: issue.itemId, text: 'After cutover', kind: 'comment' };
  const input = { projectId: s.projectId, operationId: randomUUID(), command: JSON.stringify(note) };
  const receipt = await commands.command._handler(s.ctx, input);
  assert.equal((await commands.command._handler(s.ctx, input))._id, receipt._id);
  const after = await s.read();
  assert.equal(after.data.intents.find(i => i.id === issue.itemId).notes.at(-1).text, note.text);
  const journal = await actions.exportJournal._handler(s.ctx, { projectId: s.projectId });
  const journalPath = join(s.directory, 'unified-journal.json');
  writeFileSync(journalPath, journal);
  const target = join(s.directory, 'recovered');
  await restoreNativeWork(s.exported.archive.path, target, journalPath);
  const recovered = new WorkStore(target).load();
  assert.equal(recovered.schema, 18);
  assert.deepEqual(recovered.intents, after.data.intents);
  assert.deepEqual(recovered.hostedEvents, after.data.hostedEvents);
  assert.equal(JSON.parse(journal).workSha256, digest(JSON.stringify(after.data, null, 2)));
  assert.ok(readFileSync(s.exported.archive.path).length > 0);
});
test('schema-16 local companion accepts a schema-15 hosted note without downgrading the owner', async t => {
  const s = await fixture(t);
  const created = await s.send({
    action: 'intent',
    outcome: 'Pinned execution',
    constraints: '',
    base: s.preview.head,
  });
  const base = (await s.read()).data;
  const { convertWork15To16 } = await import('../dist/work-intent-converter.js');
  const local = convertWork15To16(base);
  await s.send({
    action: 'note',
    intentId: created.operationId,
    text: 'Hosted observation',
    kind: 'comment',
  });
  const hosted = (await s.read()).data,
    result = mergeCompanion(base, local, hosted);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.merged.schema, 18);
  assert.equal(result.merged.intents[0].notes.at(-1).text, 'Hosted observation');
});

test('reconciling and retrying a hosted schema-15 journal saves into an existing schema-16 owner', async t => {
  let intentId;
  const s = await setup(t, true, async (_root, local) => {
    const created = await local.dispatch(
      { action: 'intent', outcome: 'Preserve the migrated owner', constraints: '' },
      local.store.revision(),
    );
    intentId = created.result.id;
    await local.dispatch(
      { action: 'note', intentId, text: 'Retained pre-migration note', kind: 'decision' },
      local.store.revision(),
    );
    const data = local.store.load();
    data.schema = 15;
    local.store.save(data);
  });
  const { convertWork15To16 } = await import('../dist/work-intent-converter.js');
  const unified = convertWork15To16(s.local.store.load());
  unified.futureOwnerFact = { keep: true };
  s.local.store.save(unified);
  await s.local.dispatch(
    { action: 'note', intentId, text: 'Local concurrent observation', kind: 'comment' },
    s.local.store.revision(),
  );
  await s.send({ action: 'note', intentId, text: 'Received after local migration', kind: 'comment' });
  const journal = await actions.exportJournal._handler(s.ctx, { projectId: s.projectId });
  const journalPath = join(s.directory, 'receive-unified-journal.json');
  writeFileSync(journalPath, journal);
  const command = {
    action: 'reconcile-hosted-work',
    operationId: randomUUID(),
    projectKey: s.tables.hostedProjects.get(s.projectId).key,
    archivePath: s.exported.archive.path,
    archiveSha256: digest(s.bytes),
    journalPath,
    journalSha256: digest(journal),
  };
  const result = await s.local.dispatch(command, s.local.store.revision());
  assert.equal(result.result.status, 'reconciled', JSON.stringify(result.result.conflicts));
  const saved = s.local.store.load();
  assert.equal(saved.schema, 18);
  assert.deepEqual(saved.futureOwnerFact, unified.futureOwnerFact);
  assert.deepEqual(saved.intentMergeReceipt, unified.intentMergeReceipt);
  const intent = saved.intents.find(i => i.id === intentId);
  assert.deepEqual(
    intent.notes.map(note => note.text),
    ['Retained pre-migration note', 'Received after local migration', 'Local concurrent observation'],
  );
  assert.deepEqual(
    intent.conversation.map(entry => entry.index),
    [0, 1, 2],
  );
  assert.equal(new Set(intent.conversation.map(entry => entry.id)).size, 3);
  await s.local.dispatch(command, s.local.store.revision());
  const retried = s.local.store.load();
  assert.equal(retried.intents.find(i => i.id === intentId).notes.length, 3);
  assert.equal(retried.nativeCompanionReceipts.filter(r => r.id === command.operationId).length, 1);
});

test('Git export-work and restore retain schema-16 planned Intents and unknown fields', async t => {
  const s = await setup(t, false);
  const issue = s.item({ title: 'Unpinned Git planning outcome' });
  await s.local.dispatch(issue, s.local.store.revision());
  const { convertWork15To16 } = await import('../dist/work-intent-converter.js');
  const legacy = s.local.store.load();
  const unified = convertWork15To16({ ...legacy, schema: 15 });
  unified.futureTransportFact = { retain: 'synthetic extension' };
  s.local.store.save(unified);
  const exported = (
    await s.local.dispatch({ action: 'export-work', archive: true }, s.local.store.revision())
  ).result;
  const { restoreWork } = await import('../dist/work-backup.js');
  const target = join(s.directory, 'git-unified-recovered');
  await restoreWork(exported.archive.path, target);
  const recovered = new WorkStore(target).load();
  assert.equal(recovered.schema, 16);
  assert.equal(recovered.intents.find(intent => intent.id === issue.itemId).base, undefined);
  assert.deepEqual(recovered.futureTransportFact, unified.futureTransportFact);
});

test('a journal export racing same-revision format cutover retries instead of exporting the pre-cutover representation', async t => {
  const s = await fixture(t);
  await s.send(s.item());
  const query = s.ctx.runQuery;
  let reads = 0;
  s.ctx.runQuery = async (ref, args) => {
    if (getFunctionName(ref) === 'projectWork:get' && ++reads === 2) {
      const project = s.tables.hostedProjects.get(s.projectId);
      const revision = [...s.tables.projectWorkHeads.values()].find(
        h => h.projectId === s.projectId,
      ).revision;
      project.work.intentMigration = {
        operationId: randomUUID(),
        revision,
        generationId: 'published-during-read',
      };
    }
    return query(ref, args);
  };
  await assert.rejects(
    actions.exportJournal._handler(s.ctx, { projectId: s.projectId }),
    e => e.data?.code === 'WORK_CHANGED_DURING_PUSH',
  );
});

test('oversized unified summaries retain note positions and every existing note during an append', async t => {
  const { convertWork15To16 } = await import('../dist/work-intent-converter.js');
  let intentId;
  const s = await setup(t, true, async (_root, local) => {
    const created = await local.dispatch(
      { action: 'intent', outcome: 'Oversized assignments', constraints: '' },
      local.store.revision(),
    );
    intentId = created.result.id;
    const data = local.store.load();
    data.intents[0].notes = Array.from({ length: 3 }, (_, i) => ({
      text: `Retained note ${i}`,
      kind: 'comment',
      at: '2026-01-01T00:00:00Z',
    }));
    const unified = convertWork15To16({ ...data, schema: 15 });
    unified.intents[0].assigneeAccountIds = ['assigned', 'x'.repeat(40000)];
    local.store.save(unified);
  });
  await s.send({ action: 'note', intentId, text: 'New fourth note', kind: 'comment' });
  const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
  const page = await index.records._handler(s.ctx, {
    projectId: s.projectId,
    collection: 'notes',
    parentId: intentId,
    paginationOpts: { cursor: null, numItems: 100 },
  });
  const notes = page.page.map(row => JSON.parse(row.value));
  assert.deepEqual(
    notes.map(note => [note.index, note.text]),
    [
      [0, 'Retained note 0'],
      [1, 'Retained note 1'],
      [2, 'Retained note 2'],
      [3, 'New fourth note'],
    ],
  );
  const header = await index.detail._handler(s.ctx, {
    projectId: s.projectId,
    collection: 'intents',
    id: intentId,
  });
  assert.equal(JSON.parse(header.value).noteCount, 4);
});

test('hosted planning link removal updates both indexed Intents and preserves original history', async t => {
  const s = await fixture(t);
  const first = await s.send({
    action: 'intent',
    outcome: 'First outcome',
    constraints: '',
    base: s.preview.head,
  });
  const second = await s.send({
    action: 'intent',
    outcome: 'Second outcome',
    constraints: '',
    base: s.preview.head,
  });
  const item = s.item({ intentIds: [first.operationId, second.operationId] });
  await s.send(item);
  await s.migrate(randomUUID());
  const before = (await s.read()).data;
  const originals = JSON.stringify(before.legacyIntentMerge);
  await s.send({ ...item, operationId: randomUUID(), expectedVersion: 1, intentIds: [] });
  const after = (await s.read()).data;
  assert.ok(after.intents.every(intent => intent.relatedIntentIds.length === 0));
  assert.equal(JSON.stringify(after.legacyIntentMerge), originals);
  assert.equal(after.planningItems.filter(version => version.id === item.itemId).length, 2);
  const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
  for (const id of [item.itemId, first.operationId, second.operationId]) {
    const row = await index.detail._handler(s.ctx, { projectId: s.projectId, collection: 'intents', id });
    const header = JSON.parse(row.value);
    const parts = header.payloadKey
      ? (
          await index.records._handler(s.ctx, {
            projectId: s.projectId,
            collection: 'intents:payload',
            parentId: header.payloadKey,
            paginationOpts: { cursor: null, numItems: 100 },
          })
        ).page
      : [];
    const { assembleIndexValue } = await import('../dist/work-index-value.js');
    assert.deepEqual(assembleIndexValue('intents', header, parts).relatedIntentIds, []);
  }
});
