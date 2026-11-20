// SPDX-License-Identifier: Apache-2.0
// Item 76be0714: a visitor's Plan counts on a public plan come from the stored counter's visibility groups (one row
// plus the Initiatives and parents the groups name), not from a live read of up to 1,000 Items, and they count
// exactly what the one visibility rule shows, while members keep the stored totals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup } from './hosted-planning-fixture.mjs';
import { meterReads } from './hosted-read-set.mjs';
import { moduleUrl } from './convex-module.mjs';
import { publicPlanVisible } from '../dist/planning-model.js';
const counts = await import(moduleUrl('../convex/projectPlanCounts.ts'));
const { finishReadProjection, finishPlanProjectProjection } = await import(
  moduleUrl('../convex/projectFinishReadProjection.ts')
);

const STATUSES = ['open', 'in-progress', 'closed', 'proposed', 'abandoned'];
const name = status => (status === 'in-progress' ? 'inProgress' : status);

test('76be0714: visitor Plan counts read the stored groups, not up to 1,000 Items, and match the one rule', async t => {
  const s = await setup(t);
  const project = s.tables.hostedProjects.get(s.projectId);
  Object.assign(project, { visibility: 'public', sourceAuthority: { mode: 'server', epoch: 1 } });
  // The compact project headers follow the project row, as an ordinary project write keeps them.
  const headers = () => {
    for (const [key, row] of s.tables.projectFinishReadRows ?? [])
      if (row.sourceId === s.projectId) s.tables.projectFinishReadRows.delete(key);
    for (const row of [finishReadProjection('hostedProjects', project), finishPlanProjectProjection(project)])
      s.tables.projectFinishReadRows?.set(`header-${row.kind}`, { _id: `header-${row.kind}`, ...row });
  };
  headers();
  const generationId = project.work.generationId;
  const rows = () =>
    [...s.tables.projectPlanningRecords.values()].filter(
      row => row.generationId === generationId && row.collection === 'planningSearch',
    );
  const root = itemId => JSON.parse(rows().find(row => row.key === itemId).value);
  const counter = () =>
    [...s.tables.projectWorkDataRecords.values()].find(
      row => row.generationId === generationId && row.collection === '_workStorePlanCounts',
    );
  // What the one rule shows, counted over every root (the brute force the stored groups replace).
  const expected = member => {
    const roots = new Map(rows().map(row => [row.key, JSON.parse(row.value)]));
    const get = id => (id ? roots.get(id) : undefined);
    const out = { proposed: 0, open: 0, inProgress: 0, closed: 0, abandoned: 0 };
    for (const item of roots.values()) {
      if (item.kind !== 'issue' || !(name(item.status) in out)) continue;
      const parent = get(item.parentId);
      const shown =
        member ||
        publicPlanVisible({
          projectVisibility: 'public',
          item,
          initiative: get(item.initiativeId),
          parent,
          parentInitiative: get(parent?.initiativeId),
        });
      if (shown) out[name(item.status)]++;
    }
    return out;
  };
  const made = new Map();
  const send = async (itemId, patch) => {
    const command = {
      ...made.get(itemId),
      ...patch,
      operationId: randomUUID(),
      expectedVersion: root(itemId).version,
    };
    made.set(itemId, command);
    await s.send(command);
  };
  const read = () => counts.read._handler(s.ctx, { projectId: s.projectId });

  // Through the planning writer: two Initiatives (one hidden), a hidden Item, a parent Item with a sub-item, plain Items.
  const make = async patch => {
    const command = s.item(patch);
    made.set(command.itemId, command);
    await s.send(command);
    return command.itemId;
  };
  const shownInitiative = await make({ kind: 'initiative', title: 'Shown' });
  const hiddenInitiative = await make({ kind: 'initiative', title: 'Hidden', hidden: true });
  const parent = await make({ initiativeId: shownInitiative });
  const child = await make({ initiativeId: shownInitiative, parentId: parent, status: 'in-progress' });
  await make({ hidden: true });
  await make({ status: 'proposed' });
  // A sub-item with no Initiative of its own, under a parent in the hidden Initiative.
  const hiddenParent = await make({ initiativeId: hiddenInitiative });
  await make({ parentId: hiddenParent });
  // An Initiative that is deleted later, with its Items.
  const doomed = await make({ kind: 'initiative', title: 'Doomed' });
  await make({ initiativeId: doomed, status: 'closed' });
  await make({ initiativeId: doomed });
  // An older partition's roots, written without the planning writer: past 1,000 Items in three groups.
  for (let i = 0; i < 1050; i++) {
    const key = randomUUID();
    const status = STATUSES[i % STATUSES.length];
    // Every 50th names an Initiative or a parent no root has: hidden, as the rule treats a missing root.
    const initiativeId = i % 50 === 7 ? randomUUID() : [null, shownInitiative, hiddenInitiative][i % 3];
    const parentId = i % 50 === 9 ? randomUUID() : undefined;
    await s.ctx.db.insert('projectPlanningRecords', {
      projectId: s.projectId,
      generationId,
      collection: 'planningSearch',
      key,
      parent: '',
      position: 10_000 + i,
      value: JSON.stringify({
        id: key,
        kind: 'issue',
        title: `Synthetic ${i}`,
        status,
        initiativeId,
        parentId,
      }),
      planning: {
        text: '',
        kind: 'issue',
        status,
        initiativeId: initiativeId ?? '',
        open: status !== 'closed',
      },
    });
  }
  // A row from before visibility groups (version 1): visitors read the capped root page meanwhile.
  const old = JSON.parse(counter().value);
  delete old.g;
  await s.ctx.db.patch(counter()._id, { value: JSON.stringify({ ...old, v: 1 }) });
  const meter = meterReads(s.ctx);
  s.caller('visitor');
  let reply;
  const before = await meter.cost(async () => (reply = await read()));
  assert.equal(reply.exact, false, 'the capped page cannot see past 1,000 Items');
  assert.ok(before.documents > 1000, `a version 1 row: ${before.documents} documents per visitor open`);

  // The backfill rebuilds a version 1 row with its groups; then a visitor open reads the row and a few ancestors.
  s.caller('owner');
  for (let step = { done: false }, guard = 0; !step.done && guard < 20; guard++)
    step = await counts.backfill._handler(s.ctx, { projectId: s.projectId });
  assert.equal(JSON.parse(counter().value).v, 2);
  s.caller('visitor');
  const after = await meter.cost(async () => (reply = await read()));
  assert.equal(reply.exact, true);
  assert.deepEqual(reply.issue, expected(false), 'the visitor count is what the one rule shows');
  // The counter row and the five existing ancestors its groups name (three Initiatives, two parents; a missing one reads
  // nothing), plus the read's own project, generation and role checks: 10 documents, where the version 1 row's capped
  // page read over 1,000.
  assert.equal(after.documents, 10, 'documents per visitor open');
  assert.notDeepEqual(reply.issue, expected(true), 'hidden Items are left out');
  s.caller('owner');
  assert.deepEqual((await read()).issue, expected(true), 'members keep the stored totals');

  // The writer keeps the groups: hide and show an Initiative, hide a parent, move an Issue between groups.
  const visitor = async label => {
    s.caller('visitor');
    assert.deepEqual((await read()).issue, expected(false), label);
    s.caller('owner');
  };
  await send(shownInitiative, { hidden: true });
  await visitor('a hidden Initiative leaves out its Items and its Items’ sub-items');
  await send(shownInitiative, { hidden: false });
  await visitor('showing it again counts them again');
  await send(parent, { hidden: true });
  await visitor('a hidden parent leaves out its sub-item');
  await send(child, { parentId: null, initiativeId: hiddenInitiative });
  await visitor('an Issue moved into a hidden Initiative is left out');
  await send(child, { initiativeId: null, status: 'closed' });
  await visitor('and counted again, with its new status, once it leaves');
  await send(shownInitiative, { status: 'archived' });
  await visitor('an Archived Initiative leaves out its Items');
  await send(doomed, { status: 'deleted' });
  await visitor('a Deleted Initiative leaves out its Items');
  project.planVisibility = 'members';
  headers();
  s.caller('visitor');
  assert.deepEqual(
    Object.values((await read()).issue),
    [0, 0, 0, 0, 0],
    'a members-only plan shows no count',
  );
  meter.restore();
});

