// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
import { nextItem } from '../dist/planning-model.js';
import { batchUndo, mergeItems } from '../dist/planning-batch.js';
import { successorIntentId } from '../dist/hosted-intent-chain.js';
import { itemRows, purgeList } from './planning-purge-fixture.mjs';

const start = await import(moduleUrl('../convex/projectHostedStart.ts'));
const plan = await import(moduleUrl('../convex/projectPlanView.ts'));
const itemWork = await import(moduleUrl('../convex/projectItemWork.ts'));
const lifecycle = await import(moduleUrl('../convex/projectHostedLifecycle.ts'));
const backfill = await import(moduleUrl('../convex/projectPlanLaneBackfill.ts'));
const { setPin } = await import(moduleUrl('../convex/projectHostedLanePin.ts'));
const { rollupWorkReader } = await import(moduleUrl('../convex/projectPlanRollupFacts.ts'));
const batch = await import(moduleUrl('../convex/projectPlanningBatch.ts'));
const work = await import(moduleUrl('../convex/projectWorkCommand.ts'));
const workIndex = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const { readHostedRecord, writeHostedRecord } = await import(moduleUrl('../convex/projectHostedRecords.ts'));

function seedPlan(f) {
  const backupId = f.insert('projectBackups', {
    projectId: f.projectId,
    operationId: randomUUID(),
    request: 'b'.repeat(64),
    nonce: randomUUID(),
    previous: null,
    status: 'stored',
    digest: 'a'.repeat(64),
    size: 0,
    preview: {
      manifestDigest: f.main.head,
      head: f.main.head,
      format: 'native',
      revision: 0,
      intents: 0,
      lanes: 0,
      views: 0,
      runs: 0,
      files: 0,
      unavailable: 0,
      channels: [],
    },
  });
  const generationId = f.insert('projectWorkGenerations', {
    projectId: f.projectId,
    backupId,
    format: 11,
    status: 'ready',
    initialRevision: 0,
    revision: 0,
    nextBatch: 0,
    metadata: '{"schema":24}',
  });
  f.patch('hostedProjects', f.projectId, {
    key: randomUUID(),
    work: { operationId: randomUUID(), initialRevision: 0, revision: 0, backupId, generationId },
  });
  return generationId;
}

function addPlan(f, ids) {
  const generationId = seedPlan(f);
  for (const [position, id] of ids.entries()) {
    const item = { id, title: `Item ${position}`, kind: 'issue', status: 'open' };
    f.insert('projectPlanningRecords', {
      projectId: f.projectId,
      generationId,
      collection: 'planningSearch',
      key: id,
      parent: '',
      position,
      value: JSON.stringify(item),
      planning: { text: item.title, kind: item.kind, status: item.status, initiativeId: '', open: true },
    });
  }
}

const rows = async f =>
  JSON.parse((await f.store.transaction('markedPlan', plan.read, { projectId: f.projectId })).rows);
const begin = async (f, intent, operationId = randomUUID()) => {
  const main = f.currentMain();
  return JSON.parse(
    await f.store.transaction('plannedStart', start.start, {
      projectId: f.projectId,
      operationId,
      authorityEpoch: 1,
      expectedMain: { head: main.head, receiptId: main.receipt.id },
      intent,
    }),
  );
};
const planned = id => ({ kind: 'planned', intentId: id, outcome: 'Planned test work' });
const markRow = (f, itemId) =>
  [...f.tables.projectFinishReadRows.values()].find(
    row =>
      row.kind.startsWith('plan-item-lanes:') && (!itemId || row.sourceId === `${f.projectId}:${itemId}`),
  );
const close = (f, id, state = 'abandoned') => f.changeLane(id, { state, lifecycleVersion: 1 });

