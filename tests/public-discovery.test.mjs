// SPDX-License-Identifier: Apache-2.0
// Public discovery (Items 8947a779, 76be0714, 6a60e89a, 875a4b60): what a visitor may read, and who may star.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { state, projectRow } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const visibility = await import(moduleUrl('../convex/publicVisibility.ts'));
const discovery = await import(moduleUrl('../convex/publicDiscovery.ts'));
const read = await import(moduleUrl('../convex/publicRead.ts'));
const route = await import(moduleUrl('../convex/publicHttp.ts'));
const meta = await import(moduleUrl('../src/public-meta.ts'));

const NOW = Date.UTC(2026, 10, 17, 12);
const id = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

function fixture({ projectVisibility = 'public', laneTitles, planVisibility, hidden = [] } = {}) {
  const s = state([]);
  s.tables.hostedProjects.set(
    'project',
    projectRow({
      _id: 'project',
      _creationTime: NOW - 30 * 86_400_000,
      owner: 'owner',
      name: 'atlas',
      slug: 'atlas',
      visibility: projectVisibility,
      work: { generationId: 'gen', backupId: 'backup', operationId: 'op', initialRevision: 0, revision: 0 },
    }),
  );
  // The planning contract's project setting (d3357f40); set past the schema until that field is on main.
  if (planVisibility) s.tables.hostedProjects.get('project').planVisibility = planVisibility;
  s.tables.forgeAccounts.set('acct', { _id: 'acct', owner: 'owner', handle: 'ada' });
  s.tables.accountHandles.set('alias', { _id: 'alias', owner: 'owner', handle: 'ada' });
  s.tables.projectSlugs.set('slug', { _id: 'slug', owner: 'owner', slug: 'atlas', projectId: 'project' });
  s.tables.projectWorkGenerations.set('gen', {
    _id: 'gen',
    projectId: 'project',
    backupId: 'backup',
    format: 11,
    status: 'ready',
    metadata: '{"schema":24}',
  });
  s.tables.projectPublic.set('public', {
    _id: 'public',
    _creationTime: NOW - 86_400_000,
    projectId: 'project',
    owner: 'owner',
    listed: projectVisibility === 'public',
    stars: 0,
    ...(laneTitles ? { laneTitles } : {}),
  });
  // Plan: an Initiative with two Items, a loose Item, and an Item someone may hide.
  const plan = [
    { id: id(1), kind: 'initiative', status: 'open', title: 'Secret initiative' },
    { id: id(2), kind: 'issue', status: 'open', title: 'Under the initiative', initiativeId: id(1) },
    { id: id(3), kind: 'issue', status: 'in-progress', title: 'Also under it', initiativeId: id(1) },
    { id: id(4), kind: 'issue', status: 'open', title: 'Loose planned item' },
    { id: id(5), kind: 'issue', status: 'proposed', title: 'Private-looking item' },
  ];
  plan.forEach((item, position) =>
    s.tables.projectPlanningRecords.set(`plan${position}`, {
      _id: `plan${position}`,
      projectId: 'project',
      generationId: 'gen',
      collection: 'planningSearch',
      key: item.id,
      parent: '',
      position,
      value: JSON.stringify({
        ...item,
        initiativeId: item.initiativeId ?? null,
        ...(hidden.includes(item.id) ? { hidden: true } : {}),
      }),
      planning: {
        text: item.title,
        kind: item.kind,
        status: item.status,
        initiativeId: item.initiativeId ?? '',
        open: true,
      },
    }),
  );
  for (const [n, stage] of [
    [1, 'editing'],
    [2, 'checking'],
  ])
    s.tables.projectLiveLineLanes.set(`mark${n}`, {
      _id: `mark${n}`,
      projectId: 'project',
      sourceId: `source${n}`,
      laneId: `lane-${n}`,
      stage,
      held: n === 2,
      overlap: false,
      changedAt: NOW,
    });
  s.tables.projectWorkRecords.set('laneRecord1', {
    _id: 'laneRecord1',
    projectId: 'project',
    generationId: 'gen',
    collection: 'lanes',
    key: 'lane-1',
    parent: '',
    position: 0,
    value: JSON.stringify({ id: 'lane-1', name: 'Secret Lane title' }),
  });
  s.ctx.runQuery = s.ctx.runMutation = (ref, args) => {
    const [module, fn] = getFunctionName(ref).split(':');
    return { publicRead: read }[module][fn]._handler(s.ctx, args);
  };
  return s;
}
/** Convex errors carry the structured code and message as JSON. */
const refused = async (promise, code, message = /./) =>
  assert.rejects(promise, error => {
    const body = JSON.parse(error.message);
    assert.equal(body.code, code);
    assert.match(body.message, message);
    return true;
  });
