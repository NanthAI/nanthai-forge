// SPDX-License-Identifier: Apache-2.0
// Plan (Items d3357f40, b7a0dff1): projectPlanView:read lists the Initiatives and every live Item from the planning
// search roots and counts each live Initiative's done and dropped Items, reading only those index ranges (closed
// Items outside live Initiatives cost nothing); the screen's counts reconcile with its rows, "next" is the first free
// planned Item, and a move writes one rank strictly between its new neighbours.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { meterReads } from './hosted-read-set.mjs';
import { indexedRecord } from '../dist/work-hosted-index.js';
import { setup } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const read = await import(moduleUrl('../convex/projectPlanView.ts'));
const { planView, planSentence, movedRank, captureBody, matches } = await import(
  moduleUrl('../web/src/app/plan/model.ts')
);
const { encodePlanPage, planParent, planPageKey, PLAN_ROWS } = await import(
  moduleUrl('../convex/projectPlanRows.ts')
);
const { effectiveRank, legacyRank } = await import(moduleUrl('../src/planning-model.ts'));

const item = (fields, i) => ({
  id: randomUUID(),
  kind: 'issue',
  status: 'open',
  version: 1,
  previousVersion: 0,
  operationId: randomUUID(),
  request: 'a'.repeat(64),
  at: '2026-11-17T00:00:00.000Z',
  author: 'owner',
  provenance: 'user-declared-local',
  title: `Item ${String(i).padStart(3, '0')}`,
  body: 'Done when:\n- [x] one\n- [ ] two\n',
  intentIds: [],
  ...fields,
});

