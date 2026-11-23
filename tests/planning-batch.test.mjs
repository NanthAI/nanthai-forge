// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Backlog batches (Item 65b0e706, docs/planning.md "Batches"): one action on many Items is one retry-safe call with
// per-Item results and one Undo; split and merge are batches too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { getDocumentSize } from 'convex/values';
import { nextItem, planOrder } from '../dist/planning-model.js';
import {
  batchSentence,
  batchUndo,
  changeEach,
  closeAnywayReason,
  closeMany,
  doneWhenLines,
  mergeItems,
  planningBatchLimit,
  splitItem,
} from '../dist/planning-batch.js';
import { planFilterMatch } from '../dist/planning-filter.js';
import { planningSearchEntry } from '../dist/planning-search.js';
import { indexedRecord, intentHeader } from '../dist/work-hosted-index.js';
import { setup } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { meterReads, meterWorkIO } from './hosted-read-set.mjs';
import { planFixture } from './plan-read-fixture.mjs';

const batch = await import(moduleUrl('../convex/projectPlanningBatch.ts'));
const { continueApply } = await import(moduleUrl('../convex/projectPlanningClose.ts'));
const { read: readPlan } = await import(moduleUrl('../convex/projectPlanView.ts'));
const { planCounts } = await import(moduleUrl('../convex/projectPlanCounts.ts'));
const { publicWorkPlan } = await import(moduleUrl('../convex/publicWorkPlan.ts'));
const { emptyPlanCounts, planCountsBirth, planRootFacts, PLAN_COUNTS, tallyGroup } = await import(
  moduleUrl('../convex/projectPlanCountsStore.ts')
);
const { planView, PLAN_LIVE_LIMIT } = await import(moduleUrl('../convex/projectPlanView.ts'));
const { recordPartition } = await import(moduleUrl('../convex/projectWorkIndexStore.ts'));
const { finishReadWriter } = await import(moduleUrl('../convex/projectFinishReadWriter.ts'));
const { runBatch } = await import(moduleUrl('../web/src/app/plan/batch.ts'));
const id = () => randomUUID();
const closeTasks = s =>
  s.scheduled.filter(task => getFunctionName(task.fn) === 'projectPlanningClose:continueApply');
const runCloseTask = (s, task) => s.transaction(() => continueApply._handler(s.ctx, task.args));

async function useSearchRoots(s, coverage) {
  const generationId = s.tables.hostedProjects.get(s.projectId).work.generationId;
  const partition = recordPartition(s.tables.projectWorkGenerations.get(generationId));
  const { db } = finishReadWriter(s.ctx);
  for (const id of new Set([generationId, partition]))
    await db.patch(id, { planRowsVersion: undefined, planningSearchVersion: coverage });
  return partition;
}

const planBatch = (s, writes, options, operationId = id()) =>
  s
    .transaction(() =>
      batch.apply._handler(s.ctx, {
        projectId: s.projectId,
        operationId,
        writes: JSON.stringify(writes),
        ...options,
      }),
    )
    .then(JSON.parse);

test('explicit close preserves live direct children in their stored Initiatives and one replayable Undo restores their links', async t => {
  const s = await setup(t);
  const add = async fields => {
    const item = s.item(fields);
    await s.send(item);
    return item.itemId;
  };
  const first = await add({ kind: 'initiative' });
  const second = await add({ kind: 'initiative' });
  const parent = await add({ initiativeId: first });
  const otherParent = await add({});
  const proposed = await add({ parentId: parent, initiativeId: second, status: 'proposed' });
  const active = await add({ parentId: otherParent, status: 'in-progress', body: 'Keep this history.' });
  const planned = await add({ parentId: parent, initiativeId: first });
  const selectedChild = await add({ parentId: otherParent, initiativeId: second });
  const done = await add({ parentId: parent, status: 'closed' });
  const dropped = await add({ parentId: parent, status: 'abandoned' });
  const grandchild = await add({ parentId: planned });
  const writes = closeMany(
    [parent, otherParent, selectedChild].map(id => ({ id, version: 1 })),
    'Shipped',
  ).writes;
  const operationId = id();
  const scheduled = closeTasks(s).length;
  const receipt = await planBatch(s, writes, { close: true }, operationId);
  assert.equal(receipt.pending, undefined);
  assert.equal(closeTasks(s).length, scheduled);
  assert.equal(receipt.detached, 3);
  assert.deepEqual(
    receipt.results.map(row => row.outcome),
    ['applied', 'applied', 'applied'],
  );
  const addedLater = await add({ parentId: parent });
  s.caller('foreign');
  await assert.rejects(
    planBatch(s, writes, { close: true }, operationId),
    error => error.data.code === 'PROJECT_UNAVAILABLE',
  );
  s.caller('owner');
  assert.deepEqual(await planBatch(s, writes, { close: true }, operationId), receipt);
  await assert.rejects(
    planBatch(s, writes.slice(0, 1), { close: true }, operationId),
    error => error.data.code === 'WORK_OPERATION_CHANGED',
  );

  const closed = (await s.read()).data.planningItems;
  const latest = itemId => closed.filter(item => item.id === itemId).at(-1);
  assert.deepEqual(
    [parent, otherParent, selectedChild].map(key => latest(key).status),
    ['closed', 'closed', 'closed'],
  );
  assert.deepEqual(
    [proposed, active, planned].map(key => {
      const { parentId, initiativeId, status, version } = latest(key);
      return [parentId, initiativeId, status, version];
    }),
    [
      [undefined, second, 'proposed', 2],
      [undefined, undefined, 'in-progress', 2],
      [undefined, first, 'open', 2],
    ],
  );
  assert.deepEqual(
    [selectedChild, done, dropped, grandchild, addedLater].map(key => latest(key).parentId),
    [otherParent, parent, parent, planned, parent],
  );
  assert.equal(latest(parent).reason, 'Shipped');
  assert.equal(latest(active).body, 'Keep this history.');
  assert.equal(closed.find(item => item.id === proposed && item.version === 1).parentId, parent);

  const call = args => s.transaction(() => batch.apply._handler(s.ctx, args));
  const replay = await runBatch(call, s.projectId, writes, { close: true, operationId });
  assert.equal(replay.undoClose, operationId);
  assert.equal(replay.detached, 3);
  const undoId = id();
  const undone = await runBatch(call, s.projectId, [], { undoClose: replay.undoClose, operationId: undoId });
  assert.equal(undone.results.length, 6);
  assert.equal(closeTasks(s).length, scheduled);
  assert.deepEqual(
    await runBatch(call, s.projectId, [], { undoClose: replay.undoClose, operationId: undoId }),
    undone,
  );
  const history = (await s.read()).data.planningItems;
  const restored = itemId => history.filter(item => item.id === itemId).at(-1);
  assert.deepEqual(
    [parent, otherParent, selectedChild].map(key => restored(key).status),
    ['open', 'open', 'open'],
  );
  assert.deepEqual(
    [proposed, active, planned].map(key => restored(key).parentId),
    [parent, otherParent, parent],
  );
  assert.deepEqual(
    [proposed, active, planned].map(key => restored(key).initiativeId),
    [second, undefined, first],
  );
  assert.deepEqual(
    history.filter(item => item.id === proposed).map(item => item.parentId),
    [parent, undefined, parent],
  );
});