// Review of Lane 88f38162 (S1): the counter row keeps at most PLAN_GROUPS group entries; later groups go to an
// overflow tally that a visitor never counts, so the row stays bounded and the visitor figure is a lower bound.
test('76be0714: past the stored group cap, visitor Plan counts are a lower bound, never an over-count', async t => {
  const s = await setup(t);
  const project = s.tables.hostedProjects.get(s.projectId);
  Object.assign(project, { visibility: 'public', sourceAuthority: { mode: 'server', epoch: 1 } });
  for (const [key, row] of s.tables.projectFinishReadRows ?? [])
    if (row.sourceId === s.projectId) s.tables.projectFinishReadRows.delete(key);
  for (const row of [finishReadProjection('hostedProjects', project), finishPlanProjectProjection(project)])
    s.tables.projectFinishReadRows?.set(`header-${row.kind}`, { _id: `header-${row.kind}`, ...row });
  const generationId = project.work.generationId;
  const counter = () =>
    [...s.tables.projectWorkDataRecords.values()].find(
      row => row.generationId === generationId && row.collection === '_workStorePlanCounts',
    );
  // 120 visible parents, each with one sub-item: 120 groups, past the cap of 100.
  let position = 0;
  const insert = async value =>
    s.ctx.db.insert('projectPlanningRecords', {
      projectId: s.projectId,
      generationId,
      collection: 'planningSearch',
      key: value.id,
      parent: '',
      position: position++,
      value: JSON.stringify({ kind: 'issue', status: 'open', ...value }),
      planning: { text: '', kind: 'issue', status: 'open', initiativeId: '', open: true },
    });
  for (let i = 0; i < 120; i++) {
    const parentId = randomUUID();
    await insert({ id: parentId, title: `Parent ${i}` });
    await insert({ id: randomUUID(), title: `Child ${i}`, parentId });
  }
  await insert({ id: randomUUID(), title: 'Hidden', hidden: true });
  await s.ctx.db.patch(counter()._id, { value: JSON.stringify({ ...JSON.parse(counter().value), v: 1 }) });
  for (let step = { done: false }, guard = 0; !step.done && guard < 20; guard++)
    step = await counts.backfill._handler(s.ctx, { projectId: s.projectId });
  const stored = JSON.parse(counter().value);
  assert.equal(Object.keys(stored.g).length, 100, 'at most 100 entries');
  assert.ok(
    stored.x?.some(n => n > 0),
    'the rest are in the overflow tally',
  );
  s.caller('visitor');
  const reply = await counts.read._handler(s.ctx, { projectId: s.projectId });
  assert.equal(reply.exact, false, 'a lower bound');
  // 120 parents and 120 children are public; the hidden Item never is. Overflowed children are left out.
  assert.ok(reply.issue.open >= 120 && reply.issue.open < 240, `${reply.issue.open} open Items counted`);
  s.caller('owner');
  assert.equal((await counts.read._handler(s.ctx, { projectId: s.projectId })).issue.open, 241, 'members');
});

