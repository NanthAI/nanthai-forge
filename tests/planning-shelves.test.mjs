// SPDX-License-Identifier: Apache-2.0
// Archive and Deleted (Item 4c9e961e): an Item sent to either shelf remembers the status it left, leaves every plan
// page, count and public read, is listed only by its own shelf, and comes back by one ordinary put that adds a
// version and keeps the history. Each move is owner-only, applies once under replay and has an Undo. Version compare
// marks the words that changed inside a rewritten line.
import test from 'node:test';
import { storageClock } from './storage-clock.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const { resolvePlanningPut } = await import(moduleUrl('../src/work-planning-put.ts'));
const { planningPutSchema } = await import(moduleUrl('../src/work-planning-types.ts'));
const { publicPlanVisible, progress } = await import(moduleUrl('../src/planning-model.ts'));
const { planViewRow } = await import(moduleUrl('../convex/projectPlanRows.ts'));
const { lineDiff } = await import(moduleUrl('../web/src/app/plan/diff.ts'));
const { shelve, unshelve, shelvedRowOf } = await import(moduleUrl('../web/src/app/plan/Shelf.tsx'));
const { planView } = await import(moduleUrl('../web/src/app/plan/model.ts'));
const { planCountsWriter, emptyPlanCounts, utcDay } = await import(
  moduleUrl('../convex/projectPlanCountsStore.ts')
);
const { readQuery, agentRead, agentReadNote } = await import(moduleUrl('../web/src/app/plan/query.ts'));
const { batchUndo } = await import(moduleUrl('../src/planning-batch.ts'));
const settled = await import(moduleUrl('../convex/projectPlanSettled.ts'));
const batch = await import(moduleUrl('../convex/projectPlanningBatch.ts'));

const put = fields =>
  planningPutSchema.parse({
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId: randomUUID(),
    ...fields,
  });
const stored = { kind: 'issue', title: 'T', body: 'B', status: 'proposed', intentIds: [] };

test('archive and delete remember the status they left; moving between shelves keeps it; coming back clears it', () => {
  const archived = resolvePlanningPut(put({ expectedVersion: 1, status: 'archived' }), stored);
  assert.equal(archived.status, 'archived');
  assert.equal(archived.model.was, 'proposed');
  const deleted = resolvePlanningPut(put({ expectedVersion: 2, status: 'deleted' }), {
    ...stored,
    status: 'archived',
    was: 'proposed',
  });
  assert.equal(deleted.model.was, 'proposed', 'a shelf-to-shelf move keeps the original status');
  const back = resolvePlanningPut(put({ expectedVersion: 3, status: 'proposed' }), {
    ...stored,
    status: 'deleted',
    was: 'proposed',
  });
  assert.equal(back.status, 'proposed');
  assert.equal('was' in back.model, false);
  assert.equal(back.body, 'B', 'the body is kept through the round trip');
  assert.throws(
    () => resolvePlanningPut(put({ expectedVersion: 0, kind: 'issue', title: 'New', status: 'deleted' })),
    /before archiving or deleting/,
  );
});

test('shelved Items leave plan rows, progress and every public read, and only their shelf lists them', () => {
  const root = {
    id: randomUUID(),
    kind: 'issue',
    title: 'Gone',
    status: 'deleted',
    was: 'open',
    at: '2026-11-18',
  };
  assert.equal(planViewRow(root, 3), null, 'not a plan row');
  assert.deepEqual(planViewRow(root, 3, true), {
    id: root.id,
    kind: 'issue',
    title: 'Gone',
    status: 'deleted',
    position: 3,
    was: 'open',
    at: '2026-11-18',
  });
  assert.equal(
    planViewRow({ ...root, status: 'open' }, 3, true),
    null,
    'a shelf list holds shelved rows only',
  );
  assert.deepEqual(progress([{ status: 'closed' }, { status: 'archived' }, { status: 'open' }]), {
    done: 1,
    inProgress: 0,
    notStarted: 1,
    dropped: 0,
    live: 1,
    total: 2,
  });
  const visible = fields => publicPlanVisible({ projectVisibility: 'public', item: {}, ...fields });
  assert.equal(visible({}), true);
  assert.equal(visible({ item: { status: 'archived' } }), false);
  assert.equal(visible({ item: { initiativeId: 'i' }, initiative: { status: 'deleted' } }), false);
  assert.equal(visible({ item: { parentId: 'p' }, parent: { status: 'archived' } }), false);
});