test('starting a planned Lane marks Plan and skips Next, and concurrent siblings keep the mark', async () => {
  const f = await acceptanceFixture();
  const [id, free] = [randomUUID(), randomUUID()];
  addPlan(f, [id, free]);
  assert.equal(nextItem(await rows(f)).next?.id, id);
  const operationId = randomUUID();
  const [first, second] = await Promise.all([
    begin(f, planned(id), operationId),
    begin(f, { ...planned(id) }),
  ]);
  assert.notEqual(first.lane.laneId, second.lane.laneId);
  assert.deepEqual(await begin(f, planned(id), operationId), first);
  const marked = await rows(f);
  assert.equal(marked[0].inLane, true);
  assert.equal(nextItem(marked).next?.id, free);
  assert.equal(nextItem(marked).skipped[0].reason, 'in-lane');
  assert.equal(JSON.parse(markRow(f).value).open, 2);
  await close(f, first.lane.laneId);
  assert.equal((await rows(f))[0].inLane, true);
  await close(f, second.lane.laneId);
  assert.equal((await rows(f))[0].inLane, undefined);
  assert.equal(nextItem(await rows(f)).next?.id, id);
});

for (const { label, keepOpen, sibling } of [
  { label: 'when closing the Lane', keepOpen: false, sibling: false },
  { label: 'when keeping the Lane open', keepOpen: true, sibling: false },
  { label: 'with an open sibling on the same Item', keepOpen: false, sibling: true },
])
  test(`the first Lane completion tick retires the exact landed work ${label}`, async () => {
    const f = await acceptanceFixture();
    const [id, free] = [randomUUID(), randomUUID()];
    addPlan(f, [id, free]);
    const started = await begin(f, planned(id));
    const lane = await f.changeLane(started.lane.laneId, { head: f.state.sha256, sourceVersion: 1 });
    if (sibling) await begin(f, planned(id));
    const originalMark = markRow(f, id);
    assert.equal(JSON.parse(originalMark.value).open, sibling ? 2 : 1);
    const item = await f.makeCandidate([
      {
        laneId: lane.id,
        head: lane.head,
        version: lane.version,
        sourceVersion: lane.sourceVersion,
        lifecycleVersion: lane.lifecycleVersion,
        state: { object: { sha256: lane.head, size: f.state.size }, recipe: null },
      },
    ]);
    const { state } = await f.ready(item, { keepOpen });
    const accepted = await f.accept(state);
    assert.equal(f.currentMain().receipt.id, accepted.receipt.id);
    const beforeTick = await rows(f);
    assert.equal(beforeTick[0].inLane, true);
    assert.equal(nextItem(beforeTick).next?.id, free);
    await f.materialize(accepted.receipt.id);
    assert.equal((await f.readLane(lane.id)).state, keepOpen ? 'active' : 'completed');
    const afterTick = await rows(f);
    assert.equal(afterTick[0].inLane, sibling ? true : undefined);
    assert.equal(nextItem(afterTick).next?.id, sibling ? free : id);
    const afterTickMark = markRow(f, id);
    if (sibling) {
      assert.equal(afterTickMark._id, originalMark._id);
      assert.equal(JSON.parse(afterTickMark.value).open, 1);
    } else assert.equal(afterTickMark, undefined);

    if (keepOpen) {
      const next = f.put(
        JSON.stringify({ ...JSON.parse(f.objectBytes.get(lane.head)), parents: [lane.head] }),
      );
      await f.store.transaction(
        'saveAfterKeepOpen',
        { _handler: writeHostedRecord },
        {
          ...f.auth,
          expectedVersion: lane.version,
          record: {
            ...lane,
            version: lane.version + 1,
            head: next.sha256,
            sourceVersion: lane.sourceVersion + 1,
          },
        },
      );
      assert.equal((await rows(f))[0].inLane, true, 'new work on the keep-open Lane marks the Item again');
    }
    const beforeReplay = markRow(f, id);
    await f.materialize(accepted.receipt.id);
    assert.deepEqual(markRow(f, id), beforeReplay, 'replay preserves sibling and later contributions');
    const measured = f.counts.find(row => row.name === 'acceptanceComplete');
    assert.equal(measured.readRangesByTable.projectWorkGenerations, 1, 'select the legacy Work generation');
    assert.equal(measured.readRangesByTable.projectWorkDataRecords, 1, 'look up the durable Item tombstone');
    assert.equal(measured.readRangesByTable.projectPlanningRecords, undefined, 'no planning search read');
    assert.deepEqual(
      measured.written.filter(table => table.startsWith('projectWork') || table === 'projectPlanningRecords'),
      [],
      'the note fence writes no Work records',
    );
  });

