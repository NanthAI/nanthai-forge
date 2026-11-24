// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { batchUndo } from '../dist/planning-batch.js';
import { prepareRollupApproval, previewPlanningRollup } from '../dist/planning-rollup-preview.js';
import { successorIntentId } from '../dist/hosted-intent-chain.js';
import { getFunctionName } from 'convex/server';
import { setup } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const { advance } = await import(moduleUrl('../convex/projectPlanRollup.ts'));
const { move: startMove } = await import(moduleUrl('../convex/projectPlanningStart.ts'));
const { apply } = await import(moduleUrl('../convex/projectPlanningBatch.ts'));
const catchup = await import(moduleUrl('../convex/projectPlanRollupCatchup.ts'));
const preview = await import(moduleUrl('../convex/projectPlanRollupPreview.ts'));
const { workspace } = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const { transition } = await import(moduleUrl('../convex/projectHostedLifecycle.ts'));
const intentRepair = await import(moduleUrl('../convex/projectHostedIntentRepair.ts'));
const { writeHostedRecord } = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const { set: setPolicy } = await import(moduleUrl('../convex/projectAutonomy.ts'));

async function plan(t) {
  const s = await setup(t);
  const tasks = [],
    pages = [];
  const original = s.ctx.scheduler.runAfter.bind(s.ctx.scheduler);
  s.ctx.scheduler.runAfter = async (delay, fn, args) => {
    const name = getFunctionName(fn);
    if (name === 'projectPlanRollup:advance') return `rollup-${tasks.push(args)}`;
    if (name === 'projectPlanRollupCatchup:page') return `catchup-${pages.push(args)}`;
    return original(delay, fn, args);
  };
  const add = async fields => {
    const command = s.item(fields);
    await s.send(command);
    // Birth is fixture setup; each test chooses the work event from which to start observing.
    tasks.length = 0;
    return command.itemId;
  };
  const partition = s.tables.hostedProjects.get(s.projectId).work.generationId;
  const execute = (itemId, extra = {}) =>
    advance._handler(s.ctx, {
      projectId: s.projectId,
      itemId,
      partition,
      cause: randomUUID(),
      source: 'landing',
      ...extra,
    });
  const drain = async () => {
    for (let i = 0; tasks.length && i < 50; i++) await advance._handler(s.ctx, tasks.shift());
    assert.deepEqual(tasks, [], 'no unbounded continuation');
  };
  const read = async id => (await s.read()).data.planningItems.findLast(item => item.id === id);
  const set = (itemId, fields) =>
    s.send({ action: 'put-planning-item', itemId, expectedVersion: 1, operationId: randomUUID(), ...fields });
  const work = async (itemId, status, laneStatus = status === 'active' ? 'active' : null) => {
    const intent = await s.ctx.db.insert('projectHostedRecordHeads', {
      projectId: s.projectId,
      kind: 'intent',
      key: itemId,
      status,
      version: 1,
      parent: '',
      recordId: 'synthetic-work-pointer',
    });
    const lane =
      laneStatus &&
      (await s.ctx.db.insert('projectHostedRecordHeads', {
        projectId: s.projectId,
        kind: 'lane',
        key: randomUUID(),
        status: laneStatus,
        version: 1,
        parent: itemId,
        recordId: 'synthetic-lane-pointer',
      }));
    return { intent, lane };
  };
  const toggle = (rollUpPlanningStatus, operationId = randomUUID()) =>
    setPolicy._handler(s.ctx, {
      projectId: s.projectId,
      command: JSON.stringify({ action: 'set-policy', operationId, rollUpPlanningStatus }),
    });
  const progress = async () => JSON.parse(await catchup.status._handler(s.ctx, { partition }));
  return { ...s, add, execute, drain, read, set, work, tasks, pages, toggle, progress };
}

