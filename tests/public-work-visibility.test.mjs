// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// C1-06: signing in without a project role never widens public plan or Lane-title access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v } from 'convex/values';
import { moduleUrl } from './convex-module.mjs';
import { installPlanningSearch } from './planning-search-fixture.mjs';
import { fixture, id, NOW } from './public-discovery-fixture.mjs';
const plan = await import(moduleUrl('../convex/projectPlanView.ts'));
const work = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const reactions = await import(moduleUrl('../convex/planningReactions.ts'));
const needs = await import(moduleUrl('../convex/projectNeedsMe.ts'));
const search = await import(moduleUrl('../convex/projectHostedPlanningSearch.ts'));
const planning = await import(moduleUrl('../convex/projectHostedPlanning.ts'));
const registrations = await import(moduleUrl('../convex/cliServer.ts'));
const { query } = registrations;
const { finishReadProjection, finishPlanProjectProjection } = await import(
  moduleUrl('../convex/projectFinishReadProjection.ts')
);

function visitor(options = {}) {
  const s = fixture(options);
  s.caller('signed-in-stranger');
  installPlanningSearch(s);
  s.tables.projectBackups.set('backup', {
    _id: 'backup',
    projectId: 'project',
    digest: 'x',
    transport: 'objects',
  });
  return s;
}
const text = value => JSON.stringify(value);
const forbidden =
  /Secret initiative|Under the initiative|Also under it|Private-looking item|Secret Lane title|secret-comment/;

test('every public query registration filters current hidden planning rows and preserves member rows', async () => {
  for (const [name, builder] of Object.entries(registrations)) {
    if (name !== 'query' && (!name.endsWith('Query') || name === 'internalQuery')) continue;
    const endpoint = builder({
      args: { projectId: v.string() },
      returns: v.string(),
      handler: async ctx =>
        JSON.stringify(
          (await ctx.db.query('projectPlanningRecords').take(100)).map(row => JSON.parse(row.value)),
        ),
    });
    const s = visitor({ hidden: [id(1), id(5)] });
    const result = await endpoint._handler(s.ctx, { projectId: 'project' });
    assert.doesNotMatch(result, forbidden, name);
    assert.deepEqual(
      JSON.parse(result).map(row => row.id),
      [id(4)],
      name,
    );
    s.caller('owner');
    const member = JSON.parse(await endpoint._handler(s.ctx, { projectId: 'project' }));
    assert.equal(member.length, s.tables.projectPlanningRecords.size, name);
    assert.match(JSON.stringify(member), /Secret initiative/, name);
  }
});

test('compact authority headers never replace current members-only planning policy', async () => {
  for (const builder of [registrations.finishQuery, registrations.planQuery]) {
    const s = visitor({ planVisibility: 'members' });
    const project = s.tables.hostedProjects.get('project');
    for (const row of [finishReadProjection('hostedProjects', project), finishPlanProjectProjection(project)])
      s.tables.projectFinishReadRows.set(row.kind, { _id: row.kind, ...row });
    const endpoint = builder({
      args: { projectId: v.string() },
      returns: v.string(),
      handler: async ctx =>
        JSON.stringify(
          (await ctx.db.query('projectPlanningRecords').take(100)).map(row => JSON.parse(row.value)),
        ),
    });
    assert.deepEqual(JSON.parse(await endpoint._handler(s.ctx, { projectId: 'project' })), []);
    s.caller('owner');
    assert.equal(JSON.parse(await endpoint._handler(s.ctx, { projectId: 'project' })).length, 5);
  }
});

