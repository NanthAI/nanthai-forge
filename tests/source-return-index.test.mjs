// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { setup, returns } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { materializeWork } from '../dist/work-hosted-index.js';
import { preparedCheckpoint, modules } from './project-exchange-fixture.mjs';
import { dispatchHostedWork } from '../dist/hosted-work-client.js';
const indexActions = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const indexStore = await import(moduleUrl('../convex/projectWorkIndexStore.ts'));
const entry = row => ({
  collection: row.collection,
  key: row.key,
  parent: row.parent,
  position: row.collection === 'notes' ? 0 : row.position,
  value: row.collection.endsWith(':payload') ? row.value : JSON.parse(row.value),
  ...(row.status === undefined ? {} : { status: row.status }),
});
const ordered = rows =>
  rows
    .filter(row => !['sourceAncestryClosure', 'sourceAncestryChunk'].includes(row.collection))
    .map(entry)
    .sort((a, b) =>
      JSON.stringify([a.collection, a.key]).localeCompare(JSON.stringify([b.collection, b.key])),
    );
function wireObjects(s) {
  s.ctx.storage.generateUploadUrl = async () => 'https://fixture.invalid/upload';
  for (const method of ['runQuery', 'runMutation', 'runAction']) {
    const run = s.ctx[method];
    s.ctx[method] = (ref, args) => {
      const [name, action] = getFunctionName(ref).split(':');
      return modules[name]?.[action]?._handler(s.ctx, args) ?? run(ref, args);
    };
  }
}
async function candidate(s, mutate = () => {}) {
  const snapshot = await s.read(),
    data = structuredClone(snapshot.data);
  mutate(data);
  data.revision++;
  s.local.store.save(data);
  const next = await preparedCheckpoint(s, s.local.store);
  next.input.previous = snapshot.backupId;
  const backupId = await modules.projectExchangeActions.publish._handler(s.ctx, next.input);
  return {
    projectId: s.projectId,
    backupId,
    expectedBackupId: snapshot.backupId,
    revision: snapshot.data.revision,
    operationId: randomUUID(),
    continuation: true,
  };
}
async function nativeSetup(t) {
  const s = await setup(t, true, (_root, local) => {
    const data = local.store.load();
    for (let i = 0; i < 250; i++)
      data.intents.push({
        id: randomUUID(),
        outcome: `Task ${i}`,
        constraints: '',
        base: data.nativeHead,
        status: 'active',
        createdAt: 'start',
        notes: [],
      });
    data.revision++;
    local.store.save(data);
  });
  wireObjects(s);
  return s;
}
test('source return retains public generation, reuses rows and invalidates held CLI cursors by source revision', async t => {
  const s = await nativeSetup(t),
    initial = await s.read(),
    [one, two] = initial.data.intents;
  const generationId = await indexActions.ensure._handler(s.ctx, { projectId: s.projectId });
  await s.send({ action: 'note', intentId: two.id, text: 'Second Intent first', kind: 'comment' });
  await s.send({ action: 'note', intentId: one.id, text: 'First Intent later', kind: 'comment' });
  assert.equal(
    [...s.tables.projectWorkRecords.values()].find(row => row.collection === 'notes' && row.parent === one.id)
      .position,
    1,
  );
  const client = {
    query: (...args) => s.ctx.runQuery(...args),
    action: (...args) => s.ctx.runAction(...args),
  };
  const held = await dispatchHostedWork(client, s.projectId, {
    action: 'records',
    collection: 'notes',
    pageSize: 1,
  });
  const request = await candidate(s, data =>
    data.intents[0].notes.push({ text: 'Local append', kind: 'comment', at: 'local' }),
  );
  const originalPatch = s.ctx.db.patch,
    originalInsert = s.ctx.db.insert;
  let writes = 0;
  s.ctx.db.patch = async (id, fields) => {
    if (s.tables.projectWorkRecords.has(id)) writes++;
    return originalPatch(id, fields);
  };
  s.ctx.db.insert = async (table, fields) => {
    if (table === 'projectWorkRecords') writes++;
    return originalInsert(table, fields);
  };
  const returned = await returns.returnSource._handler(s.ctx, request);
  const project = s.tables.hostedProjects.get(s.projectId),
    generation = s.tables.projectWorkGenerations.get(project.work.generationId);
  assert.equal(project.work.generationId, generationId);
  assert.equal(generation.recordsGenerationId, undefined);
  assert.equal(generation.backupId, request.backupId);
  assert.equal(generation.revision, returned.revision);
  assert.ok(writes < 15, `changed records only: ${writes}`);
  const current = await s.read(),
    backup = s.tables.projectBackups.get(request.backupId),
    source = await (
      await import(moduleUrl('../convex/projectWorkActions.ts'))
    ).source(s.ctx, request.backupId, 'owner');
  const expected = materializeWork(current.data, source.manifest, current.events, backup.transport);
  assert.deepEqual(
    ordered([...s.tables.projectWorkRecords.values()].filter(row => row.generationId === generationId)),
    ordered(expected.entries),
  );
  const metadata = JSON.parse(generation.metadata);
  for (const name of ['sourceAncestryClosure', 'sourceAncestryChunk']) delete metadata.counts[name];
  assert.deepEqual(metadata, expected.metadata);
  assert.equal(
    JSON.parse(
      [...s.tables.projectWorkRecords.values()].find(
        row => row.collection === 'events' && row.key === request.operationId,
      ).value,
    ).at,
    returned.at,
  );
  const count = writes;
  assert.equal((await returns.returnSource._handler(s.ctx, request))._id, returned._id);
  assert.equal(writes, count);
  assert.equal(await indexActions.ensure._handler(s.ctx, { projectId: s.projectId }), generation._id);
  await assert.rejects(
    dispatchHostedWork(client, s.projectId, {
      action: 'records',
      collection: 'notes',
      pageSize: 1,
      cursor: held.continueCursor,
    }),
    error => error.code === 'WORK_STALE',
  );
  const retainedDetail = await dispatchHostedWork(client, s.projectId, {
    action: 'detail',
    collection: 'intents',
    id: one.id,
    generationId,
  });
  assert.equal(retainedDetail.value.id, one.id);
  const fresh = await dispatchHostedWork(client, s.projectId, {
    action: 'records',
    collection: 'notes',
    pageSize: 10,
  });
  assert.deepEqual(
    fresh.page.map(row => row.value.text),
    ['Second Intent first', 'First Intent later', 'Local append'],
  );
  await indexStore.retire._handler(s.ctx, { generationId });
  assert.ok(s.tables.projectWorkGenerations.has(generationId), 'active physical partition cannot retire');
  await s.send({ action: 'note', intentId: one.id, text: 'Hot append after source return', kind: 'comment' });
  const detail = await dispatchHostedWork(client, s.projectId, {
    action: 'detail',
    collection: 'intents',
    id: one.id,
  });
  assert.equal(detail.value.noteCount, 3);
  const second = await candidate(s);
  await returns.returnSource._handler(s.ctx, second);
  const latest = s.tables.projectWorkGenerations.get(project.work.generationId);
  assert.equal(latest._id, generation._id);
  assert.equal(latest.recordsGenerationId, undefined, 'the original partition remains selected');
  await indexStore.retire._handler(s.ctx, { generationId: generation._id });
  assert.equal(s.tables.projectWorkGenerations.has(generation._id), true);
  assert.ok(s.tables.projectWorkRecords.size > 250);
  const large = await candidate(s, data => {
    data.intents[0].notes.push(
      ...Array.from({ length: 150 }, (_, i) => ({ text: `Large local ${i}`, kind: 'comment', at: 'later' })),
    );
  });
  await returns.returnSource._handler(s.ctx, large);
  assert.equal(project.work.generationId, generationId);
  const rebuilt = await indexActions.ensure._handler(s.ctx, { projectId: s.projectId });
  assert.equal(rebuilt, generationId);
  const partition = s.tables.projectWorkGenerations.get(rebuilt).recordsGenerationId;
  assert.equal(partition, undefined, 'this append fits the current bounded delta transaction');
});
test('metadata deltas retain the generation without consulting the legacy snapshot reader', async t => {
  for (const unavailable of [false, true]) {
    const s = await nativeSetup(t);
    await indexActions.ensure._handler(s.ctx, { projectId: s.projectId });
    const request = await candidate(s, data => {
      if (!unavailable)
        data.intents[0].notes.push(
          ...Array.from({ length: 150 }, (_, i) => ({ kind: 'comment', text: `Local ${i}`, at: 'local' })),
        );
    });
    const query = s.ctx.runQuery;
    if (unavailable)
      s.ctx.runQuery = (ref, input) => {
        if (getFunctionName(ref) === 'projectWorkIndexStore:snapshotEntries')
          throw Error('derived read unavailable');
        return query(ref, input);
      };
    const result = await returns.returnSource._handler(s.ctx, request);
    assert.equal(s.tables.hostedProjects.get(s.projectId).work.backupId, request.backupId);
    assert.equal(result.revision, request.revision + 2);
    assert.equal(Boolean(s.tables.hostedProjects.get(s.projectId).work.generationId), true);
    s.ctx.runQuery = query;
    assert.ok(await indexActions.ensure._handler(s.ctx, { projectId: s.projectId }));
  }
});
test('a concurrent hosted edit during index paging preserves current source, generation and original event', async t => {
  const s = await nativeSetup(t),
    generationId = await indexActions.ensure._handler(s.ctx, { projectId: s.projectId }),
    request = await candidate(s, data => {
      data.intents[0].notes.push({ kind: 'comment', text: 'Local append', at: 'local' });
    });
  const query = s.ctx.runQuery;
  let raced = false;
  s.ctx.runQuery = async (ref, input) => {
    const result = await query(ref, input);
    if (getFunctionName(ref) === 'projectWorkIndexStore:lookups' && !raced) {
      raced = true;
      const data = await s.read();
      await s.send({
        action: 'note',
        intentId: data.data.intents[0].id,
        kind: 'comment',
        text: 'Concurrent original',
      });
    }
    return result;
  };
  await assert.rejects(
    returns.returnSource._handler(s.ctx, request),
    error => error.data?.code === 'WORK_STALE',
  );
  assert.equal(raced, true, 'the hosted edit occurred while selecting replacement rows');
  const project = s.tables.hostedProjects.get(s.projectId);
  assert.equal(project.work.backupId, s.backupId);
  assert.equal(project.work.generationId, generationId);
  assert.equal(
    [...s.tables.projectWorkEvents.values()].some(event => event.operationId === request.operationId),
    false,
  );
  assert.equal((await s.read()).data.intents[0].notes.at(-1).text, 'Concurrent original');
});
test('source return removes obsolete payload rows while retaining exact unknown replacement fields', async t => {
  const s = await setup(t, true, (_root, local) => {
    const data = local.store.load();
    data.intents.push({
      id: randomUUID(),
      outcome: 'Large extension',
      constraints: '',
      base: data.nativeHead,
      status: 'active',
      createdAt: 'start',
      notes: [],
      extension: 'x'.repeat(100000),
    });
    data.revision++;
    local.store.save(data);
  });
  wireObjects(s);
  const generationId = await indexActions.ensure._handler(s.ctx, { projectId: s.projectId });
  const oldPayload = [...s.tables.projectWorkRecords.values()]
    .filter(row => row.collection === 'intents:payload')
    .map(row => row._id);
  assert.ok(oldPayload.length > 1);
  const request = await candidate(s, data => {
    data.intents[0].extension = { nested: 'retained replacement' };
  });
  await returns.returnSource._handler(s.ctx, request);
  assert.equal(
    s.tables.projectWorkGenerations.get(s.tables.hostedProjects.get(s.projectId).work.generationId)._id,
    generationId,
  );
  for (const id of oldPayload) assert.equal(s.tables.projectWorkRecords.has(id), false);
  const parts = [...s.tables.projectWorkRecords.values()]
    .filter(row => row.collection === 'intents:payload')
    .sort((a, b) => a.position - b.position);
  assert.deepEqual(JSON.parse(parts.map(row => row.value).join('')).extension, {
    nested: 'retained replacement',
  });
});
test('index optimization never bypasses final current-owner authorization', async t => {
  const s = await nativeSetup(t),
    generationId = await indexActions.ensure._handler(s.ctx, { projectId: s.projectId }),
    request = await candidate(s),
    query = s.ctx.runQuery;
  s.ctx.runQuery = async (ref, input) => {
    const result = await query(ref, input);
    if (getFunctionName(ref) === 'projectWorkIndexStore:lookups')
      s.tables.hostedProjects.get(s.projectId).owner = 'replacement-owner';
    return result;
  };
  await assert.rejects(
    returns.returnSource._handler(s.ctx, request),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  const project = s.tables.hostedProjects.get(s.projectId);
  assert.equal(project.work.backupId, s.backupId);
  assert.equal(project.work.generationId, generationId);
  assert.equal(
    [...s.tables.projectWorkEvents.values()].some(event => event.operationId === request.operationId),
    false,
  );
});

test('partial source returns preserve unchanged owner decisions in the existing workspace summary', async () => {
  const { readFileSync } = await import('node:fs');

  const { prepareDelta } = await import(moduleUrl('../convex/projectSourceReturnDelta.ts'));
  const { parseWork } = await import('../dist/work-unified-types.js');
  const records = JSON.parse(readFileSync(new URL('./fixtures/owner-decisions.json', import.meta.url)));
  const head = 'a'.repeat(64);
  const data = parseWork(
    {
      schema: 22,
      intentMergeReceipt: {
        converter: 'intent-merge-v1',
        fromSchema: 21,
        toSchema: 22,
        counts: { before: {}, after: {}, foldedPairs: 0 },
        hashes: { input: head, output: head, intents: head, planningItems: head, planningComments: head },
      },
      revision: 1,
      nativeHead: head,
      intents: [],
      lanes: [],
      views: [],
    },
    true,
  );
  const manifest = {
    schema: 1,
    kind: 'forge-native-work-backup',
    id: randomUUID(),
    head,
    revision: 1,
    files: [{ path: `objects/${head}`, sha256: head, size: 1 }],
    unavailable: [],
    coverage: '',
  };
  const full = materializeWork({ ...data, decisions: records }, manifest, []);
  const generation = { metadata: JSON.stringify(full.metadata) };
  const snapshot = values => ({
    data: { ...data, decisions: values },
    manifest,
    backup: { transport: 'objects' },
  });
  const unchanged = prepareDelta(snapshot([]), snapshot([]), generation, true);
  assert.equal(unchanged.metadata.decisionVersion, full.metadata.decisionVersion);
  assert.equal(unchanged.metadata.counts.decisions, 19);
  const next = {
    ...records[0],
    id: randomUUID(),
    operationId: randomUUID(),
    what: 'A new owner decision',
    supersedes: records[0].id,
  };
  const appended = prepareDelta(snapshot([]), snapshot([next]), generation, true);
  assert.notEqual(appended.metadata.decisionVersion, full.metadata.decisionVersion);
  assert.equal(appended.metadata.counts.decisions, 20);
  const removed = prepareDelta(snapshot([records[0]]), snapshot([]), generation, true);
  assert.notEqual(removed.metadata.decisionVersion, full.metadata.decisionVersion);
  assert.equal(removed.metadata.counts.decisions, 18);
});