test('a completed leaf writes ordinary retained Versions through the parent and Initiative', async t => {
  const s = await plan(t);
  const group = await s.add({ kind: 'initiative', status: 'in-progress' });
  const parent = await s.add({ initiativeId: group, status: 'in-progress' });
  const leaf = await s.add({ parentId: parent, initiativeId: group, status: 'in-progress' });
  await s.work(leaf, 'completed');
  assert.equal(await s.execute(leaf), 'moved');
  assert.equal((await s.read(parent)).status, 'in-progress', 'the first step cannot write a parent');
  await s.drain();
  assert.deepEqual(
    await Promise.all(
      [leaf, parent, group].map(async id => {
        const row = await s.read(id);
        return [row.status, row.reason, row.version, row.statusPin, row.statusSource];
      }),
    ),
    [
      ['closed', 'Done: linked work finished', 2, undefined, 'work'],
      ['closed', 'Done: last child settled', 2, undefined, 'work'],
      ['closed', 'Done: last Item settled', 2, undefined, 'work'],
    ],
  );
  assert.equal(await s.execute(leaf), 'unchanged');
  assert.deepEqual(s.tasks, []);
});

test('a manual status pin survives completion; only the signed-in writer can attribute a pin', async t => {
  const s = await plan(t);
  const leaf = await s.add({ status: 'in-progress' });
  await assert.rejects(s.set(leaf, { status: 'open', statusPinBy: '@someone' }), /Pin attribution/);
  await assert.rejects(s.set(leaf, { status: 'open', statusSource: 'work' }), /Only Forge attributes/);
  const event = await s.set(leaf, { status: 'open' });
  assert.equal(event.revision > 0, true);
  const pinned = await s.read(leaf);
  assert(pinned.statusPin);
  await s.work(leaf, 'completed');
  assert.equal(await s.execute(leaf), 'unchanged');
  assert.deepEqual((await s.read(leaf)).statusPin, pinned.statusPin);
  await s.set(leaf, { expectedVersion: pinned.version, statusPin: null });
  assert.equal((await s.read(leaf)).statusPin, undefined);
  await s.drain();
  assert.equal((await s.read(leaf)).status, 'closed', 'Follow work reevaluates a settled Intent');
});

test('batch Undo restores both the original pin attribution and a previously missing pin', async t => {
  const s = await plan(t);
  const unpinned = await s.add({ status: 'open' });
  const pinned = await s.add({ status: 'in-progress' });
  await s.set(pinned, { status: 'open' });
  const previous = await s.read(pinned);
  const batch = async writes =>
    JSON.parse(
      await apply._handler(s.ctx, {
        projectId: s.projectId,
        operationId: randomUUID(),
        writes: JSON.stringify(writes),
      }),
    );
  const writes = [unpinned, pinned].map((itemId, i) => ({
    action: 'put-planning-item',
    itemId,
    expectedVersion: i + 1,
    status: 'abandoned',
  }));
  const changes = await batch(writes);
  const { undo } = batchUndo(writes, changes.results);
  assert.equal(undo.length, 2);
  const wrong = await batch([{ ...undo[1], itemId: unpinned, expectedVersion: 2 }]);
  assert.equal(wrong.results[0].outcome, 'refused');
  const restored = await batch(undo);
  assert.deepEqual(
    restored.results.map(row => row.outcome),
    ['applied', 'applied'],
  );
  assert.deepEqual(
    await Promise.all(
      [unpinned, pinned].map(async id => {
        const row = await s.read(id);
        return [row.status, row.statusPin];
      }),
    ),
    [
      ['open', undefined],
      ['open', previous.statusPin],
    ],
  );
});

test('an old reconciling client cannot close an Item or pin its status ahead of the worker', async t => {
  const s = await plan(t);
  const itemId = await s.add({ status: 'in-progress' });
  await s.add({ status: 'open', parentId: itemId });
  await s.work(itemId, 'completed');
  const legacy = (version, suffix) => {
    const h = createHash('sha256').update(`${itemId}:${version}:${suffix}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  for (const [status, suffix] of [
    ['closed', 'closed'],
    ['abandoned', 'abandoned'],
    ['in-progress', 'held'],
  ]) {
    await assert.rejects(
      s.set(itemId, { status, operationId: legacy(1, suffix) }),
      /planning reads no longer move/,
    );
  }
  await assert.rejects(
    s.send({
      action: 'comment-planning-item',
      operationId: legacy(0, 'held-comment'),
      itemId,
      authorLabel: '',
      text: `Intent completed; 1 Done-when line(s) still open, so this Issue stays open. Open: "Finish". Tick each line with its evidence: nforge agent . tick-planning-item '{"planningItemId":"${itemId}","line":1,"evidence":"…"}' (line: the checkbox's position or a unique text prefix); the last tick closes the Issue.`,
    }),
    /planning reads no longer move/,
  );
  assert.equal(await s.execute(itemId), 'unchanged');
  assert.equal((await s.read(itemId)).version, 1);

  const oldStart = await s.add({ status: 'open' });
  await s.set(oldStart, { status: 'in-progress' });
  assert.ok((await s.read(oldStart)).statusPin, 'an indistinguishable old start is a manual status edit');
});

