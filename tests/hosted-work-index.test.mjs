// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { setup, actions } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
import { materializeWork, indexBatches } from '../dist/work-hosted-index.js';
import { WorkStore } from '../dist/work-store.js';
import { workSchema } from '../dist/work-types.js';
const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const store = await import(moduleUrl('../convex/projectWorkIndexStore.ts'));
const indexActions = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const page = (s, collection, parentId) =>
  index.records._handler(s.ctx, {
    projectId: s.projectId,
    collection,
    parentId,
    paginationOpts: { cursor: null, numItems: 100 },
  });

test('indexed hosted commands avoid archive/history replay, preserve reducer results and original retries', async t => {
  const s = await setup(t),
    baseline = await s.read(),
    operationId = randomUUID();
  await actions.command._handler(s.ctx, {
    projectId: s.projectId,
    operationId,
    revision: baseline.data.revision,
    command: JSON.stringify({
      action: 'intent',
      outcome: 'Indexed work',
      constraints: '',
      base: baseline.sourceHead,
    }),
  });
  const before = JSON.parse(await index.workspace._handler(s.ctx, { projectId: s.projectId })),
    original = s.ctx.runQuery,
    commands = [];
  const blocked = (ref, args) => {
    const name = getFunctionName(ref);
    commands.push(name);
    assert.notEqual(name, 'projectWork:events', 'hot commands never replay events');
    return original(ref, args);
  };
  s.ctx.runQuery = blocked;
  const get = s.ctx.storage.get,
    url = s.ctx.storage.getUrl;
  s.ctx.storage.get = s.ctx.storage.getUrl = async () =>
    assert.fail('hot commands never read archive/source blobs');
  const send = async command => {
    const revision = JSON.parse(await index.workspace._handler(s.ctx, { projectId: s.projectId })).revision;
    return actions.command._handler(s.ctx, {
      projectId: s.projectId,
      operationId: command.operationId ?? randomUUID(),
      revision,
      command: JSON.stringify(command),
    });
  };
  const note = { action: 'note', intentId: operationId, kind: 'comment', text: 'One narrow append' },
    noteId = randomUUID();
  const noteEvent = await actions.command._handler(s.ctx, {
    projectId: s.projectId,
    operationId: noteId,
    revision: before.revision,
    command: JSON.stringify(note),
  });
  assert.equal(
    (
      await actions.command._handler(s.ctx, {
        projectId: s.projectId,
        operationId: noteId,
        revision: before.revision,
        command: JSON.stringify(note),
      })
    )._id,
    noteEvent._id,
  );
  await send({ action: 'intent-status', intentId: operationId, status: 'completed' });
  await send({ action: 'intent-status', intentId: operationId, status: 'active' });
  const planning = s.item({ intentIds: [operationId] });
  await send(planning);
  await send({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: planning.itemId,
    text: 'Keep discussion',
    authorLabel: 'Owner',
  });
  const after = JSON.parse(await index.workspace._handler(s.ctx, { projectId: s.projectId }));
  assert.equal(after.generationId, before.generationId);
  assert.equal(after.revision, before.revision + 5);
  assert.equal(after.schema, 11); // new source owner already records its supervised policy
  assert.equal(after.defaultIntentId, operationId);
  assert.equal(after.counts.notes, 1);
  assert.equal(after.counts.lifecycle, 2);
  assert.equal((await page(s, 'notes', operationId)).page.length, 1);
  assert.equal((await page(s, 'lifecycle', operationId)).page.length, 2);
  assert.equal((await page(s, 'planningItems')).page.length, 1);
  const detail = await index.detail._handler(s.ctx, {
    projectId: s.projectId,
    collection: 'intents',
    id: operationId,
  });
  assert.equal(JSON.parse(detail.value).status, 'active');
  assert.equal(detail.editable, true);
  assert.equal(JSON.parse(detail.intentPin).baseState, baseline.sourceHead);
  s.ctx.storage.get = get;
  s.ctx.storage.getUrl = url;
  s.ctx.runQuery = original;
  const full = await s.read(),
    intent = full.data.intents.find(item => item.id === operationId);
  assert.equal(full.data.revision, after.revision);
  assert.equal(intent.notes[0].text, note.text);
  assert.equal(intent.lifecycle.length, 2);
  assert.equal(full.data.planningItems[0].id, planning.itemId);
  assert.equal(full.data.planningComments.length, 1);
  assert.ok(commands.includes('projectWorkIndexStore:lookups'));
});

