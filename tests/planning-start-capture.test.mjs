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
const { restore, trash } = await import(moduleUrl('../convex/projectLifecycle.ts'));
const { publish } = await import(moduleUrl('../convex/projectWorkIndexStore.ts'));
const { storePage } = await import(moduleUrl('../convex/projectWorkStoreReads.ts'));
const { afterStart } = await import(moduleUrl('../convex/projectJournalWake.ts'));
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
  const s = await captureWorld(t);
  const { projectId } = s;
  s.patch('hostedProjects', projectId, { visibility: 'public' });
  t.mock.method(Math, 'random', () => 0);
  const before = s.counts.length;
  // Five account identities isolate project-wide contention. Pairs share a start limiter shard.
  const actors = Array.from({ length: 5 }, (_, i) => `start-writer-${i}`);
  for (const actor of actors) s.insert('projectContributors', { projectId, contributor: actor });
  const inputs = Array.from({ length: 10 }, (_, i) => ({
    ...s.input(),
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
  assert(starts.every(tx => (tx.conflicts ?? []).every(table => table === 'deviceAttempts')));
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
  const [wake] = s.wakes();
  assert.equal(await s.replay(wake), 'repeated');
  await s.drain();
  assert.equal(
    s.counts.filter(tx => tx.name === 'capture wake' && tx.written.includes('projectWorkHeads')).length,
    1,
    'one publishing wake covers the entire normal burst',
  );
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
  const publication = s.counts.find(
    tx => tx.name === 'capture wake' && tx.written.includes('projectWorkHeads'),
  );
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
  s.tables._scheduled_functions = new Map();
  s.decorateContext(ctx => {
    ctx.scheduler.runAfter = async (delay, fn, args) =>
      ctx.db.insert('_scheduled_functions', {
        name: getFunctionName(fn),
        args,
        scheduledTime: delay,
        state: { kind: 'pending' },
      });
    ctx.scheduler.cancel = id => ctx.db.patch(id, { state: { kind: 'canceled' } });
  });
  const { projectId } = seeded;
  const capture = async (name = 'start captured Item', actor = 'owner') =>
    JSON.parse(await s.call(name, start, seeded.input(), actor)).intentId;
  const put = cmd => {
    const operationId = randomUUID();
    return s.call('put planning Item', write, {
      projectId,
      operationId,
      command: JSON.stringify({ action: 'put-planning-item', operationId, ...cmd }),
    });
  };
  const wakes = () =>
    [...s.tables._scheduled_functions.values()].filter(
      task =>
        task.name === 'projectPlanRollup:advance' &&
        task.args.source === 'capture' &&
        task.state.kind === 'pending',
    );
  const run = (wake, beforeCommit) =>
    s.call(
      'capture wake',
      {
        _handler: async (ctx, args) => {
          ctx.meta.getRequestMetadata = async () => ({ scheduledFunctionId: wake._id });
          const result = await advance._handler(ctx, args);
          await beforeCommit?.();
          await ctx.db.patch(wake._id, { state: { kind: 'success' } });
          return result;
        },
      },
      wake.args,
      null,
    );
  const replay = wake => s.call('duplicate capture wake', advance, wake.args, null);
  const drain = async () => {
    for (let i = 0; i < 64; i++) {
      const [wake] = wakes();
      if (!wake) return;
      await run(wake);
    }
    assert.fail('capture wakes did not settle');
  };
  const projected = () =>
    [...s.tables.projectPlanningRecords.values()]
      .filter(row => row.collection === 'planningSearch')
      .sort((a, b) => a.position - b.position)
      .map(row => JSON.parse(row.value));
  return { ...s, projectId, input: seeded.input, capture, put, wakes, run, replay, drain, projected };
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
  assert.equal(s.wakes().length, 1, 'publication rearms work without another start');
  await s.run(s.wakes()[0]);
  assert.deepEqual(
    s.projected().map(item => item.id),
    [itemId],
  );
});

test('restoring a project drains captures whose wake completed while it was in Trash', async t => {
  const s = await captureWorld(t);
  const ids = [];
  for (let i = 0; i < 11; i++) ids.push(await s.capture());
  const transition = (name, fn) =>
    s.call(name, fn, {
      projectId: s.projectId,
      operationId: randomUUID(),
      expectedRevision: s.tables.hostedProjects.get(s.projectId).revision,
    });
  await transition('trash project', trash);
  for (const wake of s.wakes()) await s.run(wake);
  assert.deepEqual(s.projected(), []);
  await transition('restore project', restore);
  await s.drain();
  assert.deepEqual(
    s.projected().map(item => item.id),
    ids,
  );
});

async function reverseCaptureOverlap(t) {
  const s = await captureWorld(t);
  const first = await s.capture();
  const second = await s.capture();
  const [publisher, sibling] = s.wakes();
  const held = Promise.withResolvers(),
    release = Promise.withResolvers();
  const page = s.run(publisher, async () => {
    held.resolve();
    await release.promise;
  });
  let late;
  try {
    await held.promise;
    const actors = Array.from({ length: 12 }, (_, i) => `reverse-writer-${i}`);
    for (const contributor of actors)
      s.insert('projectContributors', { projectId: s.projectId, contributor });
    late = await Promise.all(actors.map(actor => s.capture('reverse start', actor)));
    assert.equal(await s.run(sibling), 'repeated');
    for (const ticket of s.wakes().filter(task => late.includes(task.args.itemId)))
      assert.equal(await s.run(ticket), 'repeated');
  } finally {
    release.resolve();
  }
  await page;
  assert.deepEqual(
    s.counts.flatMap(tx => tx.conflicts ?? []),
    [],
  );
  await s.drain();
  const published = s.projected().map(item => item.id);
  assert.deepEqual(published.slice(0, 2), [first, second]);
  assert.deepEqual(new Set(published.slice(2)), new Set(late));
}

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
  const [first] = s.wakes();
  const outOfOrder = s.wakes().find(task => task.args.itemId === ids[10]);
  assert.equal(await s.run(outOfOrder), 'repeated', 'an out-of-order ticket never starts a second drain');
  const duplicate = s.counts.at(-1);
  assert.deepEqual(duplicate.touched, ['projectHostedRecordHeads']);
  assert(!duplicate.written.some(table => table !== '_scheduled_functions'));
  const [repeated] = await Promise.all([s.replay(first), s.run(first)]);
  assert.equal(repeated, 'repeated', 'only the scheduled invocation can publish');
  assert.deepEqual(
    s.projected().map(item => item.id),
    ids.slice(0, 10),
  );
  const next = s.wakes().find(task => task.args.itemId === ids[10]);
  assert(next);
  assert.notEqual(next._id, outOfOrder._id, 'the drain rearms a ticket that ran out of order');
  assert.equal(await s.replay(first), 'repeated');
  await s.run(next);
  await s.drain();
  assert.deepEqual(
    s.projected().map(item => item.id),
    ids,
  );
  assert.equal(s.wakes().length, 0);
});