test('ongoing Work on a landing schedules nothing, and a repeated target stops before reading the Plan', async t => {
  const s = await plan(t);
  const parent = await s.add({ status: 'open' });
  const leaf = await s.add({ parentId: parent, status: 'in-progress' });
  await s.work(leaf, 'active');
  const before = s.reads();
  assert.equal(await s.execute(leaf), 'unchanged');
  const reads = s.reads() - before;
  assert.deepEqual(s.tasks, []);
  const unrelated = await s.add({ status: 'in-progress' });
  await s.work(unrelated, 'active');
  const start = s.reads();
  assert.equal(await s.execute(unrelated), 'unchanged');
  assert.equal(s.reads() - start, reads, 'a landing with no due status work adds no ancestor lookup');
  const repeated = s.reads();
  assert.equal(await s.execute(parent, { path: [parent] }), 'repeated');
  assert.equal(s.reads(), repeated);
});

test('an owner start passes active work through a Proposed Item without approving it', async t => {
  const s = await plan(t);
  const parent = await s.add({ status: 'open' });
  const child = await s.add({ status: 'proposed', parentId: parent });
  await s.work(child, 'active');
  await startMove._handler(s.ctx, {
    projectId: s.projectId,
    owner: 'owner',
    actor: 'owner',
    itemId: child,
    startOperationId: randomUUID(),
  });
  await s.drain();
  assert.equal((await s.read(child)).status, 'proposed');
  assert.equal((await s.read(parent)).status, 'in-progress');
});

test('a top-level Proposed Item forwards real Work to its Initiative without moving itself', async t => {
  const s = await plan(t);
  const initiativeId = await s.add({ kind: 'initiative', status: 'open' });
  const itemId = await s.add({ status: 'proposed', initiativeId });
  await s.work(itemId, 'active');
  assert.equal(await s.execute(itemId, { source: 'start' }), 'unchanged');
  await s.drain();
  assert.equal((await s.read(itemId)).status, 'proposed');
  assert.equal((await s.read(initiativeId)).status, 'in-progress');
});

test('moving active work rechecks both parents and their distinct Initiatives', async t => {
  const s = await plan(t);
  const oldGroup = await s.add({ kind: 'initiative', status: 'in-progress' });
  const newGroup = await s.add({ kind: 'initiative', status: 'open' });
  const oldParent = await s.add({ status: 'in-progress', initiativeId: oldGroup });
  const newParent = await s.add({ status: 'open', initiativeId: newGroup });
  await s.add({ status: 'closed', parentId: oldParent, initiativeId: oldGroup });
  const leaf = await s.add({ status: 'in-progress', parentId: oldParent, initiativeId: oldGroup });
  await s.work(leaf, 'active');
  await s.set(leaf, { parentId: newParent, initiativeId: newGroup });
  assert.equal(s.tasks.length, 1);
  await s.drain();
  assert.deepEqual(
    await Promise.all([oldParent, oldGroup, newParent, newGroup].map(async id => (await s.read(id)).status)),
    ['closed', 'closed', 'in-progress', 'in-progress'],
  );
});