test('a parent missed by a stale close keeps its children, and Undo skips a child edited since detachment', async t => {
  const s = await setup(t);
  const stale = s.item({ title: 'Edited parent' });
  const parent = s.item({ title: 'Other parent' });
  const staleChild = s.item({ parentId: stale.itemId });
  const child = s.item({ parentId: parent.itemId });
  for (const item of [stale, parent, staleChild, child]) await s.send(item);
  await s.send(s.item({ itemId: stale.itemId, expectedVersion: 1, title: 'Edited meanwhile' }));
  await s.send(s.item({ itemId: child.itemId, expectedVersion: 1, title: 'Edited before close' }));
  const operationId = id();
  const writes = closeMany(
    [stale, parent, child].map(item => ({ id: item.itemId, version: 1 })),
    '',
  ).writes;
  const receipt = await planBatch(s, writes, { close: true }, operationId);
  assert.equal(receipt.detached, 1);
  assert.deepEqual(
    receipt.results.map(row => [row.outcome, row.code]),
    [
      ['refused', 'ITEM_CHANGED'],
      ['applied', undefined],
      ['refused', 'ITEM_CHANGED'],
    ],
  );
  await s.send(s.item({ itemId: child.itemId, expectedVersion: 3, title: 'Edited after detaching' }));

  const undo = await planBatch(s, [], { undoClose: operationId });
  assert.deepEqual(
    undo.results.map(row => [row.itemId, row.outcome, row.code]),
    [
      [parent.itemId, 'applied', undefined],
      [child.itemId, 'refused', 'ITEM_CHANGED'],
    ],
  );
  const history = (await s.read()).data.planningItems;
  const latest = itemId => history.filter(item => item.id === itemId).at(-1);
  assert.equal(latest(parent.itemId).status, 'open');
  assert.equal(latest(staleChild.itemId).parentId, stale.itemId);
  assert.equal(latest(child.itemId).parentId, undefined);
  assert.equal(latest(child.itemId).title, 'Edited after detaching');
});

test('close reads canonical hierarchy when a legacy live child has no search root', async t => {
  const s = await setup(t);
  const parent = s.item({});
  const child = s.item({ parentId: parent.itemId, body: 'A large retained body. '.repeat(1800) });
  await s.send(parent);
  await s.send(child);
  const generationId = await useSearchRoots(s, 1);
  for (const [key, row] of s.tables.projectPlanningRecords) {
    if (row.generationId === generationId && row.collection === 'planningSearch' && row.key === child.itemId)
      await s.ctx.db.delete(key);
  }
  const screen = await planView(s.ctx, s.projectId);
  assert.ok(!JSON.parse(screen.rows).some(row => row.id === child.itemId));
  const result = await planBatch(s, closeMany([{ id: parent.itemId, version: 1 }], '').writes, {
    close: true,
  });
  assert.equal(result.detached, 1);
  const history = (await s.read()).data.planningItems;
  const versions = history.filter(item => item.id === child.itemId);
  assert.deepEqual(
    versions.map(item => item.parentId),
    [parent.itemId, undefined],
  );
  assert.deepEqual(
    versions.map(item => item.body),
    [child.body, child.body],
  );
});

test('close finds a stored sub-item beyond the live Plan window through bounded search pages', async t => {
  const s = await setup(t);
  const parent = s.item({});
  await s.send(parent);
  const child = s.item({ parentId: parent.itemId, title: 'Outside the Plan window' });
  await s.send(child);
  const generationId = await useSearchRoots(s, 2);
  for (const [key, row] of s.tables.projectPlanningRecords) {
    if (row.generationId === generationId && row.collection === 'planningSearch' && row.key === child.itemId)
      await s.ctx.db.patch(key, { position: PLAN_LIVE_LIMIT + 10 });
  }
  for (let position = 2; position <= PLAN_LIVE_LIMIT + 1; position++) {
    const entry = planningSearchEntry(
      {
        id: id(),
        kind: 'issue',
        title: 'Another live Item',
        body: '',
        version: 1,
        status: 'open',
        intentIds: [],
      },
      position,
    );
    await s.ctx.db.insert('projectPlanningRecords', { ...entry, projectId: s.projectId, generationId });
  }
  const screen = await planView(s.ctx, s.projectId);
  assert.equal(screen.more, true);
  assert.ok(!JSON.parse(screen.rows).some(row => row.id === child.itemId));
  const meter = meterReads(s.ctx);
  const cost = await meter.cost(async () => {
    const result = await planBatch(s, closeMany([{ id: parent.itemId, version: 1 }], '').writes, {
      close: true,
    });
    assert.equal(result.detached, 1);
  });
  meter.restore();
  t.diagnostic(JSON.stringify({ partialPlanClose: cost }));
  const history = (await s.read()).data.planningItems;
  assert.equal(history.filter(item => item.id === child.itemId).at(-1).parentId, undefined);
});