for (const members of [false, true])
  test(`registered Plan, search, Item, comments and reactions obey ${members ? 'members-only' : 'hidden Item and Initiative'} for a signed-in non-member`, async () => {
    const s = visitor({ ...(members ? { planVisibility: 'members' } : {}), hidden: [id(1), id(5)] });
    // Full legacy Items/comments are separate from the narrow search roots.
    for (const root of s.tables.projectPlanningRecords.values()) {
      const item = JSON.parse(root.value);
      s.tables.projectPlanningRecords.set(`full-${item.id}`, {
        ...root,
        _id: `full-${item.id}`,
        collection: 'planningItems',
        value: JSON.stringify({ ...item, body: item.id === id(4) ? 'public body' : 'secret-comment' }),
      });
    }
    s.tables.projectPlanningRecords.set('comment', {
      _id: 'comment',
      projectId: 'project',
      generationId: 'gen',
      collection: 'planningComments',
      key: 'comment',
      parent: id(5),
      position: 1,
      value: JSON.stringify({ id: 'comment', itemId: id(5), text: 'secret-comment' }),
    });
    const out = await plan.read._handler(s.ctx, { projectId: 'project' });
    const rows = JSON.parse(out.rows);
    assert.doesNotMatch(text(out), forbidden);
    assert.equal(rows.length, members ? 0 : 1);
    const searched = await search.search._handler(s.ctx, {
      projectId: 'project',
      text: id(5).slice(0, 8),
      omittedTerms: 0,
      status: 'all',
      cursor: null,
      limit: 10,
    });
    assert.doesNotMatch(searched, forbidden);
    assert.deepEqual(JSON.parse(searched).items, []);
    const detail = await work.detail._handler(s.ctx, {
      projectId: 'project',
      collection: 'planningItems',
      id: id(5),
    });
    assert.equal(detail.value, null);
    for (const collection of ['planningItems', 'planningComments', 'planningVersions']) {
      const page = await work.records._handler(s.ctx, {
        projectId: 'project',
        collection,
        ...(collection === 'planningItems' ? {} : { parentId: id(5) }),
        paginationOpts: { numItems: 100, cursor: null },
      });
      assert.doesNotMatch(text(page), forbidden);
      if (members || collection !== 'planningItems') assert.deepEqual(page.page, []);
    }
    assert.deepEqual(await reactions.forItem._handler(s.ctx, { projectId: 'project', itemId: id(5) }), {
      counts: [],
      complete: true,
    });
    const resolved = JSON.parse(
      await planning.resolveId._handler(s.ctx, { projectId: 'project', prefix: id(5).slice(0, 8) }),
    );
    assert.deepEqual(resolved.ids, []);
  });

test('Needs me and future registered reads redact Lane titles and hold notes unless opted in', async () => {
  const s = visitor();
  s.tables.projectHostedPresence.set('presence', {
    _id: 'presence',
    projectId: 'project',
    laneId: 'lane-2',
    actor: 'owner',
    goal: 'Secret Lane title',
    at: NOW,
  });
  const out = await needs.read._handler(s.ctx, { projectId: 'project' });
  assert.equal(out.held.length, 1);
  assert.equal(out.held[0].title, '');
  const future = query({
    args: { projectId: v.string() },
    returns: v.string(),
    handler: async ctx => {
      await ctx.db.query('projectLiveLineLanes').take(1);
      return JSON.stringify({
        held: [{ laneId: 'lane-2', title: 'Secret Lane title', note: 'secret-comment' }],
      });
    },
  });
  const read = () => future._handler(s.ctx, { projectId: 'project' });
  assert.doesNotMatch(await read(), forbidden);
  s.tables.projectPublic.get('public').laneTitles = true;
  assert.match(await read(), /Secret Lane title/);
  s.tables.projectPublic.get('public').laneTitles = false;
  s.caller('owner');
  assert.match(await read(), /Secret Lane title/);
});

