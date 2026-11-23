// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
const { finishReadWriter } = await import(moduleUrl('../convex/projectFinishReadWriter.ts'));
const { planCounter } = await import(moduleUrl('../convex/projectPlanCountsStore.ts'));
const { workRecordWriter, finishWorkRecordWrites } = await import(
  moduleUrl('../convex/projectWorkRecordWriter.ts')
);
const { planningPage } = await import(moduleUrl('../convex/projectPlanningList.ts'));
const { planView, planSentence, movedRank, movedInitiativeRank, groupBreakdown, captureBody, matches } =
  await import(moduleUrl('../web/src/app/plan/model.ts'));
const { isShut, toggled, allFolds, readFolds, FOLD_FLIPS } = await import(
  moduleUrl('../web/src/app/plan/fold.ts')
);
const { bandRollWidth, rollTicks, BAND_TICKS } = await import(moduleUrl('../web/src/app/plan/rows.tsx'));
const { breakdownWords, breakdownTotal } = await import(moduleUrl('../web/src/app/progress.ts'));
const { encodePlanPage, planParent, planPageKey, PLAN_ROWS } = await import(
  moduleUrl('../convex/projectPlanRows.ts')
);
const { effectiveRank, legacyRank } = await import(moduleUrl('../src/planning-model.ts'));

// Find matches a row's title and the first 8 characters of its id: a fixed digit-free prefix keeps a
// random id from also matching a numeric search such as 'item 003' (about 0.4% of runs).
const item = (fields, i) => ({
  id: `feedface${randomUUID().slice(8)}`,
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
  await s.ctx.db.delete((await planCounter(s.ctx.db, generationId))._id);
  await finishReadWriter(s.ctx).db.patch(generationId, { planRowsVersion: undefined });
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
  assert.equal(cost.documents, 9 + 2, 'plus the project and its generation, with no maintained counter');

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
  await finishReadWriter(s.ctx).db.patch(generationId, { planRowsVersion: 1 });
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
  assert.equal(
    groupBreakdown(group).total,
    group.total,
    'the breakdown parts (done, in progress, open, proposed, removed) add up to the chip',
  );
  assert.equal(group.open + group.inProgress + group.proposed, group.live);
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
  // The mock's sentence (02-plan-board, lead mock check 2026-11-22): left and next, then in progress and what waits
  // on the reader; with the standing line's figures it uses those, so the two never disagree.
  assert.equal(view.left, view.planned + 1, 'Left is planned plus proposed (d3357f40)');
  assert.equal(planSentence(view).bold, `${view.left} Items are left; next is Item 004.`);
  assert.deepEqual(planSentence(view, { left: 7, inProgress: 5, atLeast: false, waitOnYou: 2 }), {
    bold: '7 Items are left; next is Item 004.',
    rest: '5 in progress, 2 of them wait on you.',
  });
  assert.equal(
    planSentence(view, { left: 1, inProgress: 1, atLeast: true, waitOnYou: 0 }).bold,
    '1+ Items are left; next is Item 004.',
  );
  assert.equal(
    planSentence(view, { left: 7, inProgress: 5, atLeast: false, waitOnYou: 1, waitAtLeast: true }).rest,
    '5 in progress, 1+ of them wait on you.',
    'a tally past the reads that say who waits is a lower bound',
  );

  // Find filters the rows, never the counts.
  const found = planView(result, 'item 003');
  assert.equal(found.groups[0].lines.length, 1);
  assert.equal(found.groups[0].live, 4);
  assert(matches({ title: 'Stream parser: split UTF-8', id: 'abcd1234' }, 'utf-8 stream'));
});

test('the Plan names an eligible sub-item as Next even when the list filters it out', () => {
  const parent = item({ title: 'Ship the parser' }, 0);
  const later = item({ title: 'Update the guide' }, 1);
  const child = item({ parentId: parent.id, title: 'Check split bytes' }, 2);
  const read = { rows: JSON.stringify([parent, later, child]), more: false, settled: [], canEdit: true };
  const view = planView(read);
  assert.deepEqual(
    view.groups[0].lines.map(line => [line.row.title, line.next]),
    [
      [parent.title, false],
      [child.title, true],
      [later.title, false],
    ],
  );
  const filtered = planView(read, parent.title);
  assert.deepEqual(
    filtered.groups[0].lines.map(line => line.row.id),
    [parent.id],
  );
  assert.equal(planSentence(filtered).bold, '3 Items are left; next is Check split bytes.');
});