test('setting off keeps ordinary own completion; re-enabling catches up children, then parents, then Initiatives', async t => {
  const s = await plan(t);
  const group = await s.add({ kind: 'initiative', status: 'in-progress' });
  const parent = await s.add({ status: 'in-progress', initiativeId: group });
  const child = await s.add({ status: 'in-progress', parentId: parent, initiativeId: group });
  await s.toggle(false);
  await s.work(child, 'completed');
  await s.execute(child);
  assert.equal((await s.read(child)).status, 'closed');
  assert.equal((await s.read(parent)).status, 'in-progress');
  assert.equal(s.tasks.length + s.pages.length, 0);
  for (let i = 0; i < 48; i++) await s.add({ status: 'proposed' });
  const operationId = randomUUID();
  await s.toggle(true, operationId);
  await s.toggle(true, operationId);
  assert.equal(s.pages.length, 1);
  const first = s.pages[0];
  let runs = 0;
  while (s.pages.length && runs++ < 8) {
    assert.equal(s.pages.length, 1, 'one bounded successor, not one wake per Item');
    await catchup.page._handler(s.ctx, s.pages.shift());
  }
  assert.equal(runs, 6, 'one pass per level, two bounded root pages per pass');
  await catchup.page._handler(s.ctx, first);
  assert.equal(s.pages.length + s.tasks.length, 0);
  assert.equal((await s.progress()).state, 'complete');
  assert.equal((await s.progress()).moved, 2);
  assert.equal((await s.read(parent)).status, 'closed');
  assert.equal((await s.read(group)).status, 'closed');
});

test('re-enable catch-up finishes across a live Plan write and respects the newer pin', async t => {
  const s = await plan(t);
  const itemId = await s.add({ status: 'open' });
  await s.toggle(false);
  await s.toggle(true);
  await s.set(itemId, { status: 'in-progress' });
  const pinned = await s.read(itemId);
  assert(pinned.statusPin);
  await catchup.page._handler(s.ctx, s.pages.shift());
  assert.equal((await s.progress()).state, 'running');
  for (let i = 0; i < 3 && s.pages.length; i++) await catchup.page._handler(s.ctx, s.pages.shift());
  assert.equal(s.pages.length, 0);
  assert.equal((await s.progress()).state, 'complete');
  assert.deepEqual(await s.read(itemId), pinned);
});

test('a regular planning workspace read reports a catch-up blocked by unavailable tallies', async t => {
  const s = await plan(t);
  await s.toggle(false);
  await s.toggle(true);
  const header = [...s.tables.projectWorkDataRecords.values()].find(
    row => JSON.parse(row.value).scopeThrough === null,
  );
  await s.ctx.db.patch(header._id, {
    value: JSON.stringify({ ...JSON.parse(header.value), scopeBlocked: true }),
  });
  await catchup.page._handler(s.ctx, s.pages.shift());
  const reply = JSON.parse(await workspace._handler(s.ctx, { projectId: s.projectId, planningRollup: true }));
  assert.deepEqual(reply.rollupCatchup, { state: 'partial', moved: 0, reason: 'scope-tallies-unavailable' });
});

async function devApproval(t, s) {
  const prior = process.env.CONVEX_CLOUD_URL;
  process.env.CONVEX_CLOUD_URL = preview.approvedDevRollup;
  t.after(() => {
    if (prior === undefined) delete process.env.CONVEX_CLOUD_URL;
    else process.env.CONVEX_CLOUD_URL = prior;
  });
  const dry = await preview.page._handler(s.ctx, { projectId: s.projectId, after: '' });
  const { expected, moves, report } = prepareRollupApproval([dry]);
  const operationId = randomUUID();
  const partition = await catchup.applyApproved._handler(s.ctx, {
    projectId: s.projectId,
    operationId,
    expected,
    moves,
  });
  return {
    report,
    step: step => catchup.page._handler(s.ctx, { projectId: s.projectId, operationId, partition, step }),
  };
}

test('approved dev apply stops on a changed Plan revision even inside the same partition', async t => {
  const s = await plan(t);
  const itemId = await s.add({ status: 'open' });
  await s.work(itemId, 'active');
  const { step } = await devApproval(t, s);
  await step(0);
  await s.set(itemId, { status: 'in-progress' });
  const pinned = await s.read(itemId);
  await step(1);
  assert.equal((await s.progress()).reason, 'plan-changed');
  assert.deepEqual(await s.read(itemId), pinned);
});