const page = s => read.projectPage._handler(s.ctx, { handle: 'ada', slug: 'atlas', now: NOW });
const everyPublicRead = async s => [
  JSON.stringify(await page(s)),
  JSON.stringify(await read.explorePage._handler(s.ctx, { order: 'active', now: NOW })),
  JSON.stringify(await read.profilePage._handler(s.ctx, { handle: 'ada', now: NOW })),
  JSON.stringify(await read.sitemapRows._handler(s.ctx, {})),
];

test('the plan is public by default on a public project and the next Item is the first Planned one', async () => {
  const body = await page(fixture());
  assert.equal(body.plan.shown, true);
  assert.equal(body.plan.left, 4);
  assert.equal(body.plan.inProgress, 1);
  assert.deepEqual(
    body.plan.next.map(item => item.title),
    ['Under the initiative', 'Loose planned item'],
  );
  assert.deepEqual(body.plan.initiatives, [
    { id: id(1), title: 'Secret initiative', left: 2, inProgress: 1 },
  ]);
});

test('a members-only plan shows nothing of the plan to visitors, counts included', async () => {
  const s = fixture({ planVisibility: 'members' });
  const body = await page(s);
  assert.deepEqual(body.plan, { shown: false });
  for (const text of await everyPublicRead(s))
    assert.doesNotMatch(text, /Secret initiative|Loose planned|Under the/);
});

test('a hidden Item is absent from every public read and from the Left count', async () => {
  const s = fixture({ hidden: [id(5)] });
  const body = await page(s);
  assert.equal(body.plan.left, 3);
  for (const text of await everyPublicRead(s)) assert.doesNotMatch(text, /Private-looking item/);
});

test('a hidden Initiative hides itself and every Item under it, and unhiding restores them', async () => {
  const s = fixture({ hidden: [id(1)] });
  const hidden = await page(s);
  assert.equal(hidden.plan.left, 2);
  assert.equal(hidden.plan.inProgress, 0);
  assert.deepEqual(hidden.plan.initiatives, []);
  for (const text of await everyPublicRead(s))
    assert.doesNotMatch(text, /Secret initiative|Under the initiative|Also under it/);
  // Unhiding (the planning contract's put clears `hidden`) makes the plan whole again: hiding is reversible.
  for (const row of s.tables.projectPlanningRecords.values()) {
    const value = JSON.parse(row.value);
    delete value.hidden;
    row.value = JSON.stringify(value);
  }
  assert.equal((await page(s)).plan.left, 4);
});

test('the visibility rule hides sub-items of a hidden Item and fails closed on an unknown parent', () => {
  const rows = [
    { id: 'a', kind: 'issue', hidden: true },
    { id: 'b', kind: 'issue', parentId: 'a' },
    { id: 'c', kind: 'issue', parentId: 'gone' },
    { id: 'd', kind: 'issue', initiativeId: 'i' },
    { id: 'e', kind: 'issue' },
  ];
  const known = new Map([...rows, { id: 'i', kind: 'initiative', hidden: true }].map(row => [row.id, row]));
  const shown = project => visibility.visiblePlan(project, rows, known).map(row => row.id);
  assert.deepEqual(shown({ visibility: 'public' }), ['e']);
  assert.deepEqual(shown({ visibility: 'public', planVisibility: 'members' }), []);
  assert.deepEqual(shown({ visibility: 'private' }), []);
  assert.deepEqual(shown({ visibility: 'public', removal: 'trash' }), []);
});

