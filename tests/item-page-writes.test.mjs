// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { setup } from './hosted-planning-fixture.mjs';
import { establishedAccount } from './account-tier-fixture.mjs';
import { meterWorkIO } from './hosted-read-set.mjs';
import { doneWhenCounts } from '../dist/planning-search.js';
import { isPlanningTick, planningLineEvidence } from '../dist/planning-line-evidence.js';
import { tickBodyLine } from '../dist/hosted-agent-planning-tick.js';

const { apply } = await import(moduleUrl('../convex/projectPlanningBatch.ts'));
const { command } = await import(moduleUrl('../convex/projectWorkCommand.ts'));
const { read: plan } = await import(moduleUrl('../convex/projectPlanView.ts'));
const { records, detail } = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const { setMode } = await import(moduleUrl('../convex/projectWorkStore.ts'));
const unavailable = error => error.data.code === 'PROJECT_UNAVAILABLE';

async function project(t) {
  const s = await setup(t);
  establishedAccount(s.tables, 'writer', ['contributed']);
  s.tables.projectContributors.set('writer-row', {
    _id: 'writer-row',
    projectId: s.projectId,
    contributor: 'writer',
  });
  s.tables.projectReaders.set('reader-row', { _id: 'reader-row', projectId: s.projectId, reader: 'reader' });
  const send = input =>
    s.transaction(() =>
      command._handler(s.ctx, {
        projectId: s.projectId,
        operationId: input.operationId,
        command: JSON.stringify(input),
      }),
    );
  const batch = (writes, operationId = randomUUID()) =>
    s
      .transaction(() =>
        apply._handler(s.ctx, { projectId: s.projectId, operationId, writes: JSON.stringify(writes) }),
      )
      .then(JSON.parse);
  const read = async itemId => (await s.read()).data.planningItems.filter(item => item.id === itemId).at(-1);
  const capture = (itemId = randomUUID()) => ({
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId,
    expectedVersion: 0,
    kind: 'issue',
    title: 'Synthetic checklist',
    body: 'A description.\n\nDone when:\n- [~] Another Item owns this\n- [ ] Read the specimen',
    status: 'open',
  });
  return { ...s, send, batch, latest: read, capture };
}
const tick = (itemId, body, expectedVersion) => [
  { action: 'put-planning-item', itemId, expectedVersion, body: body.replace('[ ] Read', '[x] Read') },
  {
    action: 'comment-planning-item',
    itemId,
    text: 'Verified the specimen; landing 1234abcd.',
    decision: true,
    line: planningLineEvidence(2, 'Read the specimen'),
  },
];

const itemEdits = [
  body => body.replace('A description.', 'Edited **description**.'),
  body => `${body}\n- [ ] Temporary line`,
  body => body.replace('Temporary line', 'Reworded line'),
  body => body.replace('[ ] Reworded', '[~] Reworded'),
  body => body.replace('[~] Reworded', '[ ] Reworded'),
  body => body.replace('\n- [ ] Reworded line', ''),
];