async function closeBudgetFixture(t, scale, compact) {
  const s = await planFixture(t, scale);
  const items = () =>
    new Map(
      [...s.tables.projectPlanningRecords.values(), ...s.tables.projectWorkDataRecords.values()]
        .filter(row => row.generationId === s.generationId && row.collection === 'planningItems')
        .map(row => [row.key, JSON.parse(row.value)]),
    );
  const live = [...items().values()].filter(
    row => row.kind === 'issue' && ['open', 'in-progress', 'proposed'].includes(row.status),
  );
  assert.equal(live.length, 271 * scale);
  const [parent, keptParent, ...rest] = live;
  const children = rest.slice(-Math.floor((101 * scale) / 2));
  const selectedChild = rest[0];
  const settled = [...items().values()].find(row => row.kind === 'issue' && row.status === 'closed');
  for (const [child, owner] of [
    ...[...children, settled, selectedChild].map(child => [child, parent]),
    [rest[1], keptParent],
  ]) {
    for (const [id, row] of [...s.tables.projectPlanningRecords, ...s.tables.projectWorkDataRecords])
      if (row.generationId === s.generationId && row.key === child.id)
        await s.ctx.db.patch(id, { value: JSON.stringify({ ...JSON.parse(row.value), parentId: owner.id }) });
  }
  for (const [position, initiative] of [...items().values()]
    .filter(row => row.kind === 'initiative')
    .entries())
    for (const entry of indexedRecord('initiatives', initiative.id, '', position, initiative))
      await s.ctx.db.insert('projectWorkRecords', {
        ...entry,
        projectId: s.projectId,
        generationId: s.generationId,
      });
  for (const [position, row] of [parent, keptParent, selectedChild, ...children].entries()) {
    const intent = {
      id: row.id,
      title: row.title,
      outcome: row.title,
      description: row.body,
      constraints: '',
      status: row.status === 'proposed' ? 'proposed' : 'active',
      createdAt: row.at,
      notes: [],
      memberships: [{ initiativeId: row.initiativeId, sourceId: row.id, order: position }],
      relatedIntentIds: [],
      historyRefs: [{ itemId: row.id, version: row.version }],
      conversation: [],
    };
    for (const entry of indexedRecord('intents', row.id, '', position, intent, intentHeader(intent)))
      await s.ctx.db.insert(
        entry.collection === 'intents' ? 'projectWorkRecords' : 'projectWorkDataRecords',
        {
          ...entry,
          projectId: s.projectId,
          generationId: s.generationId,
        },
      );
  }
  if (compact) await s.project();
  else await useSearchRoots(s, 1);
  const counts = emptyPlanCounts(true);
  for (const record of s.tables.projectPlanningRecords.values()) {
    if (record.generationId !== s.generationId) continue;
    const facts = planRootFacts(record);
    if (!facts) continue;
    counts[facts.kind][facts.status]++;
    tallyGroup(counts, facts.group, facts.status, 1);
  }
  const counter = [...s.tables.projectWorkDataRecords.values()].find(
    row => row.generationId === s.generationId && row.collection === PLAN_COUNTS,
  );
  const value = JSON.stringify(counts);
  if (counter) await s.ctx.db.patch(counter._id, { value });
  else
    await s.ctx.db.insert('projectWorkDataRecords', {
      ...planCountsBirth(s.projectId, s.generationId),
      value,
    });
  const writes = closeMany(
    [
      parent,
      { ...keptParent, version: keptParent.version - 1 },
      selectedChild,
      { ...children[0], version: children[0].version - 1 },
    ],
    'Synthetic close',
  ).writes;
  return { s, items, parent, children, settled, selectedChild, writes };
}

// Convex counts empty point lookups and queries as index ranges too.
const transactionRangeCeiling = 2_048;
async function transactionCost(s, run, failAfterVersions = Infinity) {
  const meter = meterWorkIO(s.ctx, s.tables);
  const { query, get } = s.ctx.db;
  let indexRanges = 0;
  const events = s.tables.projectWorkEvents.size;
  const readRange = () => {
    indexRanges++;
    if (s.tables.projectWorkEvents.size - events >= failAfterVersions)
      throw new Error(
        'Documents read from or written to the fixture exceeded the simulated transaction budget.',
      );
  };
  s.ctx.db.query = (...args) => {
    readRange();
    return query(...args);
  };
  s.ctx.db.get = (...args) => {
    readRange();
    return get(...args);
  };
  const start = performance.now();
  try {
    const cost = await meter.cost(run);
    const wallMs = Math.round(performance.now() - start);
    const operationBytes = Math.max(
      0,
      ...[...s.tables.projectHostedOperations.values()].map(getDocumentSize),
    );
    return { ...cost, indexRanges, wallMs, operationBytes };
  } finally {
    meter.restore();
  }
}

async function pressureRollsBack(s, run) {
  const before = structuredClone(s.tables);
  const scheduled = s.scheduled.slice();
  const tasks = structuredClone(s.tasks);
  await assert.rejects(transactionCost(s, run, 4), error => error.data?.code === 'HOSTED_CONFLICT');
  assert.deepEqual(s.tables, before, 'versions, projections and operation receipts roll back together');
  assert.deepEqual(s.scheduled, scheduled);
  assert.deepEqual(s.tasks, tasks);
}