test('editing the oldest pending Item rearms a newer ticket already delivered out of order', async t => {
  const s = await captureWorld(t);
  const oldest = await s.capture();
  const newest = await s.capture();
  assert.equal(await s.run(s.wakes()[1]), 'repeated');
  await s.put({ itemId: oldest, expectedVersion: 1, body: 'Edited before the oldest ticket ran' });
  assert(s.wakes().some(task => task.args.itemId === newest));
  await s.drain();
  assert.deepEqual(
    s.projected().map(item => item.id),
    [oldest, newest],
  );
});

test('a capture wake already queued at deploy still drains its pending Items', async t => {
  const s = await captureWorld(t);
  const itemId = await s.capture();
  const head = [...s.tables.projectHostedRecordHeads.values()].find(
    row => row.key === itemId && row.kind === 'issue',
  );
  const [ticket] = s.wakes();
  s.patch('projectHostedRecordHeads', head._id, {
    pendingPlanningCapture: { ...head.pendingPlanningCapture, wake: undefined },
    commitTs: undefined,
  });
  s.patch('_scheduled_functions', ticket._id, { state: { kind: 'canceled' } });
  const cause = randomUUID();
  const receipt = s.insert('projectJournalReceipts', {
    projectId: s.projectId,
    operationId: 'planning-capture-wake',
    hash: 'a'.repeat(64),
    envelope: cause,
  });
  const oldWake = { args: { projectId: s.projectId, itemId: cause, cause, source: 'capture' } };
  assert.equal(await s.replay(oldWake), 'unchanged');
  assert.equal(await s.replay(oldWake), 'repeated');
  assert.equal(s.tables.projectJournalReceipts.has(receipt), false);
  assert.deepEqual(
    s.projected().map(item => item.id),
    [itemId],
  );
});