test('dev apply refuses a changed open Lane version even if the approved decision would be unchanged', async t => {
  const s = await plan(t);
  const itemId = await s.add({ status: 'open' });
  const { lane } = await s.work(itemId, 'active');
  const { report, step } = await devApproval(t, s);
  assert.equal(report.wouldChange, 1);
  await s.ctx.db.patch(lane, { version: 2 });
  await step(0);
  await step(1);
  assert.equal((await s.progress()).reason, 'approved-move-changed');
  assert.equal((await s.read(itemId)).status, 'open');
  assert.equal(s.pages.length, 0);
});

test('a stale active Intent with only a terminal Lane cannot start the Item or its Initiative', async t => {
  const s = await plan(t);
  const initiativeId = await s.add({ kind: 'initiative', status: 'open' });
  for (const lane of ['completed', 'abandoned']) {
    const itemId = await s.add({
      status: 'open',
      initiativeId,
      body: '## Done when\n- [x] Past effort recorded',
    });
    await s.work(itemId, 'active', lane);
    assert.equal(await s.execute(itemId, { source: 'plan' }), 'unchanged');
    await s.drain();
    assert.equal((await s.read(itemId)).status, 'open');
  }
  assert.equal((await s.read(initiativeId)).status, 'open');
});

async function lifecycleFixture(s, itemId, { intentId = itemId, at = '2026-01-01T00:00:00.000Z' } = {}) {
  const authorityEpoch = 1;
  const project = s.tables.hostedProjects.get(s.projectId);
  Object.assign(project, { sourceAuthority: { mode: 'server', epoch: authorityEpoch } });
  const laneId = randomUUID();
  const base = { head: 'a'.repeat(64), receiptId: randomUUID() };
  const auth = {
    projectId: s.projectId,
    actor: 'owner',
    authorityEpoch,
    expectedVersion: null,
    planningItemId: itemId,
  };
  await writeHostedRecord(s.ctx, {
    ...auth,
    record: {
      kind: 'intent',
      id: intentId,
      version: 0,
      at,
      outcome: 'Synthetic Work',
      constraints: '',
      creatorAccountId: 'owner',
      assigneeAccountIds: [],
      base,
      status: 'active',
    },
  });
  await writeHostedRecord(s.ctx, {
    ...auth,
    record: {
      kind: 'lane',
      id: laneId,
      version: 0,
      at,
      intentId,
      actor: 'owner',
      base,
      head: base.head,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: 'active',
      authorityEpoch,
    },
  });
  const overlap = [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === laneId);
  const stampLanded = async () => {
    const current = await s.ctx.db.get(overlap._id);
    if (current.planLaneMark) {
      const { removePlanLanes } = await import(moduleUrl('../convex/projectPlanLaneMarks.ts'));
      await removePlanLanes(s.ctx, current.planLaneMark, [current.lifecyclePlanId]);
    }
    await s.ctx.db.patch(overlap._id, {
      open: false,
      planLaneMark: undefined,
      planLanePin: undefined,
      landed: { receiptId: randomUUID(), commit: base.head, laneHead: base.head, at },
    });
  };
  const changeLane = async (action, version) => {
    const request = JSON.stringify({
      operationId: randomUUID(),
      action,
      reason: action === 'abandon' ? 'Discarded synthetic work' : '',
      authorityEpoch,
      target: {
        kind: 'lane',
        laneId,
        expected: { version, head: base.head, sourceVersion: 0, lifecycleVersion: version },
      },
    });
    assert.equal(
      JSON.parse(await transition._handler(s.ctx, { projectId: s.projectId, request })).status,
      'applied',
    );
    assert.equal(s.tasks.length, 1);
    await s.drain();
  };
  return { stampLanded, changeLane, laneId };
}

test('only the linked Item reopens on an explicit Lane reopen, not its settled parent', async t => {
  const s = await plan(t);
  const parentId = await s.add({ status: 'in-progress' });
  const itemId = await s.add({ status: 'in-progress', parentId });
  const { stampLanded, changeLane } = await lifecycleFixture(s, itemId);
  await stampLanded();
  await changeLane('complete', 0);
  assert.deepEqual([(await s.read(itemId)).status, (await s.read(parentId)).status], ['closed', 'closed']);
  await changeLane('reopen', 1);
  assert.deepEqual(
    [(await s.read(itemId)).status, (await s.read(parentId)).status],
    ['in-progress', 'closed'],
  );
});