const itemWrite = (f, command, endpoint = work.command) => {
  const operationId = randomUUID();
  return f.store.transaction('itemWrite', endpoint, {
    projectId: f.projectId,
    operationId,
    command: JSON.stringify({ ...command, operationId }),
    ...(endpoint === work.purgeFromServer ? { owner: 'owner' } : {}),
  });
};

const put = (itemId, expectedVersion, fields) => ({
  action: 'put-planning-item',
  itemId,
  expectedVersion,
  ...fields,
});

test('hosted Merge and Undo retain the actual Item Work links and their Lane marks', async () => {
  const f = await acceptanceFixture();
  const generationId = seedPlan(f);
  const keep = { id: randomUUID(), version: 1, title: 'Keep' };
  const duplicate = { id: randomUUID(), version: 1, title: 'Duplicate' };
  for (const item of [keep, duplicate])
    await itemWrite(f, put(item.id, 0, { kind: 'issue', title: item.title, status: 'open' }));
  const readItem = async id =>
    JSON.parse(
      (
        await f.store.transaction('mergedItemDetail', workIndex.detail, {
          projectId: f.projectId,
          generationId,
          collection: 'planningItems',
          id,
        })
      ).value,
    );
  const started = await begin(f, planned(duplicate.id));
  const laneId = started.lane.laneId;
  const laneWork = async id =>
    JSON.parse(
      await f.store.transaction('mergedItemWork', itemWork.read, { projectId: f.projectId, itemId: id }),
    ).lanes.map(lane => lane.laneId);
  const apply = async writes =>
    JSON.parse(
      await f.store.transaction('mergeOrUndo', batch.apply, {
        projectId: f.projectId,
        operationId: randomUUID(),
        writes: JSON.stringify(writes),
      }),
    ).results;
  const mark = markRow(f, duplicate.id)._id;
  assert.equal((await rows(f)).find(row => row.id === duplicate.id).inLane, true);
  const writes = mergeItems(await readItem(keep.id), [await readItem(duplicate.id)], []);
  const results = await apply(writes);
  assert.deepEqual(
    results.map(result => result.outcome),
    ['applied', 'applied'],
  );
  assert.deepEqual((await readItem(keep.id)).intentIds, [duplicate.id]);
  assert.deepEqual(await laneWork(keep.id), []);
  assert.deepEqual(await laneWork(duplicate.id), [laneId]);
  assert.equal((await rows(f)).find(row => row.id === keep.id).inLane, undefined);
  assert.equal(markRow(f, duplicate.id)._id, mark);
  assert.equal(markRow(f, duplicate.id).kind, 'plan-item-lanes:abandoned');

  const { undo } = batchUndo(writes, results);
  assert.deepEqual(undo[0].intentIds, []);
  assert.deepEqual(
    (await apply(undo)).map(result => result.outcome),
    ['applied', 'applied'],
  );
  assert.deepEqual((await readItem(keep.id)).intentIds, []);
  assert.deepEqual(await laneWork(keep.id), []);
  assert.deepEqual(await laneWork(duplicate.id), [laneId]);
  assert.equal(markRow(f, duplicate.id)._id, mark);
  assert.equal((await rows(f)).find(row => row.id === duplicate.id).inLane, true);

  const { head, version, sourceVersion, lifecycleVersion } = await f.readLane(laneId);
  const request = JSON.stringify({
    operationId: randomUUID(),
    authorityEpoch: 1,
    action: 'abandon',
    reason: 'Finished the fixture',
    target: { kind: 'lane', laneId, expected: { head, version, sourceVersion, lifecycleVersion } },
  });
  const abandon = () =>
    f.store.transaction('abandonMergedLane', lifecycle.transition, { projectId: f.projectId, request });
  assert.equal(JSON.parse(await abandon()).status, 'applied');
  assert.equal((await f.readLane(laneId)).state, 'abandoned');
  assert.equal((await rows(f)).find(row => row.id === duplicate.id).inLane, undefined);
  assert.equal(JSON.parse(await abandon()).status, 'applied');
  assert.equal(markRow(f, duplicate.id), undefined);
});