test('Plan keeps a sub-item under its displayed parent while counting it under its stored Initiative', () => {
  const source = item({ kind: 'initiative', title: 'Source' }, 0);
  const target = item({ kind: 'initiative', status: 'closed', title: 'Target' }, 1);
  const parent = item({ initiativeId: source.id }, 2);
  const child = item({ initiativeId: target.id, parentId: parent.id, hidden: true, status: 'proposed' }, 3);
  const loose = item({ status: 'in-progress' }, 4);
  const shelved = item({ initiativeId: randomUUID() }, 5);
  const read = {
    rows: JSON.stringify([source, target, parent, child, loose, shelved]),
    more: false,
    settled: [{ initiativeId: target.id, done: 2, dropped: 1, atLeast: true }],
    canEdit: true,
  };
  const [a, b, none] = planView(read).groups;
  assert.deepEqual(
    a.lines.map(line => [line.row.id, line.depth]),
    [
      [parent.id, 0],
      [child.id, 1],
    ],
  );
  assert.deepEqual([a.open, a.proposed, a.total], [1, 0, 1]);
  assert.equal(b.initiative.id, target.id);
  assert.deepEqual(b.lines, []);
  assert.deepEqual([b.proposed, b.done, b.dropped, b.total], [1, 2, 1, 4]);
  assert.equal(
    breakdownWords(groupBreakdown(b)),
    '2+ done · 0 in progress · 0 open · 1 proposed · 1+ removed',
  );
  assert.equal(none.live, 2);
  assert.equal(none.lines.find(line => line.row.id === shelved.id).shelvedInitiative, true);

  const [filteredA, filteredB, filteredNone] = planView(read, parent.title).groups;
  assert.equal(filteredA.lines.length, 1);
  assert.equal(filteredB.total, b.total);
  assert.equal(filteredNone.live, 2);

  const partialView = planView({ ...read, more: true });
  const [, partial, partialNone] = partialView.groups;
  assert.equal(partialView.more, true);
  assert.equal(partial.proposed, 1);
  assert.equal(breakdownTotal(groupBreakdown(partial)), '4+ Items');
  assert.equal(
    breakdownWords(groupBreakdown(partial)),
    '2+ done · 0+ in progress · 0+ open · 1+ proposed · 1+ removed',
  );
  assert.equal(partialNone.live, 2, 'loaded Items stay in the fallback count while coverage is incomplete');
  assert.equal(partialNone.lines.find(line => line.row.id === shelved.id).shelvedInitiative, undefined);
});