for (const role of ['owner', 'writer'])
  test(`${role} can capture, edit text, add and edit lines, move, reopen, remove and atomically tick`, async t => {
    const s = await project(t);
    s.caller(role);
    if (role === 'writer')
      assert.equal((await plan._handler(s.ctx, { projectId: s.projectId })).canWriteItems, true);
    const capture = s.capture();
    await s.send(capture);
    const { itemId } = capture;
    let body = capture.body;
    let version = 1;
    for (const edit of itemEdits) {
      body = edit(body);
      const { results } = await s.batch([
        { action: 'put-planning-item', itemId, body, expectedVersion: version++ },
      ]);
      assert.equal(results[0].outcome, 'applied');
    }
    const writes = tick(itemId, body, version);
    const operationId = randomUUID();
    assert.deepEqual(
      (await s.batch(writes, operationId)).results.map(row => row.outcome),
      ['applied', 'applied'],
    );
    assert.deepEqual(
      (await s.batch(writes, operationId)).results.map(row => row.outcome),
      ['replayed', 'replayed'],
    );
    s.caller('owner');
    const after = await s.latest(itemId);
    assert.equal(after.version, version + 2);
    assert.match(after.body, /^Edited \*\*description\*\*\.[\s\S]+- \[x\] Read the specimen\n/);
    assert.match(after.body, /## Decisions\n.*Verified the specimen/);
    const page = await records._handler(s.ctx, {
      projectId: s.projectId,
      collection: 'planningComments',
      parentId: itemId,
      paginationOpts: { cursor: null, numItems: 20 },
    });
    const [comment] = page.page.map(row => JSON.parse(row.value));
    assert.deepEqual(comment.line, writes[1].line);
    assert.equal(page.page.length, 1, 'retry neither posts nor ticks twice');
  });

test('a reader and a non-member of even a public project cannot capture, edit or tick; revocation applies to the next request', async t => {
  const s = await project(t);
  const item = s.capture();
  await s.send(item);
  s.tables.hostedProjects.set(s.projectId, {
    ...s.tables.hostedProjects.get(s.projectId),
    visibility: 'public',
  });
  const writes = tick(item.itemId, item.body, 1);
  for (const caller of ['reader', 'stranger', 'writer']) {
    if (caller === 'writer') s.tables.projectContributors.delete('writer-row');
    s.caller(caller);
    if (caller === 'reader')
      assert.equal((await plan._handler(s.ctx, { projectId: s.projectId })).canWriteItems, undefined);
    await assert.rejects(s.send(s.capture()), unavailable);
    let body = item.body;
    for (const edit of itemEdits) {
      body = edit(body);
      await assert.rejects(s.batch([{ ...writes[0], body }]), unavailable);
    }
    await assert.rejects(s.batch(writes), unavailable);
  }
  s.caller('owner');
  assert.equal((await s.latest(item.itemId)).version, 1);
  assert.deepEqual((await s.read()).data.planningComments, []);
});

test('writers cannot shelf work, change Initiative text or post unpaired evidence; stale or mismatched ticks leave no comment', async t => {
  const s = await project(t);
  const item = s.capture();
  const initiative = s.item({ kind: 'initiative' });
  const archived = s.capture();
  const other = s.capture();
  for (const record of [item, initiative, archived, other]) await s.send(record);
  await s.batch([
    { action: 'put-planning-item', itemId: archived.itemId, expectedVersion: 1, status: 'archived' },
  ]);
  s.caller('writer');
  const writes = tick(item.itemId, item.body, 1);
  for (const rejected of [
    { ...writes[0], status: 'deleted' },
    { ...writes[0], title: 'Protected title' },
    { ...writes[0], itemId: archived.itemId },
  ])
    await assert.rejects(s.batch([rejected]), unavailable);
  await assert.rejects(
    s.batch([writes[0], { ...writes[1], itemId: other.itemId }]),
    error => error.data.code === 'BAD_ARGUMENT',
  );
  await assert.rejects(s.batch([{ ...writes[0], itemId: initiative.itemId }]), unavailable);
  await assert.rejects(s.send({ ...writes[1], operationId: randomUUID() }), unavailable);
  await assert.rejects(
    s.batch([{ ...writes[0], expectedVersion: 9 }, writes[1]]),
    error => error.data.code === 'ITEM_CHANGED',
  );
  await assert.rejects(
    s.batch([writes[0], { ...writes[1], line: planningLineEvidence(1, 'Another Item owns this') }]),
    error => error.data.code === 'BAD_ARGUMENT',
  );
  s.caller('owner');
  const after = await s.latest(item.itemId);
  assert.equal(after.version, 1);
  assert.equal(after.body, item.body);
  assert.deepEqual((await s.read()).data.planningComments, []);
});

test('only writers can create Initiatives or edit Item hierarchy; Initiative settings remain owner-only', async t => {
  const s = await project(t);
  const origin = { ...s.capture(), kind: 'initiative', title: 'Origin release' };
  const target = { ...s.capture(), kind: 'initiative', title: 'Next release' };
  const parent = { ...s.capture(), initiativeId: target.itemId };
  const child = { ...s.capture(), initiativeId: origin.itemId };
  const put = (itemId, expectedVersion, fields) => ({
    action: 'put-planning-item',
    itemId,
    expectedVersion,
    ...fields,
  });
  const move = put(child.itemId, 1, { parentId: parent.itemId, initiativeId: target.itemId, order: 'a' });
  await s.send(origin);
  await s.send(child);
  s.caller('reader');
  await assert.rejects(s.send(target), unavailable);
  await assert.rejects(
    s.send({ ...s.capture(), parentId: child.itemId, initiativeId: origin.itemId }),
    unavailable,
  );
  for (const mutation of [
    move,
    put(child.itemId, 1, { parentId: null }),
    put(child.itemId, 1, { order: 'a' }),
    put(child.itemId, 1, { relations: [{ kind: 'related', id: parent.itemId }] }),
  ])
    await assert.rejects(s.batch([mutation]), unavailable);

  s.caller('writer');
  await s.send(target);
  await s.send(parent);
  for (const fields of [
    { body: 'Rewrite' },
    { status: 'archived' },
    { status: 'deleted' },
    { hidden: true },
    { order: 'a' },
    { relations: [] },
  ])
    await assert.rejects(s.batch([put(target.itemId, 1, fields)]), unavailable);
  await assert.rejects(s.batch([put(child.itemId, 1, { initiativeId: target.itemId })]), unavailable);
  const mismatch = await s.batch([{ ...move, initiativeId: origin.itemId }]);
  assert.equal(mismatch.results[0].code, 'BAD_ARGUMENT');
  const operationId = randomUUID();
  assert.equal((await s.batch([move], operationId)).results[0].outcome, 'applied');
  assert.equal((await s.batch([move], operationId)).results[0].outcome, 'replayed');
  assert.equal(
    (await s.batch([put(child.itemId, 2, { relations: [{ kind: 'related', id: parent.itemId }] })]))
      .results[0].outcome,
    'applied',
  );
  s.caller('owner');
  const latest = await s.latest(child.itemId);
  assert.equal(latest.parentId, parent.itemId);
  assert.equal(latest.initiativeId, target.itemId);
  assert.deepEqual(latest.relations, [{ kind: 'related', id: parent.itemId }]);
  const notes = (await s.read()).data.planningComments;
  assert.deepEqual(
    notes.map(note => [note.itemId, note.text.split(':')[0]]),
    [
      [origin.itemId, 'Moved out to Next release'],
      [target.itemId, 'Moved in'],
    ],
  );
});

test('a writer can undo their fresh child, not abandon another author’s child', async t => {
  const s = await project(t);
  const parent = s.capture();
  await s.send(parent);
  const other = { ...s.capture(), parentId: parent.itemId };
  await s.send(other);
  s.caller('writer');
  const child = { ...s.capture(), parentId: parent.itemId };
  assert.equal((await s.batch([child])).results[0].outcome, 'applied');
  const undo = itemId => [
    { action: 'put-planning-item', itemId, expectedVersion: 1, status: 'abandoned', reason: 'Undone' },
  ];
  await assert.rejects(s.batch(undo(other.itemId)), unavailable);
  assert.equal((await s.batch(undo(child.itemId))).results[0].outcome, 'applied');
  s.caller('owner');
  assert.equal((await s.latest(child.itemId)).status, 'abandoned');
  assert.equal((await s.latest(other.itemId)).status, 'open');
});

test('a writer can undo a cross-Initiative move even when the previous Item snapshot is chunked', async t => {
  const s = await project(t);
  const origin = { ...s.capture(), kind: 'initiative' };
  const next = { ...s.capture(), kind: 'initiative' };
  const parent = { ...s.capture(), initiativeId: next.itemId };
  for (const row of [origin, next, parent]) await s.send(row);
  s.caller('writer');
  const child = {
    ...s.capture(),
    initiativeId: origin.itemId,
    parentId: null,
    body: 'Specimen '.repeat(5000),
  };
  await s.send(child);
  const args = { projectId: s.projectId, collection: 'planningItems', id: child.itemId };
  assert(
    JSON.parse((await detail._handler(s.ctx, args)).value).payloadKey,
    'the prior snapshot needs chunks',
  );
  const move = {
    action: 'put-planning-item',
    itemId: child.itemId,
    expectedVersion: 1,
    parentId: parent.itemId,
    initiativeId: next.itemId,
  };
  assert.equal((await s.batch([move])).results[0].outcome, 'applied');
  assert.equal(
    (await s.batch([{ ...move, expectedVersion: 2, parentId: null, initiativeId: origin.itemId }])).results[0]
      .outcome,
    'applied',
  );
  s.caller('owner');
  const restored = await s.latest(child.itemId);
  assert.equal(restored.initiativeId, origin.itemId);
  assert.equal(restored.parentId, undefined);
  assert.equal(restored.body, child.body);
});

test('one batch cannot build a second level using pending parent tally changes', async t => {
  const s = await project(t);
  const a = s.capture(),
    b = s.capture(),
    c = s.capture();
  for (const row of [a, b, c]) await s.send(row);
  const move = (source, parent, expectedVersion = 1) => ({
    action: 'put-planning-item',
    itemId: source.itemId,
    expectedVersion,
    parentId: parent?.itemId ?? null,
  });
  const { results } = await s.batch([move(c, b), move(b, a), move(a, c)]);
  assert.deepEqual(
    results.map(result => result.outcome),
    ['applied', 'refused', 'refused'],
  );
  assert.match(results[1].message, /with sub-items/);
  assert.match(results[2].message, /top-level parent/);
  assert.equal((await s.latest(b.itemId)).parentId, undefined);
  assert.equal((await s.latest(c.itemId)).parentId, b.itemId);
  const cleared = await s.batch([move(c, null, 2), move(b, a)]);
  assert.deepEqual(
    cleared.results.map(result => result.outcome),
    ['applied', 'applied'],
  );
  assert.equal((await s.latest(b.itemId)).parentId, a.itemId);
});

test('hidden children count against a parent move; shelved children restore top level with notice', async t => {
  const s = await project(t);
  const a = s.capture(),
    b = s.capture();
  for (const row of [a, b]) await s.send(row);
  const child = { ...s.capture(), parentId: b.itemId, hidden: true, status: 'closed' };
  await s.send(child);
  const put = (source, expectedVersion, fields) => ({
    action: 'put-planning-item',
    itemId: source.itemId,
    expectedVersion,
    ...fields,
  });
  const move = put(b, 1, { parentId: a.itemId });
  assert.match((await s.batch([move])).results[0].message, /with sub-items/);
  assert.equal((await s.batch([put(child, 1, { status: 'archived' }), move])).results[1].outcome, 'applied');
  const operationId = randomUUID();
  const restore = [put(child, 2, { status: 'closed' })];
  const { results } = await s.batch(restore, operationId);
  assert.equal(results[0].outcome, 'applied');
  assert.match(results[0].message, /Restored as a top-level Item/);
  const replay = (await s.batch(restore, operationId)).results[0];
  assert.equal(replay.outcome, 'replayed');
  assert.equal(replay.message, results[0].message);
  await assert.rejects(
    s.batch([{ ...restore[0], parentId: null }], operationId),
    error => error.data?.code === 'WORK_OPERATION_CHANGED',
  );
  const forged = await s.batch([put(b, 2, { status: 'open', restoredTopLevel: true })]);
  assert.equal(forged.results[0].code, 'BAD_ARGUMENT');
  assert.equal((await s.latest(b.itemId)).parentId, a.itemId);
  const current = await s.latest(child.itemId);
  assert.equal(current.status, 'closed');
  assert.equal(current.parentId, undefined);
  assert.equal(current.version, 3);
});

test('unknown tally coverage refuses moving an existing Item, not capture, clearing or editing', async t => {
  const s = await project(t);
  const a = s.capture(),
    b = s.capture();
  for (const row of [a, b]) await s.send(row);
  const { _id, value } = [...s.tables.projectWorkDataRecords.values()].find(
    row => row.collection === '_workStorePlanCounts',
  );
  const { scopeThrough, ...legacy } = JSON.parse(value);
  assert.equal(scopeThrough, null);
  await s.ctx.db.patch(_id, { value: JSON.stringify(legacy) });
  const put = (itemId, expectedVersion, fields) => ({
    action: 'put-planning-item',
    itemId,
    expectedVersion,
    ...fields,
  });
  const { results } = await s.batch([
    put(b.itemId, 1, { parentId: a.itemId }),
    put(b.itemId, 1, { body: 'Refined description.' }),
  ]);
  assert.match(results[0].message, /Retry once preparation finishes/);
  assert.equal(results[1].outcome, 'applied');
  const child = { ...s.capture(), parentId: a.itemId };
  await s.send(child);
  assert.equal((await s.batch([put(child.itemId, 1, { parentId: null })])).results[0].outcome, 'applied');
});

test('Capture by a writer cannot reuse the identity of an independent Work Intent', async t => {
  const s = await project(t);
  const base = (await s.read()).sourceHead;
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  const intentId = randomUUID();
  await s.send({ action: 'intent', operationId: intentId, outcome: 'Independent Work Intent', base });
  s.caller('writer');
  await assert.rejects(s.send(s.capture(intentId)), unavailable);
  s.caller('owner');
  assert.equal(
    (await s.read()).data.intents.find(intent => intent.id === intentId)?.outcome,
    'Independent Work Intent',
  );
  assert.equal(await s.latest(intentId), undefined);
});

test('an initial Item read has a bounded DB read in both storage layouts; full text is opt-in', async t => {
  const s = await project(t);
  await s.ctx.db.patch(s.projectId, { sourceAuthority: { mode: 'server', epoch: 1 } });
  await setMode._handler(s.ctx, { projectId: s.projectId, mode: 'dual' });
  const item = { ...s.capture(), body: `Long prose.\n\n${'example '.repeat(6000)}\n\n- [ ] Review` };
  await s.send(item);
  const args = { projectId: s.projectId, collection: 'planningItems', id: item.itemId };
  const io = meterWorkIO(s.ctx, s.tables);
  const verifyDeferred = async layout => {
    const cost = await io.cost(async () => {
      const summary = await detail._handler(s.ctx, { ...args, inlineItemOnly: true });
      assert.equal(summary.deferred, true);
      assert.equal(summary.value, null);
    });
    t.diagnostic(`${layout}: ${JSON.stringify(cost)}`);
    assert(cost.readBytes < 12000, 'the read does not open a body or any payload chunks');
    assert.equal(cost.writeDocuments, 0);
  };
  await verifyDeferred('indexed journal');
  assert(JSON.parse((await detail._handler(s.ctx, args)).value).payloadKey);
  const hosted = s.tables.hostedProjects.get(s.projectId);
  const record = [...s.tables.projectHostedRecords.values()].find(
    row => row.key === item.itemId && row.kind === 'issue',
  );
  assert(record, 'the canonical Item record was written');
  const head = [...s.tables.projectHostedRecordHeads.values()].find(row => row.recordId === record._id);
  s.tables.projectHostedRecordHeads.set(head._id, { ...head, value: undefined });
  s.tables.hostedProjects.set(s.projectId, { ...hosted, workStore: 'records' });
  await verifyDeferred('canonical record');
  assert.equal(JSON.parse((await detail._handler(s.ctx, args)).value).body, item.body);
});

test('CLI tick positions agree with evidence after moved rows and ignore fenced examples', () => {
  const body = '- [~] Delegated\r\n~~~md\r\n- [ ] Not a task\r\n~~~\r\n- [ ] Test it';
  assert.deepEqual(doneWhenCounts(body), [0, 1]);
  assert.throws(() => tickBodyLine(body, 'Not a task'), { code: 'BAD_ARGUMENT' });
  const ticked = tickBodyLine(body, 2);
  assert.equal(ticked.body, body.replace('[ ] Test it', '[x] Test it'));
  assert(isPlanningTick(body, ticked.body, planningLineEvidence(2, 'Test it')));
});