test('registration guard applies current visibility to body, comment and version encodings; members keep exact results', async () => {
  const s = visitor({ hidden: [id(1)] });
  const payload = {
    collection: 'planningVersions',
    record: {
      id: 'version',
      value: { item: { id: id(2), kind: 'issue', title: 'Under the initiative', body: 'secret-comment' } },
    },
  };
  const endpoint = query({
    args: { projectId: v.string(), request: v.string() },
    returns: v.string(),
    handler: async ctx => {
      await ctx.db.query('projectPlanningRecords').take(1);
      return JSON.stringify(payload);
    },
  });
  const args = {
    projectId: 'project',
    request: JSON.stringify({ collection: 'planningVersions', id: id(2) }),
  };
  assert.equal(JSON.parse(await endpoint._handler(s.ctx, args)).record, null);
  s.tables.projectReaders.set('reader', {
    _id: 'reader',
    projectId: 'project',
    reader: 'signed-in-stranger',
  });
  assert.equal(await endpoint._handler(s.ctx, args), JSON.stringify(payload));
});

test('source bytes and member prose never select a public Work policy from their JSON content', async () => {
  const s = visitor();
  const source = '{ "kind": "issue", "id": "unknown", "title": "source title", "laneId": "x" }';
  const endpoint = query({
    args: { projectId: v.string() },
    returns: v.string(),
    handler: async ctx => {
      await ctx.db.get('project');
      return source;
    },
  });
  assert.equal(await endpoint._handler(s.ctx, { projectId: 'project' }), source);
  const prose = query({
    args: { projectId: v.string() },
    returns: v.string(),
    handler: async ctx => {
      await ctx.db.query('projectPlanningRecords').take(1);
      return JSON.stringify({ kind: 'issue', id: id(4), body: source });
    },
  });
  assert.equal(JSON.parse(await prose._handler(s.ctx, { projectId: 'project' })).body, source);
});

for (const collection of ['issues', 'comments'])
  test(`hosted ${collection} descriptors use current Item visibility`, async () => {
    const s = visitor({ hidden: [id(5)] });
    let selectedId = id(5);
    const endpoint = query({
      args: { projectId: v.string(), request: v.string() },
      returns: v.string(),
      handler: async ctx => {
        await ctx.db.query('projectPlanningRecords').take(1);
        return JSON.stringify({
          collection,
          items: [
            {
              id: collection === 'issues' ? selectedId : 'comment',
              kind: collection === 'issues' ? 'issue' : 'comment',
              parentId: selectedId,
              source: { digest: 'x' },
            },
          ],
        });
      },
    });
    const args = { projectId: 'project', request: JSON.stringify({ collection }) };
    assert.deepEqual(JSON.parse(await endpoint._handler(s.ctx, args)).items, []);
    selectedId = id(4);
    assert.equal(JSON.parse(await endpoint._handler(s.ctx, args)).items.length, 1);
  });

test('workspace omits member aggregate planning totals instead of exposing hidden counts', async () => {
  const s = visitor({ hidden: [id(1), id(5)] });
  s.tables.projectWorkGenerations.get('gen').metadata = JSON.stringify({
    schema: 24,
    counts: { planningItems: 5, planningComments: 99, lanes: 2 },
  });
  const endpoint = query({
    args: { projectId: v.string() },
    returns: v.string(),
    handler: async ctx => {
      const generation = await ctx.db.get('gen');
      return generation.metadata;
    },
  });
  const result = JSON.parse(await endpoint._handler(s.ctx, { projectId: 'project' }));
  assert.deepEqual(result.counts, { lanes: 2 });
});

test('a public Item beyond two thousand roots remains readable without scanning the board', async () => {
  const s = visitor();
  const row = {
    ...s.tables.projectPlanningRecords.get('plan3'),
    _id: 'last',
    key: id(9000),
    value: JSON.stringify({ id: id(9000), kind: 'issue', status: 'open', title: 'Last public Item' }),
  };
  for (let n = 100; n < 2300; n++)
    s.tables.projectPlanningRecords.set(`filler-${n}`, {
      ...row,
      _id: `filler-${n}`,
      key: id(n),
      value: JSON.stringify({ id: id(n), kind: 'issue', status: 'open', title: 'Other public Item' }),
    });
  s.tables.projectPlanningRecords.set('last', row);
  const endpoint = query({
    args: { projectId: v.string() },
    returns: v.string(),
    handler: async ctx => {
      await ctx.db.get('last');
      return JSON.stringify({ items: [JSON.parse(row.value)] });
    },
  });
  assert.equal(
    JSON.parse(await endpoint._handler(s.ctx, { projectId: 'project' })).items[0].title,
    'Last public Item',
  );
});

