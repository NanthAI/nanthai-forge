// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { setup } from './hosted-planning-fixture.mjs';
import { planFixture } from './plan-read-fixture.mjs';
import { meterWorkIO } from './hosted-read-set.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
const { start, createIntent } = await import(moduleUrl('../convex/projectHostedStart.ts'));
const { seed } = await import(moduleUrl('../convex/projectHostedChannels.ts'));
const { set } = await import(moduleUrl('../convex/projectAutonomy.ts'));
const { detail } = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const { read } = await import(moduleUrl('../convex/projectItemWork.ts'));
const { resolveId } = await import(moduleUrl('../convex/projectHostedPlanning.ts'));
const { advance } = await import(moduleUrl('../convex/projectPlanRollup.ts'));
const { publish } = await import(moduleUrl('../convex/projectWorkIndexStore.ts'));
const { command: write } = await import(moduleUrl('../convex/projectWorkCommand.ts'));

const head = 'a'.repeat(64);
const expectedMain = { head, receiptId: 'main' };
const authority = { mode: 'server', epoch: 1 };

async function fixture(t, scale = 0) {
  const s = scale ? await planFixture(t, scale) : await setup(t);
  if (scale) await s.project();
  const { projectId, ctx } = s;
  ctx.meta.getTransactionMetrics = async () => ({
    databaseQueries: { remaining: 4096 },
    documentsRead: { remaining: 4096 },
    bytesRead: { remaining: 16 * 1024 * 1024 },
  });
  await ctx.db.patch(projectId, { sourceAuthority: authority });
  await seed._handler(ctx, {
    projectId,
    actor: 'owner',
    operationId: randomUUID(),
    selection: JSON.stringify({
      schema: 2,
      projectId,
      snapshotId: randomUUID(),
      sourceRevision: 0,
      channel: 'main',
      head,
      authority,
      receipt: { id: 'main', kind: 'server', previousHead: null, previousReceiptId: null },
    }),
  });
  const input = () => ({
    projectId,
    operationId: randomUUID(),
    authorityEpoch: 1,
    expectedMain,
    authorship: { kind: 'agent', declaration: 'unknown' },
    intent: { kind: 'new', outcome: 'Preserve the saved sheet', constraints: 'Keep private notes' },
  });
  return {
    ...s,
    input,
    items: () =>
      [...s.tables.projectHostedRecordHeads.values()]
        .filter(row => row.kind === 'issue')
        .map(row => JSON.parse(row.value)),
    begin: async args => JSON.parse(await start._handler(ctx, args)),
    disable: () =>
      set._handler(ctx, {
        projectId,
        command: JSON.stringify({
          action: 'set-policy',
          operationId: randomUUID(),
          autoCreatePlanningItem: false,
        }),
      }),
  };
}

test('an unplanned agent start captures a private plain Item by default and the original start never captures twice', async t => {
  const s = await fixture(t);
  const input = { ...s.input(), planningItemIdVersion: 1 };
  const started = await s.begin(input);
  assert.equal(started.planningItemId, started.intentId);
  const [item] = s.items();
  assert.deepEqual(
    [item.id, item.title, item.body, item.status, item.hidden, item.version],
    [started.intentId, input.intent.outcome, '', 'in-progress', true, 1],
  );
  const intent = [...s.tables.projectHostedRecordHeads.values()].find(
    row => row.kind === 'intent' && row.key === started.intentId,
  );
  assert.equal(intent.planningItemId, item.id, 'the landing evidence goes to the captured Item');
  await s.disable();
  assert.deepEqual(await s.begin(input), started);
  const { planningItemId, ...legacy } = started;
  assert.equal(planningItemId, item.id);
  assert.deepEqual(await s.begin({ ...input, planningItemIdVersion: undefined }), legacy);
  assert.equal(s.items().length, 1);
  await s.begin(s.input());
  assert.equal(s.items().length, 1, 'an owner can turn capture off for future starts');
});

test('a person start and a Lane-less Intent do not create Items even when capture is enabled', async t => {
  const s = await fixture(t);
  await s.begin({ ...s.input(), authorship: { kind: 'person' } });
  await createIntent._handler(s.ctx, s.input());
  assert.deepEqual(s.items(), []);
});