test('purging an Item unlinks its Lane mark in the same transaction', async () => {
  const f = await acceptanceFixture();
  seedPlan(f);
  const id = randomUUID();
  await itemWrite(f, put(id, 0, { kind: 'issue', title: 'Unlink this Item', status: 'open' }));
  const started = await begin(f, planned(id));
  assert.equal((await rows(f))[0].inLane, true);
  await itemWrite(f, put(id, 1, { status: 'in-progress' }));
  assert.equal((await rows(f))[0].inLane, true);
  await itemWrite(f, put(id, 2, { status: 'deleted' }));
  assert.equal(markRow(f, id).kind, 'plan-item-lanes:deleted');

  await itemWrite(
    f,
    {
      action: 'purge-planning-item',
      itemId: id,
      kind: 'issue',
      expectedVersion: 3,
      deletedAt: '2026-11-20T00:00:00.000Z',
      rows: purgeList(itemRows(f.tables.projectWorkEvents.values(), [id])),
    },
    work.purgeFromServer,
  );
  assert.equal(markRow(f, id), undefined);
  assert.equal((await f.readLane(started.lane.laneId)).state, 'active');
  await close(f, started.lane.laneId);
  assert.equal(markRow(f, id), undefined);
});

const dev = t =>
  t.mock.property(process, 'env', {
    ...process.env,
    CONVEX_CLOUD_URL: 'https://benevolent-wildebeest-974.convex.cloud',
  });
const verifyMarks = f => f.store.transaction('verify', backfill.verify, { projectId: f.projectId });
async function certifyMarks(f) {
  let next = { phase: 'lanes', cursor: null };
  let marked = 0;
  for (let i = 0; next && i < 12; i++) {
    const result = await f.store.transaction('verifiedMarkPass', backfill.run, {
      projectId: f.projectId,
      ...next,
    });
    assert(result.scanned <= 8);
    marked += result.marked;
    next = result.next;
  }
  assert.equal(next, null);
  assert.equal(await verifyMarks(f), true);
  return marked;
}
const workFor = (f, itemId) =>
  f.store.transaction(
    'rollupFacts',
    {
      _handler: async ctx => {
        const project = await ctx.db.get(f.projectId);
        const generation = await ctx.db.get(project.work.generationId);
        return (
          await rollupWorkReader(ctx, project, generation, 32).read({
            id: itemId,
            kind: 'issue',
            status: 'open',
          })
        ).work;
      },
    },
    {},
  );

test('membership alone does not certify an unmarked open Lane for roll-up', async t => {
  dev(t);
  const f = await acceptanceFixture();
  const itemId = randomUUID();
  addPlan(f, [itemId]);
  const started = await begin(f, planned(itemId));
  const overlap = [...f.tables.projectHostedOverlapLanes.values()].find(
    row => row.laneId === started.lane.laneId,
  );
  f.tables.projectFinishReadRows.delete(overlap.planLaneMark);
  f.patch('projectHostedOverlapLanes', overlap._id, { planLaneMark: undefined, planLanePin: undefined });
  await assert.rejects(verifyMarks(f), { code: 'WORK_STALE' });
  assert.equal(
    await workFor(f, itemId),
    'active',
    'unverified projects retain the legacy open-Lane evidence',
  );
  await assert.rejects(
    f.store.transaction('forgedFrontier', backfill.run, {
      projectId: f.projectId,
      phase: 'lanes',
      cursor: 'not-a-retained-cursor',
    }),
    { code: 'WORK_STALE' },
  );
  assert.equal(await certifyMarks(f), 1);
  assert.equal(await certifyMarks(f), 0);
  assert.equal(await workFor(f, itemId), 'active');
  assert.equal(JSON.parse(markRow(f, itemId).value).open, 1);
});

