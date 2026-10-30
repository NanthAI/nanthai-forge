// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { restoreWorkFormat } from '../dist/work-restore-format.js';
import { setup, actions } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { WorkStore } from '../dist/work-store.js';
import { restoreNativeWork } from '../dist/native-backup.js';

const commands = await import(moduleUrl('../convex/projectWorkCommand.ts'));
async function fixture(t) {
  return setup(t, true);
}
test('current hosted Work, subsequent journal writes and recovery preserve original commands', async t => {
  const s = await fixture(t),
    issue = s.item({ title: 'One unified outcome' });
  await s.send(issue);
  const original = JSON.stringify([...s.tables.projectWorkEvents.values()]);
  assert.equal(JSON.stringify([...s.tables.projectWorkEvents.values()]), original);
  const migrated = await s.read();
  assert.equal(migrated.data.schema, 24);
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
  assert.equal(recovered.schema, 24);
  assert.deepEqual(recovered.intents, after.data.intents);
  assert.deepEqual(recovered.hostedEvents, after.data.hostedEvents);
  assert.equal(JSON.parse(journal).workSha256, digest(JSON.stringify(after.data, null, 2)));
  assert.ok(readFileSync(s.exported.archive.path).length > 0);
});

test('Git export-work and restore retain current planned Intents and unknown fields', async t => {
  const s = await setup(t, false);
  const issue = s.item({ title: 'Unpinned Git planning outcome' });
  await s.local.dispatch(issue, s.local.store.revision());
  const legacy = s.local.store.load();
  const unified = legacy;
  unified.futureTransportFact = { retain: 'synthetic extension' };
  s.local.store.save(restoreWorkFormat(unified));
  const exported = (
    await s.local.dispatch({ action: 'export-work', archive: true }, s.local.store.revision())
  ).result;
  const { restoreWork } = await import('../dist/work-backup.js');
  const target = join(s.directory, 'git-unified-recovered');
  await restoreWork(exported.archive.path, target);
  const recovered = new WorkStore(target).load();
  assert.equal(recovered.schema, 24);
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
    const unified = data;
    unified.intents[0].assigneeAccountIds = ['assigned', 'x'.repeat(40000)];
    local.store.save(restoreWorkFormat(unified));
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