test('a stale Work selection does not stop an unplanned start', async t => {
  const s = await fixture(t);
  const project = s.tables.hostedProjects.get(s.projectId);
  await s.ctx.db.patch(project.work.generationId, { status: 'building' });
  assert((await s.begin(s.input())).lane);
  assert.deepEqual(s.items(), []);
});

for (const scale of [1, 2])
  test(`capture adds a bounded Item write at ${324 * scale} existing Plan rows`, async t => {
    const s = await fixture(t, scale);
    const io = meterWorkIO(s.ctx, s.tables);
    const input = s.input();
    input.intent.outcome = 'é'.repeat(500); // the largest outcome accepted by hosted start
    let started;
    const before = performance.now();
    const capture = await io.cost(async () => {
      started = await s.begin(input);
    });
    const captureMs = performance.now() - before;
    const item = s.items().find(item => item.id === started.intentId);
    assert.equal(item.title, input.intent.outcome);
    await s.disable();
    const baselineBefore = performance.now();
    const baseline = await io.cost(() => s.begin(s.input()));
    const baselineMs = performance.now() - baselineBefore;
    assert(capture.readDocuments - baseline.readDocuments <= 40, JSON.stringify(capture));
    assert(capture.writeDocuments - baseline.writeDocuments <= 35, JSON.stringify(capture));
    t.diagnostic(JSON.stringify({ scale, capture, baseline, captureMs, baselineMs }));
  });

test('incident 2209abb0: ten overlapping agent starts commit private Items and Lane links without a shared Work write', async t => {
  const seeded = await fixture(t);
  const s = lanesFixture({ commitSchedules: true });
  for (const [table, rows] of Object.entries(seeded.tables))
    for (const [id, row] of rows) s.tables[table]?.set(id, row);
  const { projectId } = seeded;
  s.patch('hostedProjects', projectId, { visibility: 'public' });
  t.mock.method(Math, 'random', () => 0);
  const before = s.counts.length;
  // Five account identities isolate project-wide contention. Pairs share a start limiter shard.
  const actors = Array.from({ length: 5 }, (_, i) => `start-writer-${i}`);
  for (const actor of actors) s.insert('projectContributors', { projectId, contributor: actor });
  const inputs = Array.from({ length: 10 }, (_, i) => ({
    ...seeded.input(),
    intent: { kind: 'new', outcome: `Concurrent start ${i}`, constraints: 'Private constraints' },
  }));
  const attempts = await Promise.allSettled(
    inputs.map((input, i) => s.call('capture start', start, input, actors[i % actors.length])),
  );
  assert.deepEqual(
    attempts.filter(result => result.status === 'rejected').map(result => result.reason.message),
    [],
    'all ten starts return without provider OCC exhaustion',
  );
  const starts = s.counts.slice(before);
  assert(starts.every(tx => !tx.written.includes('projectWorkHeads')));
  assert(starts.every(tx => !tx.touched.includes('projectWorkHeads')));
  assert(
    starts.every(tx =>
      (tx.conflicts ?? []).every(table => table === 'deviceAttempts' || table === 'projectJournalReceipts'),
    ),
  );
  const results = attempts.map(result => JSON.parse(result.value));
  assert.equal(new Set(results.map(result => result.intentId)).size, 10);
  for (const [i, result] of results.entries()) {
    const item = await s.call('item detail', detail, {
      projectId,
      collection: 'planningItems',
      id: result.intentId,
    });
    assert.equal(JSON.parse(item.value).title, inputs[i].intent.outcome);
    assert.equal(JSON.parse(item.value).body, '');
    assert.equal(JSON.parse(item.value).hidden, true);
    const work = JSON.parse(await s.call('item work', read, { projectId, itemId: result.intentId }));
    assert.equal(work.lanes[0].laneId, result.lane.laneId);
    const resolved = JSON.parse(
      await s.call('short Item id', resolveId, { projectId, prefix: result.intentId.slice(0, 8) }),
    );
    assert.deepEqual(resolved.ids, [result.intentId]);
  }
  const privateId = results[0].intentId;
  const visitor = 'signed-in-visitor';
  const hidden = await s.call(
    'visitor Item detail',
    detail,
    { projectId, collection: 'planningItems', id: privateId },
    visitor,
  );
  assert.equal(hidden.value, null);
  const hiddenPrefix = await s.call(
    'visitor short Item id',
    resolveId,
    { projectId, prefix: privateId.slice(0, 8) },
    visitor,
  );
  assert.deepEqual(JSON.parse(hiddenPrefix).ids, []);
  const editedId = [...s.tables.projectHostedRecordHeads.values()].find(row => row.kind === 'issue').key;
  const edited = results.find(result => result.intentId === editedId);
  const edit = {
    action: 'put-planning-item',
    itemId: edited.intentId,
    operationId: randomUUID(),
    expectedVersion: 1,
    body: 'Edited before the Plan wake',
  };
  const editEvent = await s.call('edit pending Item', write, {
    projectId,
    operationId: edit.operationId,
    command: JSON.stringify(edit),
  });
  assert(editEvent.revision >= 2);
  const wakes = s.scheduled.filter(
    task => getFunctionName(task.fn) === 'projectPlanRollup:advance' && task.args.source === 'capture',
  );
  assert.equal(wakes.length, 1);
  const [wake] = wakes;
  await s.call('capture projection', advance, wake.args, null);
  await s.call('capture projection replay', advance, wake.args, null);
  const ids = new Set(results.map(result => result.intentId));
  const projected = [...s.tables.projectPlanningRecords.values()]
    .filter(row => row.collection === 'planningSearch' && ids.has(row.key))
    .map(row => JSON.parse(row.value));
  assert.equal(projected.length, 10, 'one wake publishes all pending Items in the burst');
  assert.equal(projected.find(item => item.id === edited.intentId).body, edit.body);
  const revisions = [...s.tables.projectHostedRecordBodies.values()]
    .flatMap(row => (row.revision === undefined ? [] : [row.revision]))
    .sort((a, b) => a - b);
  assert.deepEqual(
    revisions,
    Array.from({ length: 11 }, (_, i) => i + 1),
  );
  const finished = starts.filter(tx => !tx.conflicts);
  const publication = s.counts.find(tx => tx.name === 'capture projection');
  t.diagnostic(
    JSON.stringify({
      starts: finished.length,
      retries: starts.length - finished.length,
      coldWakeConflicts: starts.filter(tx => tx.conflicts?.includes('projectJournalReceipts')).length,
      maxReadDocuments: Math.max(...finished.map(tx => tx.documents)),
      maxReadBytes: Math.max(...finished.map(tx => tx.readBytes)),
      maxWriteDocuments: Math.max(...finished.map(tx => tx.writes)),
      maxWriteBytes: Math.max(...finished.map(tx => tx.writeBytes)),
      publication: {
        reads: publication.documents,
        readBytes: publication.readBytes,
        writes: publication.writes,
        writeBytes: publication.writeBytes,
      },
    }),
  );
});