test('Archive and Deleted are views in the address with the matching agent read', () => {
  const query = readQuery(new URLSearchParams('scope=deleted'));
  assert.equal(query.scope, 'deleted');
  assert.equal(agentRead(query), `nforge agent . planning '{"status":"deleted"}'`);
  assert.equal(readQuery(new URLSearchParams('scope=archived')).scope, 'archived');
  assert.equal(
    agentRead(readQuery(new URLSearchParams('scope=closed&q=parser'))),
    `nforge agent . planning '{"status":["closed","abandoned"],"kind":"issue","search":"parser"}'`,
  );
});

test('the Everything view copies the agent read that leaves Archived and Deleted out, as the view does', () => {
  // Review 9cc310fc finding 1: `"status":"all"` also returns both shelves, which Everything never shows.
  assert.equal(agentRead(readQuery(new URLSearchParams('scope=all'))), `nforge agent . planning '{}'`);
  assert.equal(agentReadNote(readQuery(new URLSearchParams('scope=all'))), '');
  // A search with no status returns open work only (src/hosted-agent-planning.ts), so with Find it stays "all" and
  // says what that adds (review c9a52ef1).
  const found = readQuery(new URLSearchParams('scope=all&q=login'));
  assert.equal(agentRead(found), `nforge agent . planning '{"status":"all","search":"login"}'`);
  assert.match(agentReadNote(found), /also lists Archived and Deleted/);
});

test('a rewritten line marks only the words that changed', () => {
  const lines = lineDiff(
    'Title\n\nCovers every API removed in v3.',
    'Title\n\nCovers every API removed or renamed in v3.',
  );
  const old = lines.find(line => line.kind === 'old');
  const added = lines.find(line => line.kind === 'new');
  assert.equal(old.words.map(part => part.text).join(''), old.text, 'parts rebuild the old line exactly');
  assert.equal(added.words.map(part => part.text).join(''), added.text);
  assert.deepEqual(
    added.words.filter(part => part.kind === 'new').map(part => part.text),
    ['or', ' ', 'renamed', ' '],
  );
  assert.equal(old.words.filter(part => part.kind === 'old').length, 0, 'nothing was removed');
});