test('generation publication is atomic, resumable and source-pinned; access loss and cross-project lookups fail', async t => {
  const s = await setup(t),
    snapshot = await s.read(),
    metadata = JSON.stringify({ schema: 1, counts: {} });
  const request = {
    projectId: s.projectId,
    owner: 'owner',
    backupId: s.backupId,
    revision: snapshot.data.revision,
    initialRevision: snapshot.data.revision,
    metadata,
  };
  const first = await store.begin._handler(s.ctx, request),
    retry = await store.begin._handler(s.ctx, request);
  assert.equal(first._id, retry._id);
  assert.equal(await index.workspace._handler(s.ctx, { projectId: s.projectId }), null);
  const entries = [{ collection: 'intents', key: 'one', parent: '', position: 0, value: '{}' }];
  await store.batch._handler(s.ctx, {
    projectId: s.projectId,
    owner: 'owner',
    generationId: first._id,
    batch: 0,
    entries,
  });
  await store.batch._handler(s.ctx, {
    projectId: s.projectId,
    owner: 'owner',
    generationId: first._id,
    batch: 0,
    entries,
  });
  assert.equal(s.tables.projectWorkRecords.size, 1);
  const project = s.tables.hostedProjects.get(s.projectId);
  project.work = { ...project.work, revision: project.work.revision + 1 }; // legacy owners have no separate head yet
  assert.equal(s.tables.projectWorkHeads.size, 0);
  assert.equal(
    await store.publish._handler(s.ctx, {
      projectId: s.projectId,
      owner: 'owner',
      generationId: first._id,
      batches: 1,
    }),
    false,
  );
  assert.equal(project.work.generationId, undefined);
  await store.retire._handler(s.ctx, { generationId: first._id });
  assert.equal(s.tables.projectWorkRecords.size, 0);
  project.work.revision--;
  const generationId = await indexActions.ensure._handler(s.ctx, { projectId: s.projectId });
  s.caller('stranger');
  await assert.rejects(index.workspace._handler(s.ctx, { projectId: s.projectId }));
  await assert.rejects(
    store.lookups._handler(s.ctx, { projectId: s.projectId, owner: 'stranger', generationId, keys: [] }),
  );
  s.caller('owner');
  s.tables.hostedProjects.set('other', { ...project, _id: 'other', work: { ...project.work, generationId } });
  assert.equal(await index.workspace._handler(s.ctx, { projectId: 'other' }), null);
  await store.retire._handler(s.ctx, { generationId });
  assert.ok(s.tables.projectWorkGenerations.has(generationId), 'published index cannot retire');
});

test('materialization chunks oversized imported attributes and retains full payload, notes and history without truncation', () => {
  const id = randomUUID(),
    head = 'a'.repeat(64),
    huge = '🐈'.repeat(600000),
    data = workSchema.parse({ schema: 8, revision: 1, nativeHead: head, intents: [], lanes: [], views: [] });
  data.intents.push({
    id,
    outcome: 'Long history',
    constraints: '',
    base: head,
    status: 'active',
    createdAt: 'now',
    notes: Array.from({ length: 1000 }, (_, index) => ({ text: `note${index}`, kind: 'comment', at: 'now' })),
    extension: huge,
  });
  const result = materializeWork(
    data,
    {
      schema: 1,
      kind: 'forge-native-work-backup',
      id: randomUUID(),
      head,
      revision: 1,
      files: [{ path: `objects/${head}`, sha256: head, size: 1 }],
      unavailable: [],
      coverage: '',
    },
    [],
  );
  const row = result.entries.find(row => row.collection === 'intents'),
    header = JSON.parse(row.value);
  const parts = result.entries
    .filter(row => row.collection === 'intents:payload' && row.parent === header.payloadKey)
    .sort((a, b) => a.position - b.position);
  assert.equal(JSON.parse(parts.map(row => JSON.parse(JSON.stringify(row.value))).join('')).extension, huge);
  assert.ok(parts.every(row => !/[\uD800-\uDBFF]$/.test(row.value)));
  assert.equal(JSON.parse(parts.map(row => row.value).join('')).notes.length, 0);
  assert.equal(header.noteCount, 1000);
  assert.equal(result.entries.filter(row => row.collection === 'notes').length, 1000);
  assert.ok(result.entries.every(row => Buffer.byteLength(JSON.stringify(row)) < 200000));
  assert.ok(
    indexBatches(result.entries).every(
      batch => batch.length <= 100 && Buffer.byteLength(JSON.stringify(batch)) < 510000,
    ),
  );
});