async function observedPlan(s) {
  const view = await planView(s.ctx, s.projectId);
  const rows = JSON.parse(view.rows);
  return {
    order: planOrder(rows).map(group => group.rows.map(({ row, depth }) => [row.id, depth])),
    next: nextItem(rows).next?.id,
    tallies: await planCounts(s.ctx, s.projectId),
  };
}

async function runClosePages(s, from, costs, states, retryFailedPage) {
  let cursor = from;
  while (cursor < closeTasks(s).length) {
    let task = closeTasks(s)[cursor++];
    const run = () => runCloseTask(s, task);
    if (retryFailedPage && cursor === from + 2) {
      await pressureRollsBack(s, run);
      s.tasks.set(task.id, { state: { kind: 'failed' } });
      const count = closeTasks(s).length;
      const receipt = await retryFailedPage();
      assert(receipt.pending);
      assert.deepEqual(await retryFailedPage(), receipt);
      assert.equal(closeTasks(s).length, count + 1, 'retry re-arms exactly one failed cursor');
      task = closeTasks(s)[cursor++];
    }
    const priorEvents = s.tables.projectWorkEvents.size;
    const cost = await transactionCost(s, run);
    costs.push(cost);
    states.push(await observedPlan(s));
    const events = s.tables.projectWorkEvents.size;
    assert(cost.indexRanges <= 18 * (events - priorEvents) + 80, JSON.stringify(cost));
    const count = closeTasks(s).length;
    await run();
    assert.equal(s.tables.projectWorkEvents.size, events, 'replayed cursor writes nothing');
    assert.equal(closeTasks(s).length, count, 'replayed cursor starts no chain');
  }
  assert(cursor > from, 'the operation needed at least one continuation');
}

for (const compact of [true, false])
  for (const scale of [4, 8])
    test(`close and Undo publish atomically at ${271 * scale} live Items with ${compact ? 'compact' : 'legacy'} coverage`, async t => {
      const { s, items, parent, children, settled, selectedChild, writes } = await closeBudgetFixture(
        t,
        scale,
        compact,
      );
      const initial = items();
      const before = await observedPlan(s);
      const closeId = id();
      const undoId = id();
      const closeRequest = () => planBatch(s, writes, { close: true }, closeId);
      const undoRequest = () => planBatch(s, [], { undoClose: closeId }, undoId);
      const injectFailure = scale === 4 && compact;
      const closeCosts = [],
        undoCosts = [];
      const closeStates = [],
        undoStates = [];
      const fromClose = closeTasks(s).length;
      let close, undo;
      if (injectFailure) await pressureRollsBack(s, closeRequest);
      closeCosts.push(
        await transactionCost(s, async () => {
          close = await closeRequest();
        }),
      );
      closeStates.push(await observedPlan(s));
      assert(close.pending);
      assert.deepEqual(await closeRequest(), close);
      assert.equal(closeTasks(s).length, fromClose + 1, 'client replay schedules no duplicate continuation');
      assert.equal(
        (await readPlan._handler(s.ctx, { projectId: s.projectId, observeClose: closeId })).closeReceipt,
        undefined,
      );
      await runClosePages(s, fromClose, closeCosts, closeStates, injectFailure && closeRequest);
      close = await closeRequest();
      assert.equal(close.pending, undefined);
      assert.equal(close.detached, children.length);
      assert.deepEqual(
        close.results.map(row => row.outcome),
        ['applied', 'refused', 'applied', 'refused'],
      );
      assert.equal(
        JSON.parse(
          (await readPlan._handler(s.ctx, { projectId: s.projectId, observeClose: closeId })).closeReceipt,
        ).operationId,
        closeId,
      );
      s.caller('foreign');
      await assert.rejects(closeRequest(), error => error.data?.code === 'PROJECT_UNAVAILABLE');
      s.caller('owner');
      const afterClose = items();
      assert.equal(afterClose.get(parent.id).status, 'closed');
      assert.equal(afterClose.get(selectedChild.id).status, 'closed');
      assert.equal(afterClose.get(selectedChild.id).parentId, parent.id);
      assert.deepEqual(afterClose.get(settled.id), initial.get(settled.id));
      for (const child of children) {
        const { parentId, status, title, body, initiativeId, version } = afterClose.get(child.id);
        assert.deepEqual(
          [parentId, status, title, body, initiativeId, version],
          [undefined, child.status, child.title, child.body, child.initiativeId, child.version + 1],
        );
      }
      const closedPlan = closeStates.at(-1);
      for (const state of closeStates) assert.deepEqual(state, closedPlan);

      const fromUndo = closeTasks(s).length;
      undoCosts.push(
        await transactionCost(s, async () => {
          undo = await undoRequest();
        }),
      );
      undoStates.push(await observedPlan(s));
      assert(undo.pending);
      assert.deepEqual(await undoRequest(), undo);
      assert.equal(closeTasks(s).length, fromUndo + 1);
      await runClosePages(s, fromUndo, undoCosts, undoStates, injectFailure && undoRequest);
      for (const state of undoStates.slice(0, -1)) assert.deepEqual(state, closedPlan);
      const restoredPlan = undoStates.at(-1);
      assert.deepEqual(restoredPlan.order, before.order);
      assert.equal(restoredPlan.next, before.next);
      assert.deepEqual(restoredPlan.tallies.issue, before.tallies.issue);
      undo = await undoRequest();
      assert.equal(undo.pending, undefined);
      assert.equal(undo.results.length, children.length + 2);
      const restored = items();
      const changed = new Set([parent.id, selectedChild.id, ...children.map(child => child.id)]);
      for (const [itemId, row] of initial) {
        const item = restored.get(itemId);
        if (!changed.has(itemId)) assert.deepEqual(item, row);
        else {
          assert.equal(item.version, row.version + 2);
          assert.equal(item.parentId, row.parentId);
          assert.equal(item.status, row.status);
        }
      }
      assert.equal(s.tables.projectWorkEvents.size, changed.size * 2);
      assert.equal(s.tables.projectHostedOperations.size, 2);
      assert.deepEqual(await undoRequest(), undo);
      assert.deepEqual(items(), restored);
      t.diagnostic(JSON.stringify({ closeCosts, undoCosts, peakRssKiB: process.resourceUsage().maxRSS }));
      for (const cost of [...closeCosts, ...undoCosts]) {
        assert(cost.indexRanges <= transactionRangeCeiling, JSON.stringify(cost));
        assert(cost.readBytes < 16 * 1024 * 1024, JSON.stringify(cost));
        assert(cost.writeBytes < 16 * 1024 * 1024, JSON.stringify(cost));
        assert(cost.readDocuments < 32_000, JSON.stringify(cost));
        assert(cost.writeDocuments < 16_000, JSON.stringify(cost));
      }
    });