test('abandoning the last open Lane retires the Intent and leaves its Item In progress', async t => {
  const s = await plan(t);
  const itemId = await s.add({ status: 'in-progress' });
  const { changeLane } = await lifecycleFixture(s, itemId);
  await changeLane('abandon', 0);
  const intent = [...s.tables.projectHostedRecordHeads.values()].find(
    row => row.kind === 'intent' && row.key === itemId,
  );
  assert.equal(intent.status, 'abandoned');
  assert.equal((await s.read(itemId)).status, 'in-progress');
});

test('the version-fenced stale Intent repair updates canonical Work, not Plan, and refuses a reopened Lane', async t => {
  const s = await plan(t);
  const settled = await s.add({ status: 'open' });
  const moved = await lifecycleFixture(s, settled);
  await moved.stampLanded();
  const inputs = { projectId: s.projectId, intentIds: [settled] };
  const expected = await intentRepair.preview._handler(s.ctx, inputs);
  assert.deepEqual(
    expected.map(({ id, version, status }) => ({ id, version, status })),
    [{ id: settled, version: 0, status: 'completed' }],
  );
  assert.equal((await s.read(settled)).status, 'open');
  const approved = { projectId: s.projectId, expected };
  await intentRepair.apply._handler(s.ctx, approved);
  await intentRepair.apply._handler(s.ctx, approved);
  assert.deepEqual(await intentRepair.preview._handler(s.ctx, inputs), []);
  const head = id =>
    [...s.tables.projectHostedRecordHeads.values()].find(row => row.kind === 'intent' && row.key === id);
  assert.equal(head(settled).version, 1);
  assert.equal(head(settled).status, 'completed');
  assert.equal((await s.read(settled)).status, 'open');

  const changing = await s.add({ status: 'open' });
  const changed = await lifecycleFixture(s, changing);
  await changed.stampLanded();
  const pending = { ...inputs, intentIds: [changing] };
  const stale = await intentRepair.preview._handler(s.ctx, pending);
  assert.equal(stale.length, 1);
  await changed.stampLanded();
  await assert.rejects(intentRepair.apply._handler(s.ctx, { ...approved, expected: stale }), {
    code: 'WORK_STALE',
  });
  const fresh = await intentRepair.preview._handler(s.ctx, pending);
  await changed.changeLane('reopen', 0);
  await assert.rejects(intentRepair.apply._handler(s.ctx, { ...approved, expected: fresh }), {
    code: 'WORK_STALE',
  });
  assert.equal(head(changing).status, 'active');
});

