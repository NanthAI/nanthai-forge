// SPDX-License-Identifier: Apache-2.0
// Plan views (Item e0a23825): the view lives in the address and round-trips; filters keep the same rows the agent
// read keeps; any order other than by hand sorts without touching the shared order; the Closed and Everything scopes
// read done and dropped Items one bounded page at a time from the root rows, and an inaccessible project reveals
// nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { meterReads } from './hosted-read-set.mjs';
import { indexedRecord } from '../dist/work-hosted-index.js';
import { setup } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const { readQuery, writeQuery, agentRead, keeps, sortRows, filtered } = await import(
  moduleUrl('../web/src/app/plan/query.ts')
);
const { planView } = await import(moduleUrl('../web/src/app/plan/model.ts'));
const { planViewLinks } = await import(moduleUrl('../web/src/app/plan/view-links.ts'));
const settled = await import(moduleUrl('../convex/projectPlanSettled.ts'));

const row = (fields, i) => ({
  id: randomUUID(),
  kind: 'issue',
  status: 'open',
  version: 1,
  position: i,
  title: `Item ${String(i).padStart(3, '0')}`,
  ...fields,
});

test('a view round-trips through the address and leaves defaults out', () => {
  assert.equal(writeQuery(readQuery(new URLSearchParams(''))), '');
  const query = readQuery(
    new URLSearchParams(
      'scope=all&type=Bug&owner=%40sample&relation=none&sort=owner&view=board&group=owner&q=login',
    ),
  );
  assert.deepEqual(
    { ...query },
    {
      scope: 'all',
      sort: 'owner',
      layout: 'board',
      group: 'owner',
      type: 'Bug',
      owner: '@sample',
      relation: 'none',
      initiative: undefined,
      find: 'login',
    },
  );
  assert.equal(
    writeQuery(query),
    '?scope=all&type=Bug&owner=%40sample&relation=none&sort=owner&view=board&group=owner&q=login',
  );
  // Unknown values fall back instead of failing the screen.
  const odd = readQuery(new URLSearchParams('scope=nope&sort=x&view=y&relation=z&group=w'));
  assert.equal(odd.scope, 'open');
  assert.equal(odd.group, 'initiative');
  assert.equal(odd.sort, 'hand');
  assert.equal(odd.layout, 'list');
  assert.equal(odd.relation, undefined);
  assert.equal(filtered(odd), false);
  assert.equal(
    agentRead(query),
    `nforge agent . planning '{"status":"all","type":"Bug","owner":"@sample","relation":"none","search":"login"}'`,
  );
});

test('Group is part of the address like the layout: views keep it and match whatever the group (d3357f40)', () => {
  const query = readQuery(new URLSearchParams('owner=none&view=board&group=type'));
  const links = planViewLinks('/plan', query, 'sample', []);
  assert.equal(links.on?.id, 'unowned', 'the group never changes which view is current');
  assert.equal(links.href(''), '/plan?view=board&group=type', 'moving to another view keeps the group');
  // The group is presentation only: the agent command is the same whatever the group.
  assert.equal(agentRead(query), agentRead({ ...query, group: 'initiative' }));
});

test('filters keep the rows the agent read keeps, and other sorts never renumber the hand order', () => {
  const initiative = row({ kind: 'initiative', title: 'Launch' }, 0);
  const a = row({ initiativeId: initiative.id, owner: '@sample', type: 'bug', order: 'b' }, 1);
  const b = row({ initiativeId: initiative.id, owner: '@sample/agent', order: 'a' }, 2);
  const c = row(
    { initiativeId: initiative.id, relations: [{ kind: 'depends-on', id: a.id }], order: 'c' },
    3,
  );
  const read = { rows: JSON.stringify([initiative, a, b, c]), more: false, settled: [], canEdit: true };
  const query = readQuery(new URLSearchParams('owner=sample'));
  const view = planView(read, '', new Map(), r => keeps(r, query));
  const lines = view.groups[0].lines;
  assert.deepEqual(
    lines.map(line => line.row.id),
    [b.id, a.id],
  );
  // Counts stay the whole plan's: the filter narrows the listed lines only.
  assert.equal(view.groups[0].live, 3);
  assert.equal(view.live, 3);
  // Hand ranks are kept from the whole group, so a filtered row shows its real place.
  assert.deepEqual(
    lines.map(line => line.rank),
    [1, 2],
  );
  assert.deepEqual(
    sortRows(lines, 'title').map(line => line.row.id),
    [a.id, b.id],
  );
  assert.deepEqual(
    planView(read, '', new Map(), r =>
      keeps(r, readQuery(new URLSearchParams('relation=depends-on'))),
    ).groups[0].lines.map(line => line.row.id),
    [c.id],
  );
  assert.deepEqual(
    planView(read, '', new Map(), r =>
      keeps(r, readQuery(new URLSearchParams('owner=none'))),
    ).groups[0].lines.map(line => line.row.id),
    [c.id],
  );
});