test('Undo cancels an applying close and leaves unmaterialized children at their original versions', async t => {
  const { s, items, parent, children, writes } = await closeBudgetFixture(t, 2, true);
  const initial = items();
  const closeId = id(),
    undoId = id();
  const from = closeTasks(s).length;
  const close = await planBatch(s, writes, { close: true }, closeId);
  assert(close.pending);
  const task = closeTasks(s).at(-1);
  const partial = items();
  assert(children.some(child => partial.get(child.id).parentId === parent.id));
  assert(children.some(child => partial.get(child.id).parentId === undefined));
  const undo = await planBatch(s, [], { undoClose: closeId }, undoId);
  assert.equal(undo.pending, undefined);
  assert.equal(s.tasks.get(task.id).state.kind, 'canceled');
  await runCloseTask(s, task);
  assert.equal(closeTasks(s).length, from + 1);
  assert.equal(items().get(parent.id).status, initial.get(parent.id).status);
  for (const child of children) {
    const current = items().get(child.id);
    assert.equal(current.parentId, parent.id);
    assert.equal(current.version, child.version + (partial.get(child.id).parentId === undefined ? 2 : 0));
  }
});

test('an applying parent refuses status writes and an edited child keeps its changes through close and Undo', async t => {
  const { s, items, parent, children, writes } = await closeBudgetFixture(t, 2, true);
  const closeId = id();
  const from = closeTasks(s).length;
  assert((await planBatch(s, writes, { close: true }, closeId)).pending);
  const current = items();
  const live = children.find(child => current.get(child.id).parentId === parent.id);
  const detached = children.find(child => current.get(child.id).parentId === undefined);
  assert(live && detached);
  await assert.rejects(
    planBatch(s, changeEach([current.get(parent.id)], { status: 'open' })),
    error => error.data?.code === 'HOSTED_CONFLICT',
  );
  for (const child of [live, detached])
    await planBatch(s, changeEach([current.get(child.id)], { title: `Edit ${child.id}` }));
  await runClosePages(s, from, [], [], false);
  for (const child of [live, detached]) assert.equal(items().get(child.id).title, `Edit ${child.id}`);
  assert.equal(items().get(live.id).parentId, undefined);
  const undoFrom = closeTasks(s).length;
  const undoId = id();
  const undo = () => planBatch(s, [], { undoClose: closeId }, undoId);
  assert((await undo()).pending);
  await runClosePages(s, undoFrom, [], [], false);
  const receipt = await undo();
  assert.equal(receipt.results.find(row => row.itemId === detached.id).code, 'ITEM_CHANGED');
  assert.equal(items().get(detached.id).parentId, undefined);
  assert.equal(items().get(live.id).parentId, parent.id);
  assert.equal(items().get(live.id).title, `Edit ${live.id}`);
});

test('public Plan visibility and counts change at the parent boundary and give a later child no inherited promotion', async t => {
  const { s, items, parent, children, settled, writes } = await closeBudgetFixture(t, 2, true);
  let visible = children.find(child => !child.hidden);
  const hidden = children.find(child => child.hidden);
  assert(visible && hidden);
  await planBatch(s, changeEach([parent], { hidden: true }));
  writes[0].expectedVersion++;
  await finishReadWriter(s.ctx).db.patch(s.projectId, { visibility: 'public' });
  const project = s.tables.hostedProjects.get(s.projectId);
  const counter = [...s.tables.projectWorkDataRecords.values()].find(
    row => row.generationId === s.generationId && row.collection === PLAN_COUNTS,
  );
  const added = id();
  const visibility = async () => {
    const plan = publicWorkPlan(s.ctx, project, new Map());
    return Promise.all([visible.id, hidden.id, settled.id, added].map(plan.allowed));
  };
  const counts = async fallback => {
    const value = s.tables.projectWorkDataRecords.get(counter._id).value;
    if (fallback)
      await s.ctx.db.patch(counter._id, { value: JSON.stringify({ ...JSON.parse(value), done: false }) });
    s.caller('visitor');
    try {
      return (await planCounts(s.ctx, s.projectId)).issue;
    } finally {
      s.caller('owner');
      if (fallback) await s.ctx.db.patch(counter._id, { value });
    }
  };
  assert.deepEqual(await visibility(), [false, false, false, false]);
  const before = await counts(false);
  const beforeFallback = await counts(true);
  const closeId = id(),
    undoId = id();
  assert((await planBatch(s, writes, { close: true }, closeId)).pending);
  const partial = items();
  visible = children.find(child => !child.hidden && partial.get(child.id).parentId === parent.id);
  assert(visible, 'a public live child has not physically detached');
  assert.deepEqual(await visibility(), [true, false, false, false]);
  await planBatch(s, [
    {
      action: 'put-planning-item',
      itemId: added,
      expectedVersion: 0,
      kind: 'issue',
      title: 'Attached under a hidden parent after close started',
      status: 'open',
      parentId: parent.id,
    },
  ]);
  assert.deepEqual(await visibility(), [true, false, false, false]);
  const closedCounts = await counts(false);
  const closedFallback = await counts(true);
  await runCloseTask(s, closeTasks(s).at(-1));
  assert.deepEqual(await visibility(), [true, false, false, false]);
  assert.deepEqual(await counts(false), closedCounts);
  assert.deepEqual(await counts(true), closedFallback);
  assert.equal(items().get(added).parentId, parent.id);

  assert((await planBatch(s, [], { undoClose: closeId }, undoId)).pending);
  assert.deepEqual(await visibility(), [true, false, false, false]);
  assert.deepEqual(await counts(false), closedCounts);
  assert.deepEqual(await counts(true), closedFallback);
  await runCloseTask(s, closeTasks(s).at(-1));
  assert.deepEqual(await visibility(), [false, false, false, false]);
  assert.deepEqual(await counts(false), before);
  assert.deepEqual(await counts(true), beforeFallback);
});