test('a warm note reads the same bounded records with 10 or 4000 retained notes and leaves unrelated reactive pages equal', async t => {
  const observations = [];
  for (const count of [10, 4000]) {
    const intentId = randomUUID(),
      s = await setup(t, true, root => {
        const local = new WorkStore(root),
          data = local.load();
        data.intents.push({
          id: intentId,
          outcome: 'Retained notes',
          constraints: '',
          base: data.nativeHead,
          status: 'active',
          createdAt: 'now',
          notes: Array.from({ length: count }, (_, index) => ({
            kind: 'comment',
            text: `note${index}`,
            at: 'now',
          })),
        });
        data.revision++;
        local.save(data);
      });
    await indexActions.ensure._handler(s.ctx, { projectId: s.projectId });
    const beforePage = await page(s, 'lanes'),
      workspace = JSON.parse(await index.workspace._handler(s.ctx, { projectId: s.projectId }));
    let reads = 0,
      blobReads = 0;
    const originalGet = s.ctx.db.get,
      originalQuery = s.ctx.db.query;
    s.ctx.db.get = async id => {
      reads++;
      return originalGet(id);
    };
    s.ctx.db.query = table => {
      const query = originalQuery(table);
      let proxy;
      proxy = new Proxy(query, {
        get(target, property) {
          if (['unique', 'take', 'paginate'].includes(property))
            return async (...args) => {
              const result = await target[property](...args);
              reads += Array.isArray(result)
                ? result.length
                : result?.page
                  ? result.page.length
                  : result
                    ? 1
                    : 0;
              return result;
            };
          if (['withIndex', 'order'].includes(property))
            return (...args) => {
              target[property](...args);
              return proxy;
            };
          return target[property];
        },
      });
      return proxy;
    };
    const originalStorage = s.ctx.storage.get;
    s.ctx.storage.get = async id => {
      blobReads++;
      return originalStorage(id);
    };
    await actions.command._handler(s.ctx, {
      projectId: s.projectId,
      operationId: randomUUID(),
      revision: workspace.revision,
      command: JSON.stringify({ action: 'note', intentId, text: 'One more', kind: 'comment' }),
    });
    observations.push({ reads, blobReads });
    s.ctx.db.get = originalGet;
    s.ctx.db.query = originalQuery;
    assert.deepEqual(
      await page(s, 'lanes'),
      beforePage,
      'unrelated page result stays byte-equivalent across a note',
    );
    assert.equal(
      JSON.parse(
        (await index.detail._handler(s.ctx, { projectId: s.projectId, collection: 'intents', id: intentId }))
          .value,
      ).noteCount,
      count + 1,
    );
  }
  assert.deepEqual(observations[0], observations[1]);
  assert.equal(observations[0].blobReads, 0);
  assert.ok(observations[0].reads < 50);
});

test('scoped page wire validator includes provider pagination split metadata', async t => {
  const s = await setup(t);
  await indexActions.ensure._handler(s.ctx, { projectId: s.projectId });
  const result = await page(s, 'intents');
  assert.equal(result.pageStatus, null);
  assert.equal(result.splitCursor, null);
  const wire = JSON.parse(index.records.exportReturns());
  for (const key of Object.keys(result))
    assert.ok(
      Object.hasOwn(wire.value, key),
      `Returned ${key} must be declared in the provider wire validator`,
    );
  assert.equal(wire.value.pageStatus.optional, true);
  assert.equal(wire.value.splitCursor.optional, true);
});