test('settled Initiative progress matches indexed counts for members and follows public visibility for visitors', async t => {
  const s = await setup(t);
  const project = s.tables.hostedProjects.get(s.projectId);
  const generationId = project.work.generationId;
  const writer = workRecordWriter(s.ctx);
  let position = 0;
  const add = async fields => {
    const row = item(fields, position);
    for (const entry of indexedRecord('planningItems', row.id, '', position++, row))
      await writer.db.insert('projectPlanningRecords', { ...entry, projectId: s.projectId, generationId });
    return row;
  };
  const live = await add({ kind: 'initiative' });
  const closed = await add({ kind: 'initiative', status: 'closed' });
  const abandoned = await add({ kind: 'initiative', status: 'abandoned' });
  const hiddenWork = await add({ kind: 'initiative', status: 'closed' });
  const shelved = await add({ kind: 'initiative', status: 'archived' });
  const parent = await add({ initiativeId: live.id });
  const child = await add({ initiativeId: closed.id, parentId: parent.id, status: 'proposed' });
  await add({ initiativeId: abandoned.id, status: 'in-progress' });
  await add({ initiativeId: hiddenWork.id, hidden: true });
  await add({ initiativeId: shelved.id });
  for (const initiativeId of [closed.id, abandoned.id, hiddenWork.id]) {
    await add({ initiativeId, status: 'closed' });
    await add({ initiativeId, status: 'closed', hidden: true });
    await add({ initiativeId, status: 'abandoned' });
    await add({ initiativeId, status: 'archived', was: 'closed' });
    await add({ initiativeId, status: 'deleted', was: 'abandoned' });
  }
  await finishWorkRecordWrites(writer);
  const request = { projectId: s.projectId };
  const compact = await read.read._handler(s.ctx, request);
  await finishReadWriter(s.ctx).db.patch(generationId, { planRowsVersion: undefined });
  const legacy = await read.read._handler(s.ctx, request);
  assert.deepEqual(JSON.parse(compact.rows), JSON.parse(legacy.rows));
  assert.deepEqual(compact.settled, legacy.settled);
  const model = planView(compact);
  assert.equal(model.groups.find(group => group.initiative?.id === live.id).lines[1].row.id, child.id);
  for (const initiative of [live, closed, abandoned, hiddenWork]) {
    const indexed = await planningPage(s.ctx, project, s.tables.projectWorkGenerations.get(generationId), {
      planningFilter: { kind: 'issue', initiativeId: initiative.id },
      counts: true,
      paginationOpts: { numItems: 1000, cursor: null },
    });
    const group = model.groups.find(group => group.initiative?.id === initiative.id);
    assert.equal(indexed.isDone, true);
    assert.deepEqual(
      [group.proposed, group.open, group.inProgress, group.done, group.dropped],
      ['proposed', 'open', 'in-progress', 'closed', 'abandoned'].map(status => indexed.counts[status]),
    );
  }
  assert.equal(model.groups.find(group => !group.initiative).lines[0].shelvedInitiative, true);

  s.ctx.meta.getTransactionMetrics = async () => ({
    bytesRead: { remaining: 16 * 1024 * 1024 },
    documentsRead: { remaining: 3 },
    databaseQueries: { remaining: 4096 },
  });
  const partial = await read.planView(s.ctx, s.projectId);
  delete s.ctx.meta.getTransactionMetrics;
  assert.deepEqual(JSON.parse(partial.rows), JSON.parse(legacy.rows));
  assert.deepEqual(
    partial.settled.find(group => group.initiativeId === live.id),
    legacy.settled[0],
  );
  assert.deepEqual(
    partial.settled.find(group => group.initiativeId === closed.id),
    {
      initiativeId: closed.id,
      done: 2,
      dropped: 0,
      atLeast: true,
    },
  );

  await finishReadWriter(s.ctx).db.patch(s.projectId, { visibility: 'public' });
  s.caller('stranger');
  const visitor = await read.read._handler(s.ctx, request);
  assert.deepEqual(
    visitor.settled,
    [live.id, closed.id, abandoned.id].map((initiativeId, index) => ({
      initiativeId,
      done: index === 0 ? 0 : 1,
      dropped: index === 0 ? 0 : 1,
      atLeast: true,
    })),
  );
  // Hidden history crossing the shared count window must not change the visitor's coverage signal.
  for (let i = 0; i < read.PLAN_SETTLED_LIMIT; i++) {
    const hidden = item({ initiativeId: closed.id, status: 'closed', hidden: true }, position);
    const root = indexedRecord('planningItems', hidden.id, '', position++, hidden).find(
      entry => entry.collection === 'planningSearch',
    );
    await s.ctx.db.insert('projectPlanningRecords', { ...root, projectId: s.projectId, generationId });
  }
  assert.deepEqual((await read.read._handler(s.ctx, request)).settled, visitor.settled);
  assert.equal(visitor.liveMore, true);

  const publicParent = await add({ status: 'closed' });
  await add({ status: 'closed', initiativeId: live.id, parentId: publicParent.id });
  await finishWorkRecordWrites(writer);
  const settledForLive = result => result.settled.find(group => group.initiativeId === live.id);
  assert.equal(settledForLive(await read.read._handler(s.ctx, request)).done, 1);
  let measurements = 0;
  s.ctx.meta.getTransactionMetrics = async () => ({
    bytesRead: { remaining: 16 * 1024 * 1024 },
    documentsRead: { remaining: 4000 },
    databaseQueries: { remaining: ++measurements === 1 ? 4096 : 2 },
  });
  const budgeted = await read.read._handler(s.ctx, request);
  delete s.ctx.meta.getTransactionMetrics;
  assert.deepEqual(
    settledForLive(budgeted),
    { initiativeId: live.id, done: 0, dropped: 0, atLeast: true },
    'a visitor count leaves out history whose parent could not be checked',
  );
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

test('an Initiative move takes one rank strictly between its new Initiative neighbours (Item 4df3ee17)', () => {
  const initiative = (id, position, order) => ({
    id,
    kind: 'initiative',
    title: id,
    status: 'open',
    position,
    order,
  });
  const rows = [initiative('a', 1), initiative('b', 5, null), initiative('c', 9)];
  const between = movedInitiativeRank(rows, ['a', 'c', 'b'], 'c');
  assert(between > effectiveRank(rows[0]) && between < effectiveRank(rows[1]));
  assert(movedInitiativeRank(rows, ['c', 'a', 'b'], 'c') < legacyRank(1), 'to the top');
  const last = movedInitiativeRank(rows, ['b', 'c', 'a'], 'a');
  assert(last > legacyRank(9) && last < legacyRank(10), 'to the end, still before Initiatives created later');
  assert.equal(movedInitiativeRank(rows, ['a', 'b'], 'missing'), null);
});

test('group folds: per project on this browser, Collapse all folds later Initiatives too (decision afcb5bc3)', () => {
  let folds = readFolds(null);
  assert.equal(isShut(folds, 'a'), false, 'everything opens by default');
  folds = toggled(folds, 'a');
  assert.equal(isShut(folds, 'a'), true);
  folds = allFolds('shut');
  assert.equal(isShut(folds, 'a') && isShut(folds, 'created-later'), true);
  folds = toggled(folds, 'b');
  assert.equal(isShut(folds, 'b'), false, 'one group opened from the overview');
  assert.deepEqual(readFolds(JSON.stringify(folds)), folds, 'kept as written');
  assert.deepEqual(
    readFolds('{"base":"sideways"}'),
    { base: 'open', flip: [] },
    'an unreadable entry folds nothing',
  );
  let many = allFolds('open');
  for (let i = 0; i < FOLD_FLIPS + 5; i++) many = toggled(many, `g${i}`);
  assert.equal(many.flip.length, FOLD_FLIPS, 'a bounded entry');
});

test('a band roll is always wide enough for its ticks, so it never draws over its words (f49e3a5c)', () => {
  for (const total of [0, 1, 3, 9, 24, 77, 131, 1284]) {
    const ticks = rollTicks(total, BAND_TICKS);
    // Each tick has a 2 px floor and a 2 px gap (web/src/ds/core.css .roll).
    assert.ok(bandRollWidth(ticks) >= ticks * 4 - 2, `${total} Items`);
    assert.ok(bandRollWidth(ticks) <= 120);
  }
});

test('an Initiative breakdown counts every Item once, in one fixed order, and its parts add up to the chip (b7a0dff1)', () => {
  const counted = groupBreakdown({
    done: 30,
    inProgress: 12,
    open: 58,
    proposed: 0,
    dropped: 1,
    atLeast: false,
  });
  assert.equal(breakdownWords(counted), '30 done · 12 in progress · 58 open · 1 removed');
  assert.equal(breakdownTotal(counted), '101 Items');
  assert.equal(
    counted.parts.reduce((sum, part) => sum + part.n, 0),
    counted.total,
  );
  const proposed = groupBreakdown({
    done: 4,
    inProgress: 1,
    open: 2,
    proposed: 1,
    dropped: 1,
    atLeast: false,
  });
  assert.deepEqual(
    proposed.parts.map(part => [part.key, part.tick]),
    [
      ['done', 'ok'],
      ['inProgress', 'run'],
      ['open', 'open'],
      ['proposed', 'proposed'],
      ['removed', 'gone'],
    ],
    'proposed appears only when there is one, between open and removed',
  );
  assert.equal(proposed.total, 9);
  const capped = groupBreakdown({
    done: 1000,
    inProgress: 0,
    open: 3,
    proposed: 0,
    dropped: 2,
    atLeast: true,
  });
  assert.equal(breakdownWords(capped), '1,000+ done · 0 in progress · 3 open · 2+ removed');
  assert.equal(breakdownTotal(capped), '1,005+ Items');
});

test('a roll tick class is never also a bare global class (mock check d3357f40: "prop" drew the amber .prop ring)', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const ticks = groupBreakdown({
    done: 1,
    inProgress: 1,
    open: 1,
    proposed: 1,
    dropped: 1,
    atLeast: false,
  }).parts.map(part => part.tick);
  const bare = new Set();
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.css'))
        for (const [, selectors] of readFileSync(path, 'utf8').matchAll(/([^{}]+)\{/g))
          for (const selector of selectors.split(','))
            if (/^\.[\w-]+$/.test(selector.trim())) bare.add(selector.trim());
    }
  };
  walk(new URL('../web/src', import.meta.url).pathname);
  assert.ok(bare.has('.prop'), 'the scan sees the design system’s own bare classes');
  assert.deepEqual(
    ticks.filter(tick => bare.has(`.${tick}`)),
    [],
  );
});