test('starts with journal packing enabled publish their private receipts before arming the shared drain', async t => {
  const s = await captureWorld(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-27T14:10:00Z') });
  const value = process.env.FORGE_JOURNAL_SEGMENTS;
  process.env.FORGE_JOURNAL_SEGMENTS = '1';
  t.after(() => {
    if (value === undefined) delete process.env.FORGE_JOURNAL_SEGMENTS;
    else process.env.FORGE_JOURNAL_SEGMENTS = value;
  });
  const actors = ['journal-first', 'journal-second'];
  for (const contributor of actors) s.insert('projectContributors', { projectId: s.projectId, contributor });
  const inputs = actors.map(() => s.input());
  await Promise.all(inputs.map((input, index) => s.call('journal start', start, input, actors[index])));
  const uncaptured = { ...s.input(), authorship: { kind: 'person' } };
  await s.call('person starts without capture', start, uncaptured);
  const starts = s.counts.slice(0, 3);
  assert(starts.every(tx => !tx.conflicts && !tx.touched.includes('projectJournalReceipts')));
  assert(starts.every(tx => tx.documents <= 77 && tx.writes <= 31));
  assert.equal(s.tables.projectJournalReceipts.size, 0);
  const operations = new Set([...inputs, uncaptured].map(input => input.operationId));
  const receipts = [...s.tables.projectHostedOperations.values()].filter(row =>
    operations.has(row.operationId),
  );
  assert.equal(receipts.length, operations.size);
  assert(receipts.every(row => row.journalReadyAt !== undefined));
  t.diagnostic(
    JSON.stringify({
      journalPacking: true,
      starts: starts.length,
      maxReadDocuments: Math.max(...starts.map(tx => tx.documents)),
      maxWriteDocuments: Math.max(...starts.map(tx => tx.writes)),
    }),
  );
  const deferred = [...s.tables._scheduled_functions.values()].find(
    task => task.name === 'projectJournalWake:afterStart',
  );
  assert(deferred);
  await s.call('arm journal for the uncaptured start', afterStart, deferred.args, null);
  await s.drain();
  const jobs = [...s.tables._scheduled_functions.values()].filter(
    task => task.name === 'projectJournalRun:pack',
  );
  assert.equal(jobs.length, 1, 'captured and uncaptured starts reuse the existing journal drain');
});

test('incident 2209abb0: scheduling and advancing a capture burst cannot conflict with overlapping starts on project rows', async t => {
  const s = await captureWorld(t);
  for (let i = 0; i < 11; i++) await s.capture();
  const [first] = s.wakes();
  const before = s.counts.length;
  const startedAt = performance.now();
  const { promise: release, resolve: resume } = Promise.withResolvers();
  const { promise: snapshots, resolve: allStarted } = Promise.withResolvers();
  let waiting = 0;
  // Each start has its own limiter shard so the replay isolates project contention.
  const actors = Array.from({ length: 12 }, (_, i) => `burst-writer-${i}`);
  for (const contributor of actors) s.insert('projectContributors', { projectId: s.projectId, contributor });
  const expiredReceipt = s.insert('projectHostedOperations', {
    projectId: s.projectId,
    actor: 'owner',
    operationId: randomUUID(),
    value: '{}',
  });
  s.extendContext(async (_ctx, _input, name) => {
    if (name !== 'interleaved start') return;
    if (++waiting === actors.length) allStarted();
    await release;
  });
  const starts = Promise.allSettled(actors.map(actor => s.capture('interleaved start', actor)));
  try {
    // All starts hold the pre-wake snapshot when this page commits and rearms the drain.
    await snapshots;
    assert.equal(
      await s.replay({ args: { ...first.args, cause: randomUUID() } }),
      'repeated',
      'a stale wake overlaps the starts without touching shared Work',
    );
    await s.run(first);
  } finally {
    resume();
  }
  const results = await starts;
  const overlap = s.counts.slice(before);
  const completedStarts = overlap.filter(tx => tx.name === 'interleaved start' && !tx.conflicts);
  const projectConflicts = overlap.flatMap(tx =>
    (tx.conflicts ?? []).filter(table => table !== 'deviceAttempts'),
  );
  t.diagnostic(
    JSON.stringify({
      starts: results.length,
      failed: results.filter(result => result.status === 'rejected').length,
      conflicts: projectConflicts,
      maxReadDocuments: Math.max(...completedStarts.map(tx => tx.documents)),
      maxReadBytes: Math.max(...completedStarts.map(tx => tx.readBytes)),
      maxWriteDocuments: Math.max(...completedStarts.map(tx => tx.writes)),
      maxWriteBytes: Math.max(...completedStarts.map(tx => tx.writeBytes)),
      elapsedMs: performance.now() - startedAt,
      peakProcessRssKiB: process.resourceUsage().maxRSS,
    }),
  );
  assert.deepEqual(
    results.flatMap(result => (result.status === 'rejected' ? [result.reason.message] : [])),
    [],
  );
  assert.deepEqual(
    projectConflicts,
    [],
    'the Plan wake and overlapping starts must not contend on project rows',
  );
  assert(completedStarts.every(tx => !tx.touched.includes('projectJournalReceipts')));
  assert(completedStarts.every(tx => !tx.written.includes('projectJournalReceipts')));
  assert(
    s.tables.projectHostedOperations.has(expiredReceipt),
    'starts leave shared expiry work for the drain',
  );
  // Serial replay of the pre-#32217 inline Plan writer, with the same twelve contributors.
  assert.equal(completedStarts.length, actors.length);
  assert(
    completedStarts.every(tx => tx.documents <= 77 && tx.writes <= 31),
    'pre-#32217 start I/O ceiling',
  );
  assert.deepEqual(await s.replay(first), 'repeated', 'the previous delivery does not take the next page');
  const creationOrder = [...s.tables.projectHostedRecordHeads.values()]
    .filter(row => row.kind === 'issue')
    .sort((a, b) => (a.commitTs < b.commitTs ? -1 : 1))
    .map(row => row.key);
  for (const itemId of [creationOrder[10], creationOrder[20]]) {
    const next = s.wakes().findLast(task => task.args.itemId === itemId);
    assert(next);
    await s.run(next);
  }
  await s.drain();
  assert(!s.tables.projectHostedOperations.has(expiredReceipt), 'the drain handles deferred expiry');
  assert.equal(
    s.counts.filter(tx => tx.name === 'capture wake' && tx.written.includes('projectWorkHeads')).length,
    3,
    '23 captures use three publishing pages of one wake chain',
  );
  assert.deepEqual(
    s.projected().map(item => item.id),
    creationOrder,
  );
  await t.test(
    'a short capture page remains conflict-free when twelve starts and the sibling tickets commit first',
    reverseCaptureOverlap,
  );
});

test('Plan and the canonical Item list agree when the first allocated capture commits last', async t => {
  const s = await captureWorld(t);
  const inserted = Promise.withResolvers(),
    release = Promise.withResolvers();
  s.insert('projectContributors', { projectId: s.projectId, contributor: 'late-committer' });
  s.extendContext((ctx, _input, name) => {
    if (name !== 'late commit') return;
    const insert = ctx.db.insert;
    ctx.db.insert = async (table, row) => {
      const id = await insert(table, row);
      if (table === 'projectHostedRecordHeads' && row.pendingPlanningCapture) {
        inserted.resolve();
        await release.promise;
      }
      return id;
    };
  });
  const late = s.capture('late commit', 'late-committer');
  let first;
  try {
    await inserted.promise;
    first = await s.capture();
    await s.run(s.wakes()[0]);
  } finally {
    release.resolve();
  }
  const last = await late;
  await s.drain();
  const canonical = await s.call(
    'canonical Item page',
    {
      isQuery: true,
      _handler: ctx =>
        storePage(ctx, s.projectId, {
          collection: 'planningItems',
          paginationOpts: { numItems: 10, cursor: null },
        }),
    },
    {},
  );
  const heads = [...s.tables.projectHostedRecordHeads.values()]
    .filter(row => row.kind === 'issue')
    .sort((a, b) => a._creationTime - b._creationTime);
  assert.deepEqual(
    heads.map(row => row.key),
    [last, first],
    'allocation order differs from commit order',
  );
  assert.deepEqual(
    canonical.page.map(row => row.id),
    [first, last],
  );
  assert.deepEqual(
    s.projected().map(item => item.id),
    [first, last],
  );
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