test('an ordinary reopen leaves the earlier close’s detached child in its Initiative', async t => {
  const s = await setup(t);
  const parent = s.item(),
    child = s.item({ parentId: parent.itemId });
  await s.send(parent);
  await s.send(child);
  await planBatch(s, closeMany([{ id: parent.itemId, version: 1 }], 'Closed').writes, { close: true });
  await planBatch(s, changeEach([{ id: parent.itemId, version: 2 }], { status: 'open' }));
  const history = (await s.read()).data.planningItems;
  assert.equal(history.filter(item => item.id === child.itemId).at(-1).parentId, undefined);
});

test('batch Undo writes back exactly the fields the batch named, abandons creations and keeps comments', () => {
  const writes = [
    { action: 'put-planning-item', itemId: 'a', expectedVersion: 3, owner: '@mara', initiativeId: 'i2' },
    { action: 'put-planning-item', itemId: 'b', expectedVersion: 0, kind: 'issue', title: 'New part' },
    { action: 'comment-planning-item', itemId: 'a', text: 'carried' },
    { action: 'put-planning-item', itemId: 'c', expectedVersion: 1, status: 'closed' },
  ];
  const results = [
    {
      index: 0,
      itemId: 'a',
      action: writes[0].action,
      outcome: 'applied',
      version: 4,
      before: { owner: null, initiativeId: 'i1' },
    },
    { index: 1, itemId: 'b', action: writes[1].action, outcome: 'applied', version: 1, before: {} },
    { index: 2, itemId: 'a', action: writes[2].action, outcome: 'applied' },
    {
      index: 3,
      itemId: 'c',
      action: writes[3].action,
      outcome: 'refused',
      code: 'ITEM_CHANGED',
      currentVersion: 2,
    },
  ];
  assert.deepEqual(batchUndo(writes, results), {
    undo: [
      { action: 'put-planning-item', itemId: 'a', expectedVersion: 4, initiativeId: 'i1', owner: null },
      { action: 'put-planning-item', itemId: 'b', expectedVersion: 1, status: 'abandoned', reason: 'Undone' },
    ],
    kept: 1,
    unknown: 0,
  });
  assert.equal(batchSentence(results), '3 of 4 changed. 1 changed meanwhile and kept the other change.');
});

test('close many with one note names the Items whose Done-when lines stay open, with the close-anyway reason', () => {
  const rows = [
    { id: 'a', version: 2, doneWhen: [2, 2] },
    { id: 'b', version: 5, doneWhen: [1, 3] },
    { id: 'c', version: 1, doneWhen: null },
  ];
  const quiet = closeMany(rows, '');
  assert.deepEqual(
    quiet.writes.map(write => [write.itemId, write.expectedVersion, write.status, write.reason]),
    [
      ['a', 2, 'closed', 'Closed'],
      ['b', 5, 'closed', closeAnywayReason],
      ['c', 1, 'closed', 'Closed'],
    ],
  );
  assert.deepEqual(quiet.openLines, [{ id: 'b', open: 2 }]);
  assert.ok(closeMany(rows, ' Shipped in v3 ').writes.every(write => write.reason === 'Shipped in v3'));
  assert.deepEqual(changeEach(rows.slice(0, 1), { owner: '@jun' }), [
    { action: 'put-planning-item', itemId: 'a', expectedVersion: 2, owner: '@jun' },
  ]);
});

test('split gives every Done-when line to exactly one part and relates the parts both ways', () => {
  const item = {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    version: 7,
    title: 'Migration guide',
    body: 'Why: users move to v3.\n\nDone when:\n- [x] Removed APIs table\n- [ ] ESM-only steps\n- [ ] CommonJS section\n',
    initiativeId: 'init',
    type: 'task',
  };
  assert.equal(doneWhenLines(item.body).length, 3);
  const [first, second] = [id(), id()];
  const writes = splitItem(item, [{ title: 'ESM steps' }, { title: 'CommonJS' }], [0, 1, 2], [first, second]);
  assert.equal(writes.length, 3);
  assert.deepEqual(writes[0], {
    action: 'put-planning-item',
    itemId: item.id,
    expectedVersion: 7,
    body: 'Why: users move to v3.\n\nDone when:\n- [x] Removed APIs table\n',
    relations: [
      { kind: 'related', id: first },
      { kind: 'related', id: second },
    ],
    reason: 'Split into 3 parts',
  });
  assert.match(writes[1].body, /- \[ \] ESM-only steps\n$/);
  assert.match(writes[2].body, /- \[ \] CommonJS section\n$/);
  assert.ok(writes.slice(1).every(write => write.expectedVersion === 0 && write.initiativeId === 'init'));
  assert.deepEqual(writes[1].relations, [{ kind: 'related', id: item.id }]);
  assert.throws(() => splitItem(item, [{ title: 'x' }], [0, 1], [first]), RangeError);
  assert.throws(() => splitItem(item, [{ title: 'x' }], [0, 3, 1], [first]), RangeError);
});