test('Group by a field (d3357f40): owner puts unowned Items under "No one yet", last; every row lands in one band', async () => {
  const { planBands, boardBands, columnTotals, subItems } = await import(
    moduleUrl('../web/src/app/plan/bands.ts')
  );
  const launch = item({ kind: 'initiative', title: 'Launch' }, 0);
  const a = item({ initiativeId: launch.id, owner: '@sample', type: 'bug' }, 1);
  const b = item({ initiativeId: launch.id, status: 'in-progress', type: 'Bug' }, 2);
  const c = item({ owner: 'sample', status: 'proposed' }, 3);
  const d = item({ owner: '@peer/amber-fox', initiativeId: launch.id, parentId: a.id }, 4);
  const done = item(
    { status: 'closed', initiativeId: launch.id, owner: '@peer/amber-fox', parentId: a.id },
    5,
  );
  const read = { rows: JSON.stringify([launch, a, b, c, d]), more: false, settled: [], canEdit: true };
  const view = planView(read);
  const bands = (by, settled = []) =>
    planBands(view, by, settled, { openShown: true, hideEmpty: false }).map(band => [
      band.title,
      band.lines.map(line => line.row.id),
    ]);
  // Owner: the handle as set, with and without "@" and in any case, is one person; no owner is "No one yet", last.
  assert.deepEqual(bands('owner'), [
    ['@sample', [a.id, c.id]],
    ['@peer/amber-fox', [d.id]],
    ['No one yet', [b.id]],
  ]);
  assert.deepEqual(bands('type'), [
    ['Bug', [a.id, b.id]],
    ['No type', [d.id, c.id]],
  ]);
  assert.deepEqual(bands('none'), [['All Items', [a.id, d.id, b.id, c.id]]]);
  // Done Items read for the scope join their Initiative's band; the Initiative keeps its whole-plan counts.
  const byInitiative = planBands(view, 'initiative', [done], { openShown: true, hideEmpty: false });
  assert.deepEqual(
    byInitiative.map(band => [band.title, band.lines.length]),
    [
      ['Launch', 4],
      ['No Initiative', 1],
    ],
  );
  assert.equal(byInitiative[0].group.initiative.id, launch.id);
  // The board: a sub-item whose parent is a row is in the parent's roll, not a row; each column's total is its rows.
  const board = boardBands(byInitiative);
  assert.deepEqual(
    board[0].lines.map(line => line.row.id),
    [a.id, b.id],
  );
  assert.deepEqual(Object.fromEntries(columnTotals(board)), {
    proposed: 1,
    planned: 1,
    'in-progress': 1,
    done: 0,
    abandoned: 0,
  });
  assert.deepEqual(subItems([launch, a, b, c, d, done]).get(a.id), { total: 2, done: 1, running: 0 });
  // A filter hides bands with nothing in them; without one a live Initiative with nothing open keeps its band.
  const quiet = item({ kind: 'initiative', title: 'Quiet' }, 6);
  const withQuiet = planView({ ...read, rows: JSON.stringify([launch, quiet, a]) });
  const titles = hideEmpty =>
    planBands(withQuiet, 'initiative', [], { openShown: true, hideEmpty }).map(band => band.title);
  assert.deepEqual(titles(false), ['Launch', 'Quiet']);
  assert.deepEqual(titles(true), ['Launch']);
});