test('open Lane titles reach visitors only when the project opts in, and Lane ids never do', async () => {
  const closed = fixture();
  const counts = await page(closed);
  assert.equal(counts.lanes.open, 2);
  assert.equal(counts.lanes.held, 1);
  assert.deepEqual(counts.lanes.titles, []);
  for (const text of await everyPublicRead(closed))
    assert.doesNotMatch(text, /Secret Lane title|lane-1|lane-2/);
  const open = await page(fixture({ laneTitles: true }));
  assert.deepEqual(open.lanes.titles, [
    { stage: 'editing', title: 'Secret Lane title' },
    { stage: 'checking' },
  ]);
  assert.doesNotMatch(JSON.stringify(open), /lane-1|lane-2/);
});

test('a private project answers exactly like a missing one on every public read', async () => {
  const s = fixture({ projectVisibility: 'private' });
  assert.equal(await page(s), null);
  assert.equal(await read.projectPage._handler(s.ctx, { handle: 'ada', slug: 'nothing', now: NOW }), null);
  for (const text of await everyPublicRead(s)) assert.doesNotMatch(text, /atlas|Secret/);
  const profile = await read.profilePage._handler(s.ctx, { handle: 'ada', now: NOW });
  assert.deepEqual(profile.projects, []);
  // The route gives both the same 404 body.
  const ctx = { runQuery: s.ctx.runQuery, runMutation: s.ctx.runMutation };
  const serve = route.serve._handler ?? route.serve;
  for (const path of ['/public/v1/project/ada/atlas.json', '/public/v1/project/ada/nothing.json']) {
    const response = await serve(ctx, new Request(`https://backend.test${path}`));
    assert.equal(response.status, 404);
    assert.equal(await response.text(), '{"found":false}');
  }
});

test('public reads name no actor: only the owner handle that is already in the address', async () => {
  const s = fixture();
  s.tables.projectHostedAcceptances.set('acc', {
    _id: 'acc',
    _creationTime: NOW - 3_600_000,
    projectId: 'project',
    value: JSON.stringify({ actor: { id: 'secret-person' } }),
  });
  const body = await page(s);
  assert.equal(body.activity.landings, 1);
  assert.equal(body.activity.main, 'unchecked');
  for (const text of await everyPublicRead(s)) assert.doesNotMatch(text, /secret-person|"owner"/);
});

test('signed out, as an agent, or on a private project a star is refused with the step to take', async () => {
  const s = fixture();
  s.caller(null);
  await refused(
    discovery.star._handler(s.ctx, { projectId: 'project', starred: true }),
    'AUTH_REQUIRED',
    /Sign in to star/,
  );
  s.tables.cliCredentials.set('cred', {
    _id: 'cred',
    credentialId: 'cred',
    owner: 'agent-person',
    scope: 'cli',
    revoked: false,
    expiresAt: NOW * 2,
  });
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'agent-person', forgeCredential: 'cred' });
  await refused(
    discovery.star._handler(s.ctx, { projectId: 'project', starred: true }),
    'AUTH_SCOPE_DENIED',
    /agents cannot star/,
  );
  await refused(
    discovery.setSettings._handler(s.ctx, { projectId: 'project', laneTitles: true }),
    'PROJECT_UNAVAILABLE',
  );
  const closed = fixture({ projectVisibility: 'private' });
  closed.caller('someone');
  await refused(
    discovery.star._handler(closed.ctx, { projectId: 'project', starred: true }),
    'PROJECT_UNAVAILABLE',
  );
});

test('one star per person: repeating it changes nothing, and the count moves with the star row', async () => {
  const s = fixture();
  s.caller('reader');
  assert.deepEqual(await discovery.star._handler(s.ctx, { projectId: 'project', starred: true }), {
    starred: true,
    stars: 1,
  });
  assert.deepEqual(await discovery.star._handler(s.ctx, { projectId: 'project', starred: true }), {
    starred: true,
    stars: 1,
  });
  assert.deepEqual(await discovery.myStars._handler(s.ctx, {}), ['project']);
  assert.equal((await page(s)).stars, 1);
  assert.deepEqual(await discovery.star._handler(s.ctx, { projectId: 'project', starred: false }), {
    starred: false,
    stars: 0,
  });
  assert.equal([...s.tables.projectStars.values()].length, 0);
});