for (const older of [false, true])
  test(`pin and unpin maintain roll-up evidence for a landed keep-open Lane on the ${older ? 'older' : 'newest'} Intent`, async t => {
    dev(t);
    const f = await acceptanceFixture();
    const itemId = randomUUID();
    addPlan(f, [itemId]);
    const started = await begin(f, planned(itemId));
    const lane = await f.changeLane(started.lane.laneId, { head: f.state.sha256, sourceVersion: 1 });
    const composed = await f.makeCandidate([
      {
        laneId: lane.id,
        head: lane.head,
        version: lane.version,
        sourceVersion: lane.sourceVersion,
        lifecycleVersion: lane.lifecycleVersion,
        state: { object: { sha256: lane.head, size: f.state.size }, recipe: null },
      },
    ]);
    const { state } = await f.ready(composed, { keepOpen: true });
    const accepted = await f.accept(state);
    await f.materialize(accepted.receipt.id);
    assert.equal((await f.readLane(lane.id)).state, 'active');
    assert.equal(markRow(f, itemId), undefined);
    const set = async pinned =>
      JSON.parse(
        await f.store.transaction('setPin', setPin, {
          projectId: f.projectId,
          authorityEpoch: 1,
          laneId: lane.id,
          pinned,
        }),
      );
    if (older) {
      const record = await f.runAcceptance('previousIntent', readHostedRecord, {
        ...f.auth,
        kind: 'intent',
        key: itemId,
      });
      const old = JSON.parse(record.value);
      if (old.status !== 'completed')
        await f.runAcceptance('finishPreviousIntent', writeHostedRecord, {
          ...f.auth,
          expectedVersion: old.version,
          record: { ...old, version: old.version + 1, status: 'completed' },
        });
      const successor = await begin(f, planned(itemId));
      assert.notEqual(successor.intentId, itemId);
      await close(f, successor.lane.laneId);
    }
    assert.equal(await certifyMarks(f), 0);
    assert.notEqual(await workFor(f, itemId), 'active');
    assert.equal((await set(true)).changed, true);
    assert.equal((await set(true)).changed, false);
    assert.equal(JSON.parse(markRow(f, itemId).value).open, 1);
    assert.equal(await workFor(f, itemId), 'active');
    assert.equal((await set(false)).changed, true);
    assert.equal(markRow(f, itemId), undefined);
    assert.notEqual(await workFor(f, itemId), 'active');
  });

test('an Intent cascade removes its staged Lane marks when abandonment becomes visible', async () => {
  const f = await acceptanceFixture();
  const itemId = randomUUID();
  addPlan(f, [itemId]);
  const first = await begin(f, planned(itemId));
  const sibling = await begin(f, planned(itemId));
  const operationId = randomUUID();
  const started = await f.store.transaction('cascadeBegin', lifecycle.transition, {
    projectId: f.projectId,
    request: JSON.stringify({
      operationId,
      action: 'abandon',
      reason: 'Synthetic cascade',
      authorityEpoch: 1,
      target: { kind: 'intent', intentId: itemId, version: 0, cascade: true },
    }),
  });
  assert.equal(JSON.parse(started).status, 'pending');
  const advance = async () =>
    JSON.parse(
      await f.store.transaction('cascadeAdvance', lifecycle.advance, {
        projectId: f.projectId,
        operationId,
      }),
    );
  assert.equal((await advance()).status, 'pending');
  assert.equal((await rows(f))[0].inLane, true);
  assert.equal((await advance()).status, 'applied');
  assert.equal((await rows(f))[0].inLane, undefined);
  assert.equal((await f.readLane(first.lane.laneId)).state, 'abandoned');
  assert.equal((await f.readLane(sibling.lane.laneId)).state, 'abandoned');
});
