// SPDX-License-Identifier: Apache-2.0
// The shared planning contract (Item d3357f40, docs/planning.md): hand order, derived next, progress and the one
// public-plan visibility rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  abandonReasons,
  compactRows,
  defaultItemTypes,
  doneWhenCounts,
  effectiveRank,
  inverseRelationLabel,
  itemStatus,
  itemStatusLabel,
  legacyRank,
  nextItem,
  planOrder,
  progress,
  publicPlanVisible,
  rankAtEnd,
  rankBetween,
  rankPattern,
} from '../dist/planning-model.js';
import {
  planningPutSchema,
  rankPattern as storedRankPattern,
  relationKinds as storedRelationKinds,
} from '../dist/work-planning-types.js';
import { doneWhenCounts as rowDoneWhenCounts } from '../dist/planning-search.js';
import { relationKinds } from '../dist/planning-model.js';

const row = (id, patch = {}) => ({ id, kind: 'issue', title: id, status: 'open', position: 0, ...patch });

test('ranks: every move lands strictly between its neighbours and is accepted by the stored schema', () => {
  const ranks = [legacyRank(0), legacyRank(1), legacyRank(61), legacyRank(62), legacyRank(5000)];
  assert.deepEqual([...ranks].sort(), ranks);
  let low = legacyRank(3),
    high = legacyRank(4);
  for (let step = 0; step < 200; step++) {
    const middle = rankBetween(low, high);
    assert(low < middle && middle < high, `${low} < ${middle} < ${high}`);
    assert.match(middle, rankPattern);
    [low, high] = step % 2 ? [middle, high] : [low, middle];
  }
  const top = rankBetween(undefined, legacyRank(0));
  assert(top < legacyRank(0));
  assert.throws(() => rankBetween('B', 'A'), RangeError);
  const put = rank =>
    planningPutSchema.safeParse({
      action: 'put-planning-item',
      operationId: crypto.randomUUID(),
      itemId: crypto.randomUUID(),
      order: rank,
    }).success;
  assert.equal(put(rankBetween(legacyRank(9), legacyRank(10))), true);
  assert.equal(put('A0'), false);
});

test('an Item moved to the end stays before Items created later, and unmoved Items keep creation order', () => {
  const end = rankAtEnd(legacyRank(7), 7);
  assert(legacyRank(7) < end && end < legacyRank(8));
  assert(rankBetween(legacyRank(7)) < legacyRank(8));
  const moved = row('moved', { position: 1, order: end });
  const rows = [row('a', { position: 0 }), moved, row('b', { position: 7 }), row('later', { position: 8 })];
  assert.deepEqual(
    planOrder(rows)
      .at(-1)
      .rows.map(entry => entry.row.id),
    ['a', 'b', 'moved', 'later'],
  );
  assert.equal(effectiveRank(row('x', { position: 2 })), legacyRank(2));
});

test('plan order groups by Initiative order, No Initiative last, sub-items after their parent, cycles kept', () => {
  const rows = [
    row('i2', { kind: 'initiative', position: 1 }),
    row('i1', { kind: 'initiative', position: 2, order: rankBetween(undefined, legacyRank(0)) }),
    row('x', { position: 3, initiativeId: 'i2' }),
    row('y', { position: 4, initiativeId: 'i1' }),
    row('y-sub', { position: 5, parentId: 'y' }),
    row('loose', { position: 6, initiativeId: 'gone' }),
    row('c1', { position: 7, parentId: 'c2' }),
    row('c2', { position: 8, parentId: 'c1' }),
  ];
  const groups = planOrder(rows);
  assert.deepEqual(
    groups.map(group => [
      group.initiative?.id ?? null,
      group.rows.map(entry => `${entry.row.id}:${entry.depth}`),
    ]),
    [
      ['i1', ['y:0', 'y-sub:1']],
      ['i2', ['x:0']],
      [null, ['loose:0', 'c1:0', 'c2:1']],
    ],
  );
});

test('next is the first Planned Item with no owner, no Lane and no open dependency; skipped ones say why', () => {
  const rows = [
    row('proposed', { status: 'proposed', position: 0 }),
    row('owned', { position: 1, owner: '@jun' }),
    row('laned', { position: 2, inLane: true }),
    row('blocked', { position: 3, relations: [{ kind: 'depends-on', id: 'owned' }] }),
    row('free-dep', { position: 4, relations: [{ kind: 'depends-on', id: 'closed-elsewhere' }] }),
    row('after', { position: 5 }),
  ];
  const { next, skipped } = nextItem(rows);
  assert.equal(next.id, 'free-dep');
  assert.deepEqual(
    skipped.map(item => [item.id, item.reason, item.blockedBy ?? null]),
    [
      ['owned', 'owned', null],
      ['laned', 'in-lane', null],
      ['blocked', 'blocked', 'owned'],
    ],
  );
  assert.equal(nextItem([row('done', { status: 'closed' })]).next, null);
});

test('live direct sub-items block a Planned parent and an eligible sub-item can be Next in hand order', () => {
  const parent = row('parent');
  const fallback = row('fallback', { position: 1 });
  const child = row('child', { parentId: parent.id, position: 2, order: 'a' });
  const sibling = row('sibling', { parentId: parent.id, position: 3, order: 'b' });
  const { next, skipped } = nextItem([fallback, sibling, parent, child]);
  assert.equal(next.id, child.id);
  assert.deepEqual(skipped, [{ id: parent.id, title: parent.title, reason: 'blocked', blockedBy: child.id }]);

  for (const status of ['proposed', 'in-progress']) {
    const result = nextItem([parent, fallback, { ...child, status }]);
    assert.equal(result.next.id, fallback.id, status);
    assert.equal(result.skipped[0].blockedBy, child.id, status);
  }
});