// Re-review of Lane 88f38162 (SHOULD): with `g` full and `x` in use, a status move of an Issue alone in its group must
// keep it in its entry. Its -1 empties the entry before its +1; pruning only after the moves keeps the entry.
test('76be0714: a status move inside a full set of groups keeps the Issue in its entry, not the overflow', async () => {
  const store = await import(moduleUrl('../convex/projectPlanCountsStore.ts'));
  const counts = store.emptyPlanCounts(true);
  counts.g = Object.fromEntries(
    Array.from({ length: store.PLAN_GROUPS }, (_, i) => [`${i}|`, [1, 0, 0, 0, 0]]),
  );
  counts.x = [1, 0, 0, 0, 0];
  store.tallyGroup(counts, '5|', 'proposed', -1);
  store.tallyGroup(counts, '5|', 'open', 1);
  store.pruneGroups(counts);
  assert.deepEqual(counts.g['5|'], [0, 1, 0, 0, 0], 'still in its entry, with its new status');
  assert.deepEqual(counts.x, [1, 0, 0, 0, 0], 'the overflow is unchanged');
  // An entry a transaction leaves empty is removed, and then a new group goes to the overflow while it is in use.
  store.tallyGroup(counts, '6|', 'proposed', -1);
  store.pruneGroups(counts);
  assert.equal(counts.g['6|'], undefined);
  store.tallyGroup(counts, 'new|', 'open', 1);
  assert.equal(counts.g['new|'], undefined);
  assert.deepEqual(counts.x, [1, 1, 0, 0, 0]);
});