test('hosted: delete applies once under replay, leaves the plan, lists in Deleted, restores as a new version with Undo, owner only', async t => {
  const s = await setup(t);
  const item = s.item({ title: 'Benchmark the parser', status: 'proposed' });
  await s.send(item);
  const call = (writes, operationId = randomUUID()) =>
    batch.apply._handler(s.ctx, { projectId: s.projectId, operationId, writes: JSON.stringify(writes) });
  const versions = () => [...s.tables.projectWorkEvents.values()].length;
  const writes = shelve([{ id: item.itemId, version: 1 }], 'deleted');
  const operationId = randomUUID();
  const before = versions();
  const first = JSON.parse(await call(writes, operationId));
  const again = JSON.parse(await call(writes, operationId));
  assert.equal(first.results[0].outcome, 'applied');
  assert.equal(again.results[0].outcome, 'replayed');
  assert.equal(versions(), before + 1, 'the exact replay wrote nothing more');

  const latest = async () => (await s.read()).data.planningItems.filter(row => row.id === item.itemId);
  const history = await latest();
  assert.deepEqual(
    history.map(row => [row.version, row.status, row.was ?? null]),
    [
      [1, 'proposed', null],
      [2, 'deleted', 'proposed'],
    ],
  );

  const page = await settled.settledPage(s.ctx, s.projectId, 'deleted', { cursor: null, numItems: 50 });
  const listed = page.page.map(value => JSON.parse(value));
  assert.deepEqual(
    listed.map(row => [row.id, row.status, row.was]),
    [[item.itemId, 'deleted', 'proposed']],
  );
  assert.equal(
    (await settled.settledPage(s.ctx, s.projectId, 'archived', { cursor: null, numItems: 50 })).page.length,
    0,
  );

  // Restore: back to the status it left, as version 3; the deleted version stays in history.
  const restore = [unshelve({ ...listed[0], version: 2 })];
  const restored = JSON.parse(await call(restore));
  assert.equal(restored.results[0].version, 3);
  assert.deepEqual(
    (await latest()).map(row => row.status),
    ['proposed', 'deleted', 'proposed'],
  );
  // Undo of the restore puts it back in Deleted, again as a new version.
  const { undo } = batchUndo(restore, restored.results);
  assert.deepEqual(undo, [
    { action: 'put-planning-item', itemId: item.itemId, expectedVersion: 3, status: 'deleted' },
  ]);
  await call(undo);
  assert.deepEqual((await latest()).map(row => [row.version, row.status, row.was ?? null]).at(-1), [
    4,
    'deleted',
    'proposed',
  ]);

  // Someone who cannot edit the plan can neither restore nor read the list.
  s.caller('stranger');
  await assert.rejects(
    call([{ ...restore[0], expectedVersion: 4 }]),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  await assert.rejects(settled.settledPage(s.ctx, s.projectId, 'deleted', { cursor: null, numItems: 50 }));
});

test('an archived or deleted Item opened by its link reads as its shelf with the way back to the status it left', () => {
  // Review 9cc310fc finding 2: the Item page offered Archive and Delete, never Unarchive or Restore.
  const id = randomUUID();
  const root = fields => JSON.stringify({ id, kind: 'issue', title: 'Old parser', version: 4, ...fields });
  const row = shelvedRowOf(root({ status: 'deleted', was: 'closed' }), id);
  assert.equal(row.status, 'deleted');
  assert.deepEqual(unshelve(row), {
    action: 'put-planning-item',
    itemId: id,
    expectedVersion: 4,
    status: 'closed',
  });
  assert.equal(shelvedRowOf(root({ status: 'archived' }), id).status, 'archived');
  assert.equal(shelvedRowOf(root({ status: 'open' }), id), null, 'an Item on the plan keeps its own page');
  assert.equal(
    shelvedRowOf(root({ status: 'archived' }), randomUUID()),
    null,
    'another Item never stands in',
  );
  assert.equal(shelvedRowOf(null, id), null);
});

test("bringing back a closed Item leaves today's closed count alone; closing one still counts", async t => {
  storageClock(t);
  // Review 9cc310fc finding 3: Restore of a deleted Item whose `was` is closed added 1 to closed today.
  const generationId = 'g1';
  const counts = { ...emptyPlanCounts(true), day: utcDay(Date.now()) };
  const counter = { _id: 'c', value: JSON.stringify(counts) };
  const db = {
    query: () => ({ withIndex: () => ({ unique: async () => counter }) }),
    patch: async (_id, patch) => Object.assign(counter, patch),
  };
  const root = (status, was) => ({
    collection: 'planningSearch',
    key: 'item',
    generationId,
    value: JSON.stringify(was ? { was } : {}),
    planning: { kind: 'issue', status },
  });
  const writer = planCountsWriter(db);
  writer.change(root('deleted', 'closed'), root('closed'));
  writer.change(root('archived', 'closed'), root('closed'));
  await writer.flush();
  let after = JSON.parse(counter.value);
  assert.equal(after.closedToday, 0);
  assert.equal(after.issue.closed, 2, 'the Items count as closed again');
  writer.change(root('in-progress'), root('closed'));
  // Closing a shelved Item that left as open work (a put straight to closed from the CLI or MCP) is a closing.
  writer.change(root('archived', 'open'), root('closed'));
  await writer.flush();
  after = JSON.parse(counter.value);
  assert.equal(after.closedToday, 2);
});

test('an Item whose Initiative was archived or deleted shows under No Initiative with that mark', () => {
  // Review 9cc310fc finding 4: an Initiative archived from the CLI or MCP left its Items pointing at nothing.
  const live = { id: randomUUID(), kind: 'initiative', title: 'Live', status: 'open', position: 0 };
  const gone = randomUUID();
  const item = (title, initiativeId, position) => ({
    id: randomUUID(),
    kind: 'issue',
    title,
    status: 'open',
    position,
    initiativeId,
  });
  const rows = [
    live,
    item('Under live', live.id, 1),
    item('Under gone', gone, 2),
    item('Loose', undefined, 3),
  ];
  const lines = read =>
    planView(read).groups.flatMap(group =>
      group.lines.map(line => [
        line.row.title,
        line.shelvedInitiative ?? false,
        group.initiative?.id ?? null,
      ]),
    );
  assert.deepEqual(lines({ rows: JSON.stringify(rows), more: false, settled: [], canEdit: true }), [
    ['Under live', false, live.id],
    ['Under gone', true, null],
    ['Loose', false, null],
  ]);
  // When some Initiatives were not read, a missing one may just be unread: no mark.
  assert.equal(lines({ rows: JSON.stringify(rows), more: true, settled: [], canEdit: true })[1][1], false);
});