test('only the owner person changes what visitors see, and only the owner sees who starred', async () => {
  const s = fixture();
  s.tables.forgeAccounts.set('acct2', { _id: 'acct2', owner: 'reader', handle: 'wren' });
  s.caller('reader');
  await discovery.star._handler(s.ctx, { projectId: 'project', starred: true });
  await refused(
    discovery.setSettings._handler(s.ctx, { projectId: 'project', laneTitles: true }),
    'PROJECT_UNAVAILABLE',
  );
  await refused(
    discovery.stargazers._handler(s.ctx, {
      projectId: 'project',
      paginationOpts: { numItems: 10, cursor: null },
    }),
    'PROJECT_UNAVAILABLE',
  );
  s.caller('owner');
  const gazers = await discovery.stargazers._handler(s.ctx, {
    projectId: 'project',
    paginationOpts: { numItems: 10, cursor: null },
  });
  assert.deepEqual(gazers.page, [{ handle: 'wren' }]);
  const settings = await discovery.setSettings._handler(s.ctx, { projectId: 'project', laneTitles: true });
  assert.deepEqual(settings, { laneTitles: true, stars: 1 });
  assert.equal((await page(s)).lanes.titles[0].title, 'Secret Lane title');
  await discovery.setSettings._handler(s.ctx, { projectId: 'project', laneTitles: false });
  assert.deepEqual((await page(s)).lanes.titles, []);
});

test('public addresses parse strictly and the sitemap escapes what it lists', () => {
  assert.deepEqual(route.publicPath('/public/v1/project/ada/atlas.json'), {
    kind: 'project',
    handle: 'ada',
    slug: 'atlas',
  });
  assert.deepEqual(route.publicPath('/public/v1/explore/stars.json'), { kind: 'explore', order: 'stars' });
  for (const bad of [
    '/public/v1/project/ada/atlas',
    '/public/v1/project/../x.json',
    '/public/v1/explore/all.json',
    '/public/v1/profile/a/b.json',
  ])
    assert.equal(route.publicPath(bad), null, bad);
  const xml = route.sitemapXml('https://forge.test', [{ handle: 'ada', slug: 'a&b' }]);
  assert.match(xml, /<loc>https:\/\/forge\.test\/-\/ada\/a%26b<\/loc>/);
  assert.match(xml, /<loc>https:\/\/forge\.test\/-\/explore<\/loc>/);
});

test('share tags describe the page from the public read and add no script', () => {
  const html = '<html><head><title>App</title><script>theme()</script></head><body></body></html>';
  const out = meta.withMeta(
    html,
    meta.projectMeta('https://forge.test', {
      project: { handle: 'ada', slug: 'atlas', name: 'at"las' },
      stars: 3,
      activity: { landings: 12, main: 'passing' },
      plan: { shown: false },
      lanes: { open: 2 },
    }),
  );
  assert.match(out, /<title>ada\/at&quot;las · Forge<\/title>/);
  assert.match(out, /property="og:url" content="https:\/\/forge\.test\/-\/ada\/atlas"/);
  assert.match(out, /Main is passing\. 12 changes landed this week\. 2 Lanes open\. 3 stars\./);
  assert.doesNotMatch(out, /Items left/);
  assert.equal(out.match(/<script/g).length, 1);
});

test('profile and explore share tags count only what the public read lists', () => {
  const profile = meta.profileMeta('https://forge.test', { handle: 'ada', projects: [{}, {}] });
  assert.equal(profile.kind, 'profile');
  assert.equal(profile.description, '2 public projects by @ada on Forge.');
  assert.equal(profile.url, 'https://forge.test/-/ada');
  const explore = meta.exploreMeta('https://forge.test', { total: 1, more: true });
  assert.match(explore.description, /^1 public project and more on Forge/);
});

test('the listed-project backfill lists public projects only and is safe to repeat', async () => {
  const s = fixture();
  s.tables.projectPublic.clear();
  s.tables.hostedProjects.set(
    'private',
    projectRow({ _id: 'private', owner: 'owner', name: 'p', slug: 'p', visibility: 'private' }),
  );
  for (let round = 0; round < 2; round++) {
    const result = await discovery.backfillListed._handler(s.ctx, { cursor: null });
    assert.deepEqual([result.listed, result.isDone], [1, true]);
  }
  const rows = [...s.tables.projectPublic.values()];
  assert.deepEqual(
    rows.map(row => [row.projectId, row.listed]),
    [['project', true]],
  );
});
