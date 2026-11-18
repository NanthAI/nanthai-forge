// SPDX-License-Identifier: Apache-2.0
// Backlog batches (Item 65b0e706, docs/planning.md "Batches"): one action on many Items is one retry-safe call with
// per-Item results and one Undo; split and merge are batches too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import { setup } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { meterReads } from './hosted-read-set.mjs';

const batch = await import(moduleUrl('../convex/projectPlanningBatch.ts'));
const id = () => randomUUID();

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