test('Board sub-items (d3357f40 review): deeper chains roll into the top Item, a cycle keeps one row, "@" is no owner', async () => {
  const { planBands, boardBands, subItems } = await import(moduleUrl('../web/src/app/plan/bands.ts'));
  const top = item({}, 10);
  const mid = item({ parentId: top.id }, 11);
  const leaf = item({ parentId: mid.id, status: 'closed' }, 12);
  const x = item({ owner: '@' }, 13);
  const y = item({ parentId: x.id }, 14);
  x.parentId = y.id;
  const tail = item({ parentId: x.id }, 15);
  const rows = [top, mid, leaf, x, y, tail];
  const band = {
    id: 'all',
    field: 'none',
    title: 'All Items',
    lines: rows.map(row => ({ row, depth: 0, rank: 0, next: false })),
  };
  const cycleRow = [x.id, y.id].sort()[0];
  // Every row is either a board row or in exactly one top Item's roll; nothing vanishes.
  assert.deepEqual(
    boardBands([band])[0]
      .lines.map(line => line.row.id)
      .sort(),
    [top.id, cycleRow].sort(),
  );
  const subs = subItems(rows);
  assert.deepEqual(subs.get(top.id), { total: 2, done: 1, running: 0 });
  assert.deepEqual(subs.get(cycleRow), { total: 2, done: 0, running: 0 });
  // An owner that is only "@" is no owner: it joins "No one yet", never an empty-named band.
  const view = planView({ rows: JSON.stringify([x]), more: false, settled: [], canEdit: true });
  assert.deepEqual(
    planBands(view, 'owner', [], { openShown: true, hideEmpty: false }).map(b => [b.id, b.title]),
    [['owner:', 'No one yet']],
  );
});