test('oversized Intent headers keep mutation-critical history counters while imported transport-like attributes remain payload data', async t => {
  const intentId = randomUUID(),
    s = await setup(t, true, root => {
      const local = new WorkStore(root),
        data = local.load();
      data.schema = 8;
      data.intents.push({
        id: intentId,
        outcome: 'Wide attributes',
        constraints: '',
        base: data.nativeHead,
        status: 'active',
        createdAt: 'x'.repeat(40000),
        notes: [{ kind: 'comment', text: 'Retained', at: 'now' }],
        lifecycle: [{ from: 'completed', to: 'active', at: 'before' }],
        payloadKey: 'source extension',
        payloadParts: 19,
        payload: { unknown: true },
      });
      data.revision++;
      local.save(data);
    });
  const generationId = await indexActions.ensure._handler(s.ctx, { projectId: s.projectId });
  const initial = JSON.parse(
    (await index.detail._handler(s.ctx, { projectId: s.projectId, collection: 'intents', id: intentId }))
      .value,
  );
  assert.deepEqual(initial.notes, []);
  assert.equal(initial.noteCount, 1);
  assert.deepEqual(initial.lifecycle, []);
  assert.equal(initial.lifecycleCount, 1);
  await s.send({ action: 'note', intentId, text: 'New note', kind: 'comment' });
  await s.send({ action: 'intent-status', intentId, status: 'completed' });
  const updated = JSON.parse(
    (await index.detail._handler(s.ctx, { projectId: s.projectId, collection: 'intents', id: intentId }))
      .value,
  );
  assert.equal(updated.noteCount, 2);
  assert.equal(updated.lifecycleCount, 2);
  assert.equal((await page(s, 'notes', intentId)).page.length, 2);
  assert.equal((await page(s, 'lifecycle', intentId)).page.length, 2);
  const parts = (await page(s, 'intents:payload', updated.payloadKey)).page;
  const original = JSON.parse(parts.map(row => row.value).join(''));
  assert.equal(original.payloadKey, 'source extension');
  assert.equal(original.payloadParts, 19);
  assert.deepEqual(original.payload, { unknown: true });
  assert.ok(s.tables.projectWorkGenerations.has(generationId));
});

test('a prior projection format rebuilds transparently without changing source, Work revision or journal', async t => {
  const s = await setup(t),
    first = await indexActions.ensure._handler(s.ctx, { projectId: s.projectId });
  s.tables.projectWorkGenerations.get(first).format = 3;
  const before = structuredClone(s.tables.hostedProjects.get(s.projectId)),
    events = [...s.tables.projectWorkEvents];
  assert.equal(await index.workspace._handler(s.ctx, { projectId: s.projectId }), null);
  const second = await indexActions.ensure._handler(s.ctx, { projectId: s.projectId });
  assert.notEqual(second, first);
  assert.equal(s.tables.projectWorkGenerations.get(second).format, HOSTED_WORK_INDEX_FORMAT);
  const after = s.tables.hostedProjects.get(s.projectId);
  assert.equal(after.work.revision, before.work.revision);
  assert.equal(after.work.backupId, before.work.backupId);
  assert.equal(after.revision, before.revision);
  assert.deepEqual([...s.tables.projectWorkEvents], events);
  await store.retire._handler(s.ctx, { generationId: first });
  assert.ok(!s.tables.projectWorkGenerations.has(first));
  await store.retire._handler(s.ctx, { generationId: second });
  assert.ok(s.tables.projectWorkGenerations.has(second));
});

test('hosted GitHub settings can discover recorded import repositories without hydrating Intent history', () => {
  const head = 'a'.repeat(64);
  const data = workSchema.parse({
    schema: 8,
    revision: 1,
    nativeHead: head,
    intents: [],
    lanes: [],
    views: [],
  });
  data.intents.push(
    ...['example/project', 'example/project', 'another/repo'].map(repository => ({
      id: randomUUID(),
      outcome: 'Imported PR',
      constraints: '',
      base: head,
      status: 'active',
      createdAt: 'now',
      notes: [],
      external: { repository, observations: [] },
    })),
  );
  const { entries } = materializeWork(
    data,
    {
      schema: 1,
      kind: 'forge-native-work-backup',
      id: randomUUID(),
      head,
      revision: 1,
      files: [],
      unavailable: [],
      coverage: '',
    },
    [],
  );
  assert.deepEqual(
    entries
      .filter(row => row.collection === 'githubRepositories')
      .map(row => JSON.parse(row.value).repository),
    ['example/project', 'another/repo'],
  );
});