test('Next ignores settled sub-items, missing parents and self-parent links in legacy rows', () => {
  const parent = row('legacy-parent');
  const settled = ['closed', 'abandoned', 'archived', 'deleted'].map((status, index) =>
    row(status, { status, parentId: parent.id, position: index + 1 }),
  );
  const grandchild = row('grandchild', { parentId: settled[0].id, position: 5 });
  assert.deepEqual(nextItem([grandchild, ...settled, parent]), { next: parent, skipped: [] });
  for (const parentId of ['missing', parent.id]) {
    const legacy = { ...parent, parentId };
    assert.deepEqual(nextItem([legacy]), { next: legacy, skipped: [] });
  }
});

test('a sub-item must satisfy its own dependencies and a parent keeps its explicit dependency reason', () => {
  const blocker = row('dependency', { status: 'proposed', position: 3 });
  const relations = [{ kind: 'depends-on', id: blocker.id }];
  const parent = row('parent', { relations });
  const child = row('child', { parentId: parent.id, relations, position: 1 });
  const fallback = row('fallback', { position: 2 });
  const { next, skipped } = nextItem([parent, child, fallback, blocker]);
  assert.equal(next.id, fallback.id);
  assert.deepEqual(
    skipped.map(item => [item.id, item.reason, item.blockedBy]),
    [
      [parent.id, 'blocked', blocker.id],
      [child.id, 'blocked', blocker.id],
    ],
  );
});

test('progress counts one tick per Item; Done-when counts come from task lines', () => {
  assert.deepEqual(
    progress(
      ['closed', 'closed', 'in-progress', 'open', 'proposed', 'abandoned'].map(status => ({ status })),
    ),
    { done: 2, inProgress: 1, notStarted: 2, dropped: 1, live: 3, total: 6 },
  );
  assert.deepEqual(doneWhenCounts('Done when:\n- [x] a\n- [ ] b\n  * [X] c\nnot - [ ] inline'), [2, 3]);
  assert.equal(doneWhenCounts('no lines'), null);
  assert.equal(itemStatus.open, 'planned');
  assert.deepEqual(
    compactRows([row('a', { doneWhen: [1, 2], owner: '@mara' })]).map(entry => [
      entry.order,
      entry.status,
      entry.doneWhen,
    ]),
    [[1, 'planned', '1/2']],
  );
});

test('public plan: members-only and private hide everything; hiding an Item or Initiative hides what is under it', () => {
  const base = { projectVisibility: 'public', item: {} };
  assert.equal(publicPlanVisible(base), true);
  assert.equal(publicPlanVisible({ ...base, planVisibility: 'members' }), false);
  assert.equal(publicPlanVisible({ ...base, projectVisibility: 'private' }), false);
  assert.equal(publicPlanVisible({ ...base, item: { hidden: true } }), false);
  const inInitiative = { ...base, item: { initiativeId: 'i' } };
  assert.equal(publicPlanVisible({ ...inInitiative, initiative: { hidden: true } }), false);
  assert.equal(publicPlanVisible({ ...inInitiative, initiative: {} }), true);
  assert.equal(publicPlanVisible({ ...inInitiative, initiative: null }), true);
  // Not looked up: fails closed.
  assert.equal(publicPlanVisible(inInitiative), false);
  const sub = { ...base, item: { parentId: 'p' } };
  assert.equal(publicPlanVisible({ ...sub, parent: { hidden: true } }), false);
  assert.equal(
    publicPlanVisible({ ...sub, parent: { initiativeId: 'i' }, parentInitiative: { hidden: true } }),
    false,
  );
  assert.equal(publicPlanVisible({ ...sub, parent: { initiativeId: 'i' }, parentInitiative: {} }), true);
});

test('the vocabulary is the owner-decided one: Idea/Task/Bug, five statuses and two shelves, three abandon reasons', () => {
  // Owner 2026-11-12 (types) and the approved naming of 2026-11-14 / lead sweep 2026-11-16 (statuses, reasons); the
  // Archive and Deleted shelves are the owner's backlog decision 1.7 and lead decision 1838183c (Item 4c9e961e).
  assert.deepEqual([...defaultItemTypes], ['idea', 'task', 'bug']);
  assert.deepEqual(
    Object.keys(itemStatus).map(stored => itemStatusLabel[itemStatus[stored]]),
    ['Proposed', 'Planned', 'In progress', 'Done', 'Abandoned', 'Archived', 'Deleted'],
  );
  assert.deepEqual(Object.values(abandonReasons), ["Won't do", 'Duplicate', 'Superseded']);
  assert.equal(inverseRelationLabel['depends-on'], 'Blocks');
});

test('the stored schema, the search rows and the model share one rank pattern, relation list and Done-when count', () => {
  // The CLI keeps its own copies so it loads no extra module (7b2ae8d8 module ceiling).
  assert.equal(storedRankPattern.source, rankPattern.source);
  assert.deepEqual([...storedRelationKinds], [...relationKinds]);
  for (const body of ['', '- [ ] a', '- [x] a\n- [ ] b\n * [X] c', 'inline - [ ] no'])
    assert.deepEqual(rowDoneWhenCounts(body), doneWhenCounts(body));
});