test('the plan read lists live work and counts settled Items of live Initiatives only, from root rows', async t => {
  const s = await setup(t);
  const generationId = s.tables.hostedProjects.get(s.projectId).work.generationId;
  let position = 0;
  const add = async row => {
    for (const entry of indexedRecord('planningItems', row.id, '', position++, row))
      await s.ctx.db.insert('projectPlanningRecords', { ...entry, projectId: s.projectId, generationId });
    return row;
  };
  const live = await add(item({ kind: 'initiative', title: 'Live Initiative', body: '' }, 0));
  const settledInitiative = await add(
    item({ kind: 'initiative', status: 'closed', title: 'Shipped', body: '' }, 1),
  );
  const first = await add(item({ initiativeId: live.id, owner: '@sample' }, 2));
  const second = await add(
    item({ initiativeId: live.id, relations: [{ kind: 'depends-on', id: first.id }] }, 3),
  );
  const third = await add(item({ initiativeId: live.id, type: 'bug', hidden: true }, 4));
  await add(item({ initiativeId: live.id, status: 'in-progress' }, 5));
  await add(item({ initiativeId: live.id, status: 'closed' }, 6));
  await add(item({ initiativeId: live.id, status: 'abandoned' }, 7));
  const loose = await add(item({ status: 'proposed' }, 8));
  // History outside every live Initiative: never read by the plan view.
  for (let i = 0; i < 40; i++)
    await add(item({ initiativeId: settledInitiative.id, status: 'closed' }, 9 + i));

  const meter = meterReads(s.ctx);
  let result;
  const cost = await meter.cost(async () => {
    result = await read.planView(s.ctx, s.projectId);
  });
  t.diagnostic(JSON.stringify({ planViewReads: cost }));
  const rows = JSON.parse(result.rows);
  assert.equal(result.canEdit, true);
  assert.equal(result.more, false);
  assert.deepEqual(result.settled, [{ initiativeId: live.id, done: 1, dropped: 1, atLeast: false }]);
  assert.deepEqual(
    rows
      .filter(row => row.kind === 'issue')
      .map(row => row.title)
      .sort(),
    ['Item 002', 'Item 003', 'Item 004', 'Item 005', 'Item 008'],
  );
  assert.equal(rows.filter(row => row.kind === 'initiative').length, 2);
  const third$ = rows.find(row => row.id === third.id);
  assert.equal(third$.hidden, true, 'members see a hidden Item with its mark');
  assert.equal(third$.type, 'bug');
  assert.deepEqual(third$.doneWhen, [1, 2]);
  assert(!('body' in third$), 'no body reaches the screen');
  assert.equal(rows.find(row => row.id === first.id).owner, '@sample');
  // Roots read: 2 Initiatives + 5 live Items + 2 settled Items of the live Initiative; 40 closed history rows: none.
  assert.equal(cost.documents, 9 + 2, 'plus the project and its generation');

  // A complete compact projection gives exactly the same rows and counts as the legacy reader.
  const pages = new Map();
  for (const root of s.tables.projectPlanningRecords.values()) {
    if (root.collection !== 'planningSearch') continue;
    const row = read.planViewRow(JSON.parse(root.value), root.position);
    const parent = planParent(row.kind, row.status, row.initiativeId);
    const key = planPageKey(parent, row.position);
    if (!pages.has(key)) pages.set(key, { parent, rows: [] });
    pages.get(key).rows.push(row);
  }
  for (const [key, { parent, rows }] of pages)
    await s.ctx.db.insert('projectWorkDataRecords', {
      projectId: s.projectId,
      generationId,
      collection: PLAN_ROWS,
      key,
      parent,
      position: Math.floor(rows[0].position / 128),
      value: encodePlanPage(rows),
    });
  await s.ctx.db.patch(generationId, { planRowsVersion: 1 });
  const compact = await read.planView(s.ctx, s.projectId);
  assert.deepEqual(
    { ...compact, rows: JSON.parse(compact.rows) },
    { ...result, rows: JSON.parse(result.rows) },
    'compact coverage preserves the Plan rows and counts',
  );

  const view = planView(result);
  assert.equal(view.live, 5);
  assert.equal(view.groups.length, 2, 'the settled Initiative with no live Items is not drawn');
  const [group, none] = view.groups;
  assert.equal(group.initiative.id, live.id);
  assert.equal(group.total, 6, 'every Item of the Initiative counts once');
  assert.equal(group.done, 1);
  assert.equal(group.lines.length, group.live, 'the band count matches its rows');
  assert.equal(none.initiative, null);
  assert.deepEqual(
    none.lines.map(line => line.row.id),
    [loose.id],
  );
  assert.equal(
    view.next.id,
    third.id,
    'owned and blocked Items are skipped; the next free planned Item is derived',
  );
  assert.equal(group.lines.find(line => line.row.id === second.id).blockedBy.id, first.id);
  assert.equal(view.done + view.inProgress + view.planned + view.proposed, 1 + 1 + 3 + 1);
  assert.match(planSentence(view).bold, /^1 Item in progress, 3 planned\.$/);
  assert.match(planSentence(view).rest, /The next free one is Item 004\./);

  // Find filters the rows, never the counts.
  const found = planView(result, 'item 003');
  assert.equal(found.groups[0].lines.length, 1);
  assert.equal(found.groups[0].live, 4);
  assert(matches({ title: 'Stream parser: split UTF-8', id: 'abcd1234' }, 'utf-8 stream'));
});

test('a move takes one rank strictly between its new sibling neighbours', () => {
  const row = (id, position, extra = {}) => ({
    id,
    kind: 'issue',
    title: id,
    status: 'open',
    position,
    ...extra,
  });
  const lines = [
    { row: row('a', 1), depth: 0, rank: 1, next: false },
    { row: row('a1', 2, { parentId: 'a' }), depth: 1, rank: 2, next: false },
    { row: row('b', 3), depth: 0, rank: 3, next: false },
    { row: row('c', 4), depth: 0, rank: 4, next: false },
  ];
  // c moves between a's sub-item and b: its neighbours are the top-level a and b.
  const rank = movedRank(lines, ['a', 'a1', 'c', 'b'], 'c');
  assert(rank > effectiveRank(lines[0].row) && rank < effectiveRank(lines[2].row));
  // To the top and to the end.
  assert(movedRank(lines, ['c', 'a', 'a1', 'b'], 'c') < legacyRank(1));
  const last = movedRank(lines, ['b', 'c', 'a1', 'a'], 'a');
  assert(last > legacyRank(4) && last < legacyRank(5), 'still before Items created later');
});

test('capture writes done-when lines as the body task lines', () => {
  assert.equal(captureBody(''), '');
  assert.equal(captureBody('runs clean\n- [ ] linked\n\n'), 'Done when:\n- [ ] runs clean\n- [ ] linked\n');
});