test('merge carries comments and Lane links to the survivor and leaves a duplicate link on each duplicate', () => {
  const survivor = { id: 'aaaaaaaa-0000-4000-8000-000000000001', version: 3, title: 'Keep', intentIds: [] };
  const duplicate = {
    id: 'bbbbbbbb-0000-4000-8000-000000000002',
    version: 2,
    title: 'Dup',
    intentIds: ['cccccccc-0000-4000-8000-000000000003'],
    relations: [{ kind: 'related', id: 'dddddddd-0000-4000-8000-000000000004' }],
  };
  const writes = mergeItems(
    survivor,
    [duplicate],
    [
      { itemId: duplicate.id, text: 'Evidence: landed in 5c1e', at: '2026-11-12T10:00:00Z', author: 'mara' },
      { itemId: 'eeeeeeee-0000-4000-8000-000000000005', text: 'Not merged', at: '2026-11-12T10:00:00Z' },
    ],
  );
  assert.deepEqual(writes[0].intentIds, [duplicate.id, duplicate.intentIds[0]].sort());
  assert.equal(writes.filter(write => write.action === 'comment-planning-item').length, 1);
  assert.match(writes[1].text, /^From bbbbbbbb, 2026-11-12 \(mara\):\n\nEvidence: landed in 5c1e$/);
  assert.deepEqual(writes[2], {
    action: 'put-planning-item',
    itemId: duplicate.id,
    expectedVersion: 2,
    status: 'abandoned',
    reason: 'Duplicate of aaaaaaaa',
    relations: [...duplicate.relations, { kind: 'duplicate-of', id: survivor.id }],
  });
  assert.throws(() => mergeItems(survivor, [survivor], []), RangeError);
});

test('plan filters: type, owner (with their agents, or none) and relation kind', () => {
  const row = { type: 'Bug', owner: 'mara/amber-fox', relations: [{ kind: 'depends-on', id: 'x' }] };
  assert.equal(planFilterMatch(row, { type: 'bug', owner: '@mara', relation: 'depends-on' }), true);
  assert.equal(planFilterMatch(row, { owner: 'mara/amber-fox' }), true);
  assert.equal(planFilterMatch(row, { owner: 'mar' }), false);
  assert.equal(planFilterMatch(row, { owner: 'none' }), false);
  assert.equal(planFilterMatch({}, { owner: 'none', relation: 'none' }), true);
  assert.equal(planFilterMatch(row, { relation: 'related' }), false);
});

test('one batch call applies each write once, refuses a concurrently changed Item without overwriting it, replays and undoes', async t => {
  const s = await setup(t);
  const initiative = s.item({ kind: 'initiative', title: 'v3 release' });
  await s.send(initiative);
  const items = [s.item({ title: 'One' }), s.item({ title: 'Two' }), s.item({ title: 'Three' })];
  for (const item of items) await s.send(item);
  // Someone else edits Two first: the batch read version 1 and must not overwrite it.
  await s.send(s.item({ itemId: items[1].itemId, expectedVersion: 1, title: 'Two, edited meanwhile' }));
  const writes = items.map(item => ({
    action: 'put-planning-item',
    itemId: item.itemId,
    expectedVersion: 1,
    initiativeId: initiative.itemId,
    owner: '@mara',
  }));
  writes.push({ action: 'comment-planning-item', itemId: items[0].itemId, text: 'Moved with the release' });
  const operationId = id();
  const events = () => s.tables.projectWorkEvents.size;
  const before = events();
  const meter = meterReads(s.ctx);
  const cost = await meter.cost(() =>
    batch.apply._handler(s.ctx, { projectId: s.projectId, operationId, writes: JSON.stringify(writes) }),
  );
  meter.restore();
  const first = JSON.parse(
    await batch.apply._handler(s.ctx, {
      projectId: s.projectId,
      operationId,
      writes: JSON.stringify(writes),
    }),
  );
  assert.equal(events(), before + 3, 'three writes applied once; the replay added nothing');
  assert.deepEqual(
    first.results.map(result => [result.itemId, result.outcome, result.code ?? null]),
    [
      [items[0].itemId, 'replayed', null],
      [items[1].itemId, 'refused', 'ITEM_CHANGED'],
      [items[2].itemId, 'replayed', null],
      [items[0].itemId, 'replayed', null],
    ],
  );
  assert.equal(first.results[1].currentVersion, 2);
  const current = (await s.read()).data.planningItems;
  const latest = itemId => current.filter(item => item.id === itemId).at(-1);
  assert.equal(latest(items[1].itemId).title, 'Two, edited meanwhile');
  assert.equal(latest(items[1].itemId).owner, undefined);
  assert.equal(latest(items[0].itemId).owner, '@mara');
  assert.equal(latest(items[2].itemId).initiativeId, initiative.itemId);
  console.log(JSON.stringify({ planningBatch3: cost }));

  // A fresh batch reports what it touched, so its one Undo puts every field back.
  const second = id();
  const reassign = [items[0], items[2]].map(item => ({
    action: 'put-planning-item',
    itemId: item.itemId,
    expectedVersion: 2,
    owner: null,
    type: 'bug',
  }));
  const applied = JSON.parse(
    await batch.apply._handler(s.ctx, {
      projectId: s.projectId,
      operationId: second,
      writes: JSON.stringify(reassign),
    }),
  );
  assert.deepEqual(applied.results[0].before, { owner: '@mara', type: null });
  const { undo } = batchUndo(reassign, applied.results);
  await batch.apply._handler(s.ctx, {
    projectId: s.projectId,
    operationId: id(),
    writes: JSON.stringify(undo),
  });
  const restored = (await s.read()).data.planningItems;
  const back = restored.filter(item => item.id === items[2].itemId).at(-1);
  assert.equal(back.version, 4);
  assert.equal(back.owner, '@mara');
  assert.equal(back.type, undefined);
});