for (const mode of ['legacy', 'verified'])
  test(`1018d0f8 v58 ${mode} replay: a budget-break reopen beats repaired old Work even with all lines ticked`, async t => {
    const s = await plan(t);
    t.mock.property(process, 'env', { ...process.env, CONVEX_CLOUD_URL: preview.approvedDevRollup });
    const id = await s.add({
      status: 'open',
      body: '## Done when\n- [x] Regression measured\n- [x] Replay checked\n- [x] Reported\n- [x] Landed\n- [x] Budget checked',
    });
    const partition = s.tables.hostedProjects.get(s.projectId).work.generationId;
    if (mode === 'verified')
      await s.ctx.db.patch(s.projectId, {
        itemLaneMembership: 'verified-v2',
        planLaneMarkCoverage: { generationId: partition, cursor: null },
      });
    const { workRecordTable } = await import(moduleUrl('../convex/projectWorkRecordTables.ts'));
    const rootTable = await workRecordTable(s.ctx, partition, 'planningItems');
    const versionsTable = await workRecordTable(s.ctx, partition, 'planningVersions');
    const root = [...s.tables[rootTable].values()].find(
      r => r.collection === 'planningItems' && r.key === id,
    );
    assert.ok(root);
    const original = JSON.parse(root.value);
    const v57 = {
      ...original,
      version: 57,
      previousVersion: 56,
      status: 'closed',
      at: '2026-11-24T16:33:32.291Z',
    };
    const v58 = {
      ...original,
      version: 58,
      previousVersion: 57,
      status: 'open',
      reason: 'Speed budget broken',
      at: '2026-11-24T16:46:46.734Z',
    };
    await s.ctx.db.patch(root._id, { value: JSON.stringify(v58) });
    for (const item of [v57, v58])
      await s.ctx.db.insert(versionsTable, {
        generationId: root.generationId,
        projectId: s.projectId,
        collection: 'planningVersions',
        key: randomUUID(),
        parent: id,
        position: item.version,
        value: JSON.stringify(item),
      });
    const { stampLanded } = await lifecycleFixture(s, id);
    await stampLanded();
    const batch = { projectId: s.projectId, intentIds: [id] };
    const repaired = await intentRepair.preview._handler(s.ctx, batch);
    assert.equal(repaired[0].status, 'completed');
    await intentRepair.apply._handler(s.ctx, { projectId: s.projectId, expected: repaired });
    const inspectLeaf = () => preview.page._handler(s.ctx, { projectId: s.projectId, after: '', itemId: id });
    const output = await inspectLeaf();
    assert.deepEqual(
      output.rows.map(r => [r.id, r.work, r.completionHeld]),
      [[id, 'completed', true]],
    );
    assert.deepEqual(previewPlanningRollup(output.rows).changes, []);
    assert.throws(() => prepareRollupApproval([output]), /missing, repeated, or stale page/);
    assert.equal(await s.execute(id, { source: 'plan' }), 'unchanged');

    const later = successorIntentId(id);
    const next = await lifecycleFixture(s, id, { intentId: later, at: '2026-11-25T12:00:00.000Z' });
    await next.stampLanded();
    const proof = await intentRepair.preview._handler(s.ctx, { ...batch, intentIds: [later] });
    await intentRepair.apply._handler(s.ctx, { projectId: s.projectId, expected: proof });
    const after = await inspectLeaf();
    assert.deepEqual(
      previewPlanningRollup(after.rows).changes.map(r => [r.id, r.status, r.rule]),
      [[id, 'closed', 'ownWorkDone']],
    );
  });

test('abandoned linked work does not abandon an Item when a later Plan write checks it', async t => {
  const s = await plan(t);
  const itemId = await s.add({ status: 'in-progress' });
  await s.work(itemId, 'abandoned');
  assert.equal(await s.execute(itemId, { source: 'plan' }), 'unchanged');
  assert.equal((await s.read(itemId)).status, 'in-progress');
});

test('a roll-up that finds an invalid parent tally blocks further use of the counts', async t => {
  const s = await plan(t);
  const parentId = await s.add({ status: 'open' });
  const itemId = await s.add({ status: 'closed', parentId });
  await s.work(itemId, 'active');
  const rows = s.tables.projectWorkDataRecords;
  const parent = [...rows.values()].find(row => row.key === `parent:${parentId}`);
  assert.ok(parent);
  await s.ctx.db.patch(parent._id, {
    value: JSON.stringify({
      ...JSON.parse(parent.value),
      effective: { total: 0, unsettled: 0, progress: 0, started: 0, done: 0 },
    }),
  });
  assert.equal(await s.execute(itemId, { source: 'start' }), 'blocked');
  const counts = [...rows.values()].find(row => JSON.parse(row.value).scopeThrough === null);
  assert.ok(JSON.parse(counts.value).scopeBlocked);
  assert.equal((await s.read(parentId)).status, 'open');
  assert.deepEqual(s.tasks, []);
});

test('the last checkbox wakes a completed Item once even if the write is retried', async t => {
  const s = await plan(t);
  const itemId = await s.add({ status: 'in-progress', body: '## Done when\n- [ ] Signal tested' });
  await s.work(itemId, 'completed');
  assert.equal(await s.execute(itemId), 'unchanged');
  const command = {
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId,
    expectedVersion: 1,
    body: '## Done when\n- [x] Signal tested',
  };
  await s.send(command);
  await s.send(command);
  assert.equal(s.tasks.length, 1);
  await s.drain();
  assert.deepEqual([(await s.read(itemId)).status, (await s.read(itemId)).version], ['closed', 3]);
});