async function captureWorld(t) {
  const seeded = await fixture(t);
  const s = lanesFixture({ commitSchedules: true });
  for (const [table, rows] of Object.entries(seeded.tables))
    for (const [id, row] of rows) s.tables[table]?.set(id, row);
  const { projectId } = seeded;
  const capture = async () => JSON.parse(await s.call('start captured Item', start, seeded.input())).intentId;
  const put = cmd => {
    const operationId = randomUUID();
    return s.call('put planning Item', write, {
      projectId,
      operationId,
      command: JSON.stringify({ action: 'put-planning-item', operationId, ...cmd }),
    });
  };
  const wakes = () =>
    s.scheduled.filter(
      ({ fn, args }) => getFunctionName(fn) === 'projectPlanRollup:advance' && args.source === 'capture',
    );
  const run = wake => s.call('capture wake', advance, wake.args, null);
  const projected = () =>
    [...s.tables.projectPlanningRecords.values()]
      .filter(row => row.collection === 'planningSearch')
      .sort((a, b) => a.position - b.position)
      .map(row => JSON.parse(row.value));
  return { ...s, projectId, capture, put, wakes, run, projected };
}

test('a captured Item survives a blocked wake and is projected when the rebuilt generation publishes', async t => {
  const s = await captureWorld(t);
  const itemId = await s.capture();
  const project = s.tables.hostedProjects.get(s.projectId);
  const old = s.tables.projectWorkGenerations.get(project.work.generationId);
  s.patch('hostedProjects', s.projectId, { work: { ...project.work, generationId: undefined } });
  assert.equal(await s.run(s.wakes()[0]), 'blocked');
  assert.equal(s.projected().length, 0);
  const { _id, _creationTime, ...fields } = old;
  const generationId = s.insert('projectWorkGenerations', { ...fields, status: 'building' });
  assert(
    await s.call(
      'publish rebuilt index',
      publish,
      {
        projectId: s.projectId,
        owner: 'owner',
        generationId,
        batches: old.nextBatch,
      },
      null,
    ),
  );
  assert.equal(s.wakes().length, 2, 'publication rearms work without another start');
  await s.run(s.wakes()[1]);
  assert.deepEqual(
    s.projected().map(item => item.id),
    [itemId],
  );
});