test('large GitHub history retains a compact publication summary and full mapping payload', () => {
  const head = 'a'.repeat(64);
  const data = workSchema.parse({
    schema: 8,
    revision: 1,
    nativeHead: head,
    intents: [],
    lanes: [],
    views: [],
  });
  const commit = {
    operationId: randomUUID(),
    state: head,
    acceptanceId: randomUUID(),
    viewId: randomUUID(),
    commit: 'b'.repeat(40),
    parent: 'c'.repeat(40),
    tree: 'd'.repeat(40),
    message: 'Synthetic'.repeat(100),
    author: { name: 'Author', email: 'a@example.test' },
    committer: { name: 'Author', email: 'a@example.test' },
    seconds: 1,
  };
  data.githubSync = {
    repository: 'example/project',
    branch: 'main',
    adoptedCommit: commit.parent,
    commits: Array.from({ length: 100 }, () => ({ ...commit })),
    pushed: 100,
    pushedAt: '2026-10-16T00:00:00Z',
  };
  const { entries } = materializeWork(
    data,
    {
      schema: 1,
      kind: 'forge-native-work-backup',
      id: randomUUID(),
      head,
      revision: 1,
      files: [],
      unavailable: [],
      coverage: '',
    },
    [],
  );
  const summary = JSON.parse(entries.find(row => row.collection === 'githubSync').value);
  assert.equal(summary.repository, 'example/project');
  assert.equal(summary.commits.length, 1);
  assert.equal(summary.pushed, 1);
  assert.equal(summary.pushedAt, data.githubSync.pushedAt);
  assert.ok(summary.payloadParts > 1);
  const full = JSON.parse(
    entries
      .filter(row => row.collection === 'githubSync:payload')
      .map(row => row.value)
      .join(''),
  );
  assert.equal(full.commits.length, 100);
});

test('summary paging can start newest-first while preserving the default positional API', async t => {
  const s = await setup(t);
  await indexActions.ensure._handler(s.ctx, { projectId: s.projectId });
  const workspace = JSON.parse(await index.workspace._handler(s.ctx, { projectId: s.projectId }));
  const generation = s.tables.projectWorkGenerations.get(workspace.generationId);
  const partition = generation.recordsGenerationId ?? generation._id;
  for (let position = 0; position < 5; position++)
    s.tables.projectWorkRecords.set(`perf-${position}`, {
      _id: `perf-${position}`,
      projectId: s.projectId,
      generationId: partition,
      collection: 'perf-summaries',
      key: String(position),
      parent: '',
      position,
      value: JSON.stringify({ id: String(position) }),
    });
  const args = {
    projectId: s.projectId,
    collection: 'perf-summaries',
    paginationOpts: { cursor: null, numItems: 2 },
  };
  const first = await index.records._handler(s.ctx, args);
  assert.deepEqual(
    first.page.map(row => row.position),
    [0, 1],
  );
  const newest = await index.records._handler(s.ctx, { ...args, newestFirst: true });
  assert.deepEqual(
    newest.page.map(row => row.position),
    [4, 3],
  );
  assert.equal(newest.isDone, false);
  const rest = await index.records._handler(s.ctx, {
    ...args,
    newestFirst: true,
    paginationOpts: { cursor: newest.continueCursor, numItems: 100 },
  });
  assert.deepEqual(
    [...newest.page, ...rest.page].map(row => row.position).sort((a, b) => a - b),
    [0, 1, 2, 3, 4],
  );
});

test('summary pages resolve a repeated actor once per request and keep fresh names and authority', async t => {
  const s = await setup(t);
  await indexActions.ensure._handler(s.ctx, { projectId: s.projectId });
  const workspace = JSON.parse(await index.workspace._handler(s.ctx, { projectId: s.projectId }));
  const generation = s.tables.projectWorkGenerations.get(workspace.generationId);
  const partition = generation.recordsGenerationId ?? generation._id;
  s.tables.projectActorNames.set('perf-name', {
    _id: 'perf-name',
    projectId: s.projectId,
    actor: 'owner',
    displayName: 'First name',
  });
  for (let position = 0; position < 30; position++)
    s.tables.projectWorkRecords.set(`actor-perf-${position}`, {
      _id: `actor-perf-${position}`,
      projectId: s.projectId,
      generationId: partition,
      collection: 'perf-actors',
      key: String(position),
      parent: '',
      position,
      value: JSON.stringify({ id: String(position), actor: 'owner' }),
    });
  const query = s.ctx.db.query.bind(s.ctx.db);
  let names = 0;
  s.ctx.db.query = table => {
    if (table === 'projectActorNames') names++;
    return query(table);
  };
  const rows = await page(s, 'perf-actors');
  assert.equal(names, 1);
  assert(rows.page.every(row => JSON.parse(row.value).actorDisplayName === 'First name'));
  s.tables.projectActorNames.get('perf-name').displayName = 'Current name';
  const current = await page(s, 'perf-actors');
  assert.equal(names, 2);
  assert(current.page.every(row => JSON.parse(row.value).actorDisplayName === 'Current name'));
  s.caller('stranger');
  await assert.rejects(page(s, 'perf-actors'), error => error.data?.code === 'PROJECT_UNAVAILABLE');
  assert.equal(names, 2);
});