test('done and dropped Items come one bounded page at a time from root rows', async t => {
  const s = await setup(t);
  const generationId = s.tables.hostedProjects.get(s.projectId).work.generationId;
  let position = 0;
  const add = async fields => {
    const value = {
      id: randomUUID(),
      kind: 'issue',
      status: 'closed',
      version: 1,
      previousVersion: 0,
      operationId: randomUUID(),
      request: 'a'.repeat(64),
      at: '2026-11-17T00:00:00.000Z',
      author: 'owner',
      provenance: 'user-declared-local',
      title: `Item ${position}`,
      body: 'Done when:\n- [x] one\n',
      intentIds: [],
      ...fields,
    };
    for (const entry of indexedRecord('planningItems', value.id, '', position++, value))
      await s.ctx.db.insert('projectPlanningRecords', { ...entry, projectId: s.projectId, generationId });
    return value;
  };
  for (let i = 0; i < 70; i++) await add({});
  const abandonedItem = await add({ status: 'abandoned' });
  await add({ status: 'open' });

  const meter = meterReads(s.ctx);
  let first;
  const cost = await meter.cost(async () => {
    first = await settled.settledPage(s.ctx, s.projectId, 'closed', { cursor: null, numItems: 500 });
  });
  t.diagnostic(JSON.stringify({ planSettledPage: cost }));
  assert.equal(first.page.length, settled.PLAN_SETTLED_PAGE);
  assert.equal(first.isDone, false);
  assert.ok(first.page.every(value => JSON.parse(value).status === 'closed'));
  assert.ok(first.page.every(value => !('body' in JSON.parse(value))));
  // One page of roots plus the project and generation reads, never the whole history.
  assert.ok(cost.documents <= settled.PLAN_SETTLED_PAGE + 8, JSON.stringify(cost));
  const second = await settled.settledPage(s.ctx, s.projectId, 'closed', {
    cursor: first.continueCursor,
    numItems: 50,
  });
  assert.equal(second.page.length, 20);
  assert.equal(second.isDone, true);
  const dropped = await settled.settledPage(s.ctx, s.projectId, 'abandoned', { cursor: null, numItems: 50 });
  assert.equal(dropped.page.length, 1);

  // An Initiative page (Item 4df3ee17) reads only its own done Items, by the Initiative index: 70 others cost nothing.
  const initiativeId = randomUUID();
  const own = [await add({ initiativeId }), await add({ initiativeId })];
  await add({ initiativeId, status: 'abandoned' });
  let mine;
  const narrow = await meter.cost(async () => {
    mine = await settled.settledPage(
      s.ctx,
      s.projectId,
      'closed',
      { cursor: null, numItems: 50 },
      initiativeId,
    );
  });
  assert.deepEqual(mine.page.map(value => JSON.parse(value).id).sort(), own.map(row => row.id).sort());
  assert.equal(mine.isDone, true);
  assert.ok(narrow.documents <= own.length + 8, JSON.stringify(narrow));
  await assert.rejects(
    settled.settledPage(s.ctx, s.projectId, 'closed', { cursor: null, numItems: 50 }, 'x'.repeat(65)),
    /BAD_ARGUMENT|at most 64/,
  );

  const direct = id => settled.item._handler(s.ctx, { projectId: s.projectId, id });
  for (const item of [...own, abandonedItem]) {
    assert.deepEqual(await direct(item.id), await direct(item.id.slice(0, 8)));
    const linked = JSON.parse((await direct(item.id)).row);
    assert.deepEqual([linked.title, linked.status, linked.doneWhen], [item.title, item.status, [1, 1]]);
  }
  const archived = await add({ status: 'archived' });
  await s.ctx.db.insert('projectReaders', { projectId: s.projectId, reader: 'reader' });
  s.caller('reader');
  assert.equal(JSON.parse((await direct(own[0].id)).row).status, 'closed');
  assert.equal(await direct(archived.id), null);
  assert.equal(await direct(archived.id.slice(0, 8)), null);
  await s.ctx.db.patch(s.projectId, { visibility: 'public' });
  s.caller('visitor');
  assert.equal(await direct(own[0].id), null);
  await s.ctx.db.patch(s.projectId, { visibility: 'private' });

  s.caller('stranger');
  await assert.rejects(settled.settledPage(s.ctx, s.projectId, 'closed', { cursor: null, numItems: 50 }));
});
