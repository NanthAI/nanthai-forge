// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
import { nextItem } from '../dist/planning-model.js';
import { successorIntentId } from '../dist/hosted-intent-chain.js';

const start = await import(moduleUrl('../convex/projectHostedStart.ts'));
const plan = await import(moduleUrl('../convex/projectPlanView.ts'));
const itemWork = await import(moduleUrl('../convex/projectItemWork.ts'));
const lifecycle = await import(moduleUrl('../convex/projectHostedLifecycle.ts'));
const backfill = await import(moduleUrl('../convex/projectPlanLaneBackfill.ts'));
const marks = await import(moduleUrl('../convex/projectPlanLaneMarks.ts'));
const { readHostedRecord, writeHostedRecord } = await import(moduleUrl('../convex/projectHostedRecords.ts'));

function addPlan(f, ids) {
  const backupId = 'synthetic-backup';
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
    work: { operationId: randomUUID(), initialRevision: 0, revision: 0, backupId, generationId },
  });
  return ids.map((id, position) => {
    const item = { id, title: `Item ${position}`, kind: 'issue', status: 'open' };
    const rootId = f.insert('projectPlanningRecords', {
      projectId: f.projectId,
      generationId,
      collection: 'planningSearch',
      key: id,
      parent: '',
      position,
      value: JSON.stringify(item),
      planning: { text: item.title, kind: item.kind, status: item.status, initiativeId: '', open: true },
    });
    return { item, rootId };
  });
}

const rows = async f =>
  JSON.parse((await f.store.transaction('markedPlan', plan.read, { projectId: f.projectId })).rows);
const begin = async (f, intent, operationId = randomUUID()) =>
  JSON.parse(
    await f.store.transaction('plannedStart', start.start, {
      projectId: f.projectId,
      operationId,
      authorityEpoch: 1,
      expectedMain: { head: f.main.head, receiptId: f.main.receipt.id },
      intent,
    }),
  );
const planned = id => ({ kind: 'planned', intentId: id, outcome: 'Planned test work' });
const markRow = f =>
  [...f.tables.projectFinishReadRows.values()].find(row => row.kind.startsWith('plan-item-lanes:'));
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

test('an accepted head clears its Item mark even when the Lane stays active', async () => {
  const f = await acceptanceFixture();
  const id = randomUUID();
  addPlan(f, [id]);
  const started = await begin(f, planned(id));
  const lane = await f.changeLane(started.lane.laneId, { head: f.state.sha256, sourceVersion: 1 });
  assert.equal((await rows(f))[0].inLane, true);
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
  const { state } = await f.ready(item, { keepOpen: true });
  const accepted = await f.accept(state);
  await f.materialize(accepted.receipt.id);
  assert.equal((await f.readLane(lane.id)).state, 'active');
  assert.equal((await rows(f))[0].inLane, undefined);
  await f.materialize(accepted.receipt.id);
  assert.equal(markRow(f), undefined);
  const measured = f.counts.find(row => row.name === 'acceptanceComplete');
  assert.equal(measured.readRangesByTable.projectWorkGenerations, undefined);
  assert.equal(measured.readRangesByTable.projectPlanningRecords, undefined);
});

test('backfill restores an existing successor link, pages old work, and replays without recounting', async () => {
  const f = await acceptanceFixture();
  const id = randomUUID();
  await begin(f, planned(id));
  const row = await f.runAcceptance('legacyIntent', readHostedRecord, { ...f.auth, kind: 'intent', key: id });
  const old = JSON.parse(row.value);
  await f.runAcceptance('legacyIntentComplete', writeHostedRecord, {
    ...f.auth,
    expectedVersion: old.version,
    record: { ...old, version: old.version + 1, status: 'completed' },
  });
  const successor = successorIntentId(id);
  const linked = await begin(f, planned(id));
  assert.equal(linked.intentId, successor);
  // Simulate a successor and its overlap row retained before the mark and reverse link existed.
  for (const head of f.tables.projectHostedRecordHeads.values())
    if (head.key === successor) f.patch('projectHostedRecordHeads', head._id, { planningItemId: undefined });
  for (const [rowId, overlap] of f.tables.projectHostedOverlapLanes)
    if (overlap.intentId === id) f.patch('projectHostedOverlapLanes', rowId, { open: false });
  const ids = Array.from({ length: 43 }, () => randomUUID());
  addPlan(f, [id, ...ids]);
  assert.equal((await rows(f)).find(row => row.id === id).inLane, undefined);
  const run = async () => {
    let next = { phase: 'items', cursor: null },
      pages = 0,
      marked = 0;
    while (next) {
      const result = await f.store.transaction('backfill', backfill.run, { projectId: f.projectId, ...next });
      assert(result.scanned <= 20);
      assert(++pages <= 8);
      marked += result.marked;
      next = result.next;
    }
    return [pages, marked];
  };
  assert.deepEqual(await run(), [4, 1]);
  assert.deepEqual(await run(), [4, 0]);
  assert.equal((await rows(f)).find(row => row.id === id).inLane, true);
  const overlap = [...f.tables.projectHostedOverlapLanes.values()].find(
    row => row.laneId === linked.lane.laneId,
  );
  assert.deepEqual(overlap.planLanePin, { sourceVersion: 0, lifecycleVersion: 0 });
  await f.runAcceptance('reopenEarlierIntent', writeHostedRecord, {
    ...f.auth,
    expectedVersion: old.version + 1,
    record: { ...old, version: old.version + 2, status: 'active' },
  });
  const work = JSON.parse(
    await f.store.transaction('itemWork', itemWork.read, {
      projectId: f.projectId,
      itemId: id,
    }),
  );
  assert(work.lanes.some(lane => lane.laneId === linked.lane.laneId && lane.state === 'open'));
  await close(f, linked.lane.laneId);
  assert.equal((await rows(f)).find(row => row.id === id).inLane, undefined);
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

test('moving or purging an Item preserves or removes its live mark in the planning write', async () => {
  const f = await acceptanceFixture();
  const id = randomUUID();
  const [{ item, rootId }] = addPlan(f, [id]);
  const lane = await begin(f, planned(id));
  const update = (before, after) =>
    f.store.transaction(
      'changeLinkedItem',
      {
        _handler: async ctx => {
          await marks.movePlanLaneMark(ctx, f.projectId, before, after);
          await ctx.db.patch(rootId, {
            value: JSON.stringify(after),
            planning: {
              text: after.title,
              kind: after.kind,
              status: after.status,
              initiativeId: '',
              open: true,
            },
          });
        },
      },
      {},
    );
  const moved = { ...item, status: 'in-progress' };
  await update(item, moved);
  assert.equal((await rows(f))[0].inLane, true);
  await update(moved, { ...moved, status: 'deleted', purged: true });
  assert.equal(markRow(f), undefined);
  await close(f, lane.lane.laneId);
  assert.equal(markRow(f), undefined);
});