test('a new child can name a pending captured Item as parent and earlier captures keep their order', async t => {
  const s = await captureWorld(t);
  const first = await s.capture();
  const parentId = await s.capture();
  const childId = randomUUID();
  const edited = await s.put({
    itemId: childId,
    parentId,
    expectedVersion: 0,
    kind: 'issue',
    title: 'Child',
  });
  assert.equal(edited.revision, 3);
  assert.deepEqual(
    s.projected().map(item => item.id),
    [first, parentId, childId],
  );
  assert.equal(s.projected()[2].parentId, parentId);
});

test('an edit of a later captured Item first journals older starts', async t => {
  const s = await captureWorld(t);
  const first = await s.capture();
  const later = await s.capture();
  const edited = await s.put({ itemId: later, expectedVersion: 1, body: 'Updated immediately' });
  assert.equal(edited.revision, 3);
  assert.deepEqual(
    s.projected().map(item => item.id),
    [first, later],
  );
});

test('a capture burst shares one wake, ignores duplicate deliveries and continues past ten Items', async t => {
  const s = await captureWorld(t);
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(await s.capture());
  assert.equal(s.wakes().length, 1);
  const [first] = s.wakes();
  await Promise.all([s.run(first), s.run(first)]);
  assert.deepEqual(
    s.projected().map(item => item.id),
    ids.slice(0, 10),
  );
  const [_, next] = s.wakes();
  assert(next);
  await Promise.all([s.run(first), s.run(next)]);
  assert.deepEqual(
    s.projected().map(item => item.id),
    ids,
  );
  assert.equal(s.wakes().length, 2);
});

test('one damaged capture head does not prevent newer Items from entering the journal', async t => {
  const s = await captureWorld(t);
  const first = await s.capture();
  const second = await s.capture();
  const bad = [...s.tables.projectHostedRecordHeads.values()].find(
    row => row.kind === 'issue' && row.key === first,
  );
  s.patch('projectHostedRecordHeads', bad._id, {
    pendingPlanningCapture: { ...bad.pendingPlanningCapture, command: '{' },
  });
  await s.run(s.wakes()[0]);
  assert.deepEqual(
    s.projected().map(item => item.id),
    [first, second],
  );
});

test('a lifecycle wake can sequence an Item before the capture wake executes', async t => {
  const s = await captureWorld(t);
  const itemId = await s.capture();
  await s.call(
    'lifecycle wake before capture',
    advance,
    {
      projectId: s.projectId,
      itemId,
      cause: randomUUID(),
      source: 'lifecycle',
    },
    null,
  );
  assert.deepEqual(
    s.projected().map(item => item.id),
    [itemId],
  );
});

test('an unverifiable capture keeps its repair state while the wake drains later Items', async t => {
  const s = await captureWorld(t);
  const first = await s.capture();
  const second = await s.capture();
  const bad = [...s.tables.projectHostedRecordHeads.values()].find(
    row => row.kind === 'issue' && row.key === first,
  );
  s.patch('projectHostedRecordHeads', bad._id, { value: '{' });
  await s.run(s.wakes()[0]);
  assert.deepEqual(
    s.projected().map(item => item.id),
    [second],
  );
  assert.equal(s.tables.projectHostedRecordHeads.get(bad._id).pendingPlanningCapture.state, 'repair');
  s.patch('projectHostedRecordHeads', bad._id, { value: bad.value });
  await s.put({ itemId: first, expectedVersion: 1, body: 'Edit after repair' });
  assert.equal(s.projected().find(item => item.id === first).body, 'Edit after repair');
});