test('compact Plan availability never bypasses visibility for signed-in non-members', async () => {
  const s = visitor({ hidden: [id(1), id(5)] });
  s.tables.projectWorkGenerations.get('gen').planRowsVersion = 1;
  const closed = {
    ...JSON.parse(s.tables.projectPlanningRecords.get('plan3').value),
    id: id(6),
    status: 'closed',
    initiativeId: id(1),
    title: 'Hidden completed Item',
  };
  s.tables.projectPlanningRecords.set('closed', {
    ...s.tables.projectPlanningRecords.get('plan3'),
    _id: 'closed',
    key: closed.id,
    value: JSON.stringify(closed),
    planning: { kind: 'issue', status: 'closed', initiativeId: id(1), open: false, text: closed.title },
  });
  const out = await plan.read._handler(s.ctx, { projectId: 'project' });
  assert.deepEqual(
    JSON.parse(out.rows).map(row => row.id),
    [id(4)],
  );
  assert.deepEqual(out.settled, []);
  s.tables.hostedProjects.get('project').planVisibility = 'members';
  assert.deepEqual(await plan.read._handler(s.ctx, { projectId: 'project' }), {
    rows: '[]',
    more: false,
    settled: [],
    canEdit: false,
  });
});

test('registration refuses unfilterable internal Plan bytes for role-less viewers even without collection arguments', async () => {
  const s = visitor({ hidden: [id(1)] });
  s.tables.projectWorkDataRecords.set('projection', {
    _id: 'projection',
    projectId: 'project',
    generationId: 'gen',
    collection: '_workStorePlan',
    key: 'page',
    parent: 'issue:open',
    position: 0,
    value: 'compressed-member-data',
  });
  const endpoint = query({
    args: { projectId: v.string() },
    returns: v.string(),
    handler: async ctx => (await ctx.db.query('projectWorkDataRecords').take(1))[0].value,
  });
  await assert.rejects(
    endpoint._handler(s.ctx, { projectId: 'project' }),
    error => JSON.parse(error.message).code === 'PROJECT_UNAVAILABLE',
  );
  s.caller('owner');
  assert.equal(await endpoint._handler(s.ctx, { projectId: 'project' }), 'compressed-member-data');
});

test('read members retain compact Plan rows including hidden Items', async () => {
  const s = visitor({ hidden: [id(1), id(5)] });
  const compact = await import(moduleUrl('../convex/projectPlanRows.ts'));
  s.tables.projectWorkGenerations.get('gen').planRowsVersion = 1;
  s.tables.projectReaders.set('reader', {
    _id: 'reader',
    projectId: 'project',
    reader: 'signed-in-stranger',
  });
  const groups = new Map();
  for (const root of s.tables.projectPlanningRecords.values()) {
    const row = plan.planViewRow(JSON.parse(root.value), root.position);
    const parent = compact.planParent(row.kind, row.status, row.initiativeId);
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(row);
  }
  for (const [parent, rows] of groups)
    s.tables.projectWorkDataRecords.set(parent, {
      _id: parent,
      projectId: 'project',
      generationId: 'gen',
      collection: compact.PLAN_ROWS,
      key: parent,
      parent,
      position: 0,
      value: compact.encodePlanPage(rows),
    });
  const dbQuery = s.ctx.db.query;
  s.ctx.db.query = table => {
    assert.notEqual(table, 'projectPlanningRecords', 'members keep the compact path');
    return dbQuery(table);
  };
  const out = await plan.read._handler(s.ctx, { projectId: 'project' });
  assert.equal(JSON.parse(out.rows).length, 5);
  assert.equal(JSON.parse(out.rows).filter(row => row.hidden).length, 2);
});