test('board Lane words join loaded reads only: the newest Lane decides, questions join by Item or Lane (d3357f40)', async () => {
  const { itemLanes, lanesNeedingYou } = await import(moduleUrl('../web/src/app/plan/lane-words.ts'));
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  // Intent → Item: 1→A, 2→B, 3→C, 4→D.
  const asked = new Map([
    [id(1), 'A'],
    [id(2), 'B'],
    [id(3), 'C'],
    [id(4), 'D'],
  ]);
  const lanes = [
    { intentId: id(1), actor: 'x', at: 10, laneId: id(101) },
    { intentId: id(1), actor: 'x', at: 20, laneId: id(102) },
    { intentId: id(2), actor: 'x', at: 10, laneId: id(103) },
    { intentId: id(3), actor: 'x', at: 10, laneId: id(104) },
  ];
  const feed = {
    lanes: [
      { laneId: id(101), stage: 'editing', held: false, overlap: false, changedAt: 1 },
      { laneId: id(102), stage: 'ready', held: true, overlap: false, changedAt: 2 },
      { laneId: id(103), stage: 'checking', held: false, overlap: false, changedAt: 1 },
      { laneId: id(104), stage: 'editing', held: false, overlap: false, changedAt: 1 },
    ],
    more: 0,
    moreIsLowerBound: false,
    main: null,
  };
  const ask = (n, extra) => ({
    id: `q${n}`,
    at: 1,
    actor: 'x',
    agent: null,
    text: '?',
    choices: [],
    laneId: null,
    ...extra,
  });
  const needs = {
    held: [
      {
        laneId: id(105),
        intentId: id(4),
        title: null,
        actor: 'x',
        agent: null,
        why: 'review',
        note: null,
        submissionId: null,
        since: 1,
      },
    ],
    more: 0,
    moreIsLowerBound: false,
    approvals: '{"requests":[]}',
    canDecide: true,
    asks: [
      ask(1, { laneId: id(104) }),
      ask(2, { planningItemId: 'B', laneId: id(999) }),
      ask(3, { planningItemId: 'A', ahead: true }),
    ],
  };
  const out = itemLanes({ asked, needs, feed, lanes, now: 1 });
  // A: its newest Lane (102) is held for a reason no read names, so the older Lane's "Editing" never shows.
  assert.equal(out.has('A'), false, 'a question asked ahead does not hold work');
  assert.equal(out.get('B')?.why, 'a question', 'a question joins by its Item');
  assert.equal(out.get('C')?.why, 'a question', 'a question joins by its Lane, before the feed stop');
  assert.equal(out.get('D')?.you, true);
  assert.equal(itemLanes({ asked, needs: undefined, feed, lanes, now: 1 }).get('C')?.word, 'Editing');
  assert.equal(itemLanes({ asked, needs: undefined, feed, lanes, now: 1 }).has('A'), false);
  // "need you" counts Lanes, each once, never questions; a capped read stays a lower bound.
  assert.deepEqual(lanesNeedingYou(needs, 1), { n: 1, atLeast: false });
  assert.deepEqual(lanesNeedingYou({ ...needs, more: 3 }, 1), { n: 1, atLeast: true });
  assert.equal(lanesNeedingYou(undefined, 1), null);
});

test('d3357f40: Left counts proposed Items with planned ones, in the headline and without the project figures', () => {
  const planned = item({ title: 'Reuse the buffer' }, 0);
  const idea = item({ title: 'Drop the CommonJS build?', status: 'proposed' }, 1);
  const moving = item({ title: 'Stream parser', status: 'in-progress' }, 2);
  const view = planView({
    rows: JSON.stringify([planned, idea, moving]),
    more: false,
    settled: [],
    canEdit: true,
  });
  assert.equal(view.left, 2, 'one planned plus one proposed');
  assert.equal(planSentence(view).bold, '2 Items are left; next is Reuse the buffer.');
  const only = planView({ rows: JSON.stringify([idea]), more: false, settled: [], canEdit: true });
  assert.equal(
    planSentence(only).bold,
    '1 Item is left; none is ready to pick up.',
    'an Idea alone is still left',
  );
});