test('a batch is bounded, owner-gated and refuses a changed request under the same operation id', async t => {
  const s = await setup(t);
  const item = s.item({ title: 'Only' });
  await s.send(item);
  const call = (writes, operationId = id()) =>
    batch.apply._handler(s.ctx, { projectId: s.projectId, operationId, writes: JSON.stringify(writes) });
  const write = { action: 'put-planning-item', itemId: item.itemId, expectedVersion: 1, owner: '@jun' };
  await assert.rejects(call([]), error => error.data.code === 'BAD_ARGUMENT');
  await assert.rejects(
    call(Array.from({ length: planningBatchLimit + 1 }, () => write)),
    error => error.data.code === 'BAD_ARGUMENT',
  );
  await assert.rejects(
    call([{ action: 'intent', itemId: item.itemId }]),
    error => error.data.code === 'BAD_ARGUMENT',
  );
  const operationId = id();
  await call([write], operationId);
  await assert.rejects(
    call([{ ...write, owner: '@someone-else' }], operationId),
    error => error.data.code === 'WORK_OPERATION_CHANGED',
  );
  s.caller('foreign');
  await assert.rejects(
    call([{ ...write, expectedVersion: 2 }]),
    error => error.data.code === 'PROJECT_UNAVAILABLE',
  );
});

test('agents send a batch as one put-planning-item call, get per-Item results and one undo, and filter reads by owner, type and the active scope', async t => {
  const { executeHostedPlanning } = await import('../dist/hosted-agent-planning.js');
  const { hostedContractFeatures } = await import('../dist/hosted-contract-features.js');
  const { join } = await import('node:path');
  const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
  const s = await setup(t);
  const items = [s.item({ title: 'Parser' }), s.item({ title: 'Docs' })];
  for (const item of items) await s.send(item);
  const calls = [];
  const handlers = { projectPlanningBatch: batch, projectWorkIndex: index };
  const invoke = async (name, args) => {
    calls.push(name);
    if (name === 'projectHostedPlanning:intentStates') return '{}';
    if (name === 'projectItemWork:read') return { role: true, intent: null, lanes: [], total: 0 };
    const [module, fn] = name.split(':');
    const value = await handlers[module][fn]._handler(s.ctx, { ...args, projectId: s.projectId });
    return typeof value === 'string' ? JSON.parse(value) : value;
  };
  const port = (serverFeatures = [...hostedContractFeatures]) => ({
    root: join(s.directory, 'checkout'),
    address: { url: 'https://fixture.invalid', projectId: s.projectId },
    exchange: { client: { query: () => assert.fail('no direct query') } },
    query: invoke,
    mutation: invoke,
    serverFeatures,
  });
  const batchInput = {
    batch: [
      { planningItemId: items[0].itemId, expectedVersion: 1, fields: { owner: '@mara', type: 'bug' } },
      { itemId: items[1].itemId, expectedVersion: 1, status: 'closed', reason: 'Shipped' },
    ],
  };
  await assert.rejects(
    executeHostedPlanning(
      port(hostedContractFeatures.filter(name => name !== 'planning-batch')),
      'agent',
      'put-planning-item',
      batchInput,
      randomUUID(),
    ),
    error => error.code === 'HOSTED_ACTION_UNSUPPORTED',
  );
  await assert.rejects(
    executeHostedPlanning(
      port(),
      'agent',
      'put-planning-item',
      { batch: [{ itemId: items[0].itemId.slice(0, 8), expectedVersion: 1 }] },
      randomUUID(),
    ),
    error => error.code === 'BAD_ARGUMENT',
  );
  calls.length = 0;
  const { result } = await executeHostedPlanning(
    port(),
    'agent',
    'put-planning-item',
    batchInput,
    randomUUID(),
  );
  assert.deepEqual(calls, ['projectPlanningBatch:apply'], 'one call for the whole batch');
  assert.deepEqual(
    result.results.map(entry => entry.outcome),
    ['applied', 'applied'],
  );
  assert.equal(result.summary, '2 of 2 changed.');
  assert.deepEqual(result.undo, {
    action: 'put-planning-item',
    input: {
      batch: [
        { itemId: items[0].itemId, expectedVersion: 2, owner: null, type: null },
        // `reason` describes one version and is never carried back.
        { itemId: items[1].itemId, expectedVersion: 2, status: 'open' },
      ],
    },
  });
  const read = async filter =>
    (
      await executeHostedPlanning(port(), 'agent', 'planning', { status: 'all', reconcile: false, ...filter })
    ).result.items.map(item => item.title);
  assert.deepEqual(await read({ owner: 'mara' }), ['Parser']);
  assert.deepEqual(await read({ type: 'bug', owner: '@mara' }), ['Parser']);
  assert.deepEqual(await read({ owner: 'none' }), ['Docs']);
  // "active" is the Plan screen's open scope: proposed, planned and in progress, never closed.
  assert.deepEqual(await read({ status: 'active' }), ['Parser']);
  await assert.rejects(executeHostedPlanning(port(), 'agent', 'planning', { relation: 'blocks' }), error =>
    /relation: depends-on/.test(error.message),
  );
});
