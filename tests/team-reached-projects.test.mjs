// SPDX-License-Identifier: Apache-2.0
// Item b6588425 line 4e: a project someone reaches only through a linked team is listed in Account > Projects and in
// the device project picker (known gap recorded after the Team landing, receipt 36e6c449). The read is bounded and
// costs a person in no team nothing; the list re-derives access on every read, so leaving a team, unlinking it or
// deleting it removes the project on the next call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { projectRow, state } from './hosted-fixture.mjs';

const accountProjects = await import(moduleUrl('../convex/accountProjects.ts'));
const contributors = await import(moduleUrl('../convex/projectContributors.ts'));
const reached = await import(moduleUrl('../convex/teamGrant.ts'));
const order = await import(moduleUrl('../convex/accountProjectOrder.ts'));

const first = { paginationOpts: { cursor: null, numItems: 50 } };

function world() {
  const s = state([]);
  s.tables.hostedProjects.clear();
  s.tables.projectTeams ??= new Map();
  const team = (id, owner = 'owner', members = ['mate'], fields = {}) => {
    s.tables.teams.set(id, { _id: id, _creationTime: 1, owner, name: id, operationId: id, ...fields });
    for (const member of members)
      s.tables.teamMembers.set(`${id}:${member}`, {
        _id: `${id}:${member}`,
        teamId: id,
        member,
        handle: null,
      });
  };
  const project = (id, fields = {}) =>
    s.tables.hostedProjects.set(
      id,
      projectRow({ _id: id, key: id, name: id, owner: 'owner', _creationTime: 10, teamLinks: 1, ...fields }),
    );
  const link = (teamId, projectId, role = 'write') =>
    s.tables.projectTeams.set(`${teamId}:${projectId}`, {
      _id: `${teamId}:${projectId}`,
      teamId,
      projectId,
      role,
    });
  return { s, team, project, link };
}
const ids = result => result.page.map(row => row.id);

test('a project reached only through a linked team is listed on the first page with the team role', async () => {
  const { s, team, project, link } = world();
  project('p');
  team('core');
  link('core', 'p', 'read');
  s.caller('mate');
  const result = await accountProjects.list._handler(s.ctx, first);
  assert.deepEqual(
    result.page.map(row => [row.id, row.role]),
    [['p', 'read']],
  );
  // The owner and a stranger see what they saw before.
  s.caller('stranger');
  assert.deepEqual((await accountProjects.list._handler(s.ctx, first)).page, []);
});

test('two teams give the strongest role, and a team of someone else’s, a deleting team and a removed project give nothing', async () => {
  const { s, team, project, link } = world();
  for (const id of ['both', 'foreign-team', 'deleting-team', 'removed']) project(id);
  project('foreign-owner', { owner: 'someone-else' });
  team('a');
  team('b');
  team('theirs', 'someone-else');
  team('going', 'owner', ['mate'], { removal: 'deleting' });
  link('a', 'both', 'read');
  link('b', 'both', 'write');
  link('theirs', 'foreign-team', 'write'); // a link row whose team is not the project owner's grants nothing
  link('going', 'deleting-team', 'write');
  link('a', 'removed', 'write');
  s.tables.hostedProjects.get('removed').removal = 'trash';
  link('a', 'foreign-owner', 'write'); // the team belongs to `owner`, the project to someone else
  s.caller('mate');
  const result = await accountProjects.list._handler(s.ctx, first);
  assert.deepEqual(
    result.page.map(row => [row.id, row.role]),
    [['both', 'write']],
  );
});

test('leaving the team, unlinking it and a project granted directly all stay correct on the next read', async () => {
  const { s, team, project, link } = world();
  project('p');
  project('direct', { _creationTime: 50 });
  team('core');
  link('core', 'p');
  link('core', 'direct', 'read');
  s.tables.projectContributors.set('g', {
    _id: 'g',
    _creationTime: 1,
    projectId: 'direct',
    contributor: 'mate',
  });
  await s.transaction(() => order.syncPersonOrder(s.ctx, 'direct', 'mate'));
  s.caller('mate');
  // `direct` is listed once, from its own order row with the direct role; `p` comes from the team.
  const listed = await accountProjects.list._handler(s.ctx, first);
  assert.deepEqual(
    listed.page.map(row => [row.id, row.role]),
    [
      ['direct', 'write'],
      ['p', 'write'],
    ],
  );
  s.tables.teamMembers.delete('core:mate');
  assert.deepEqual(ids(await accountProjects.list._handler(s.ctx, first)), ['direct']);
  s.tables.teamMembers.set('core:mate', { _id: 'core:mate', teamId: 'core', member: 'mate', handle: null });
  s.tables.projectTeams.delete('core:p');
  assert.deepEqual(ids(await accountProjects.list._handler(s.ctx, first)), ['direct']);
});

test('team-reached projects join the first page by activity and later pages read none', async () => {
  const { s, team, project, link } = world();
  const HOUR = 3_600_000;
  for (let i = 0; i < 3; i++) {
    project(`own-${i}`, { owner: 'mate', _creationTime: (10 + i * 10) * HOUR });
    s.tables.accountProjectOrder.set(`o${i}`, {
      _id: `o${i}`,
      person: 'mate',
      projectId: `own-${i}`,
      role: 'owner',
      activityHour: 10 + i * 10,
    });
  }
  project('via-team', { _creationTime: 15 * HOUR });
  team('core');
  link('core', 'via-team');
  s.caller('mate');
  const page1 = await accountProjects.list._handler(s.ctx, { paginationOpts: { cursor: null, numItems: 2 } });
  assert.deepEqual(
    ids(page1),
    ['own-2', 'own-1', 'via-team'].slice(0, 3),
    'merged in activity order, direct rows keep theirs',
  );
  const page2 = await accountProjects.list._handler(s.ctx, {
    paginationOpts: { cursor: page1.continueCursor, numItems: 2 },
  });
  assert.deepEqual(ids(page2), ['own-0'], 'a later page lists no team project again');
});

test('a person in no team reads one empty range and no document for team reach', async () => {
  const { s, project } = world();
  project('p');
  const seen = { gets: 0, ranges: [] };
  const db = new Proxy(s.ctx.db, {
    get: (target, key) =>
      key === 'get'
        ? (...args) => (seen.gets++, target.get(...args))
        : key === 'query'
          ? table => (seen.ranges.push(table), target.query(table))
          : target[key],
  });
  assert.deepEqual(await reached.teamReachedProjects({ ...s.ctx, db }, 'stranger'), []);
  assert.deepEqual(seen, { gets: 0, ranges: ['teamMembers'] });
});

test('the walk is capped: 40 linked projects across 3 teams read at most the caps, and 25 are returned', async () => {
  const { s, team, project, link } = world();
  for (let i = 0; i < 40; i++) project(`p${i}`);
  for (const id of ['a', 'b', 'c']) team(id);
  for (let i = 0; i < 40; i++) link(['a', 'b', 'c'][i % 3], `p${i}`, i % 2 ? 'read' : 'write');
  const seen = { gets: 0, ranges: 0 };
  const db = new Proxy(s.ctx.db, {
    get: (target, key) =>
      key === 'get'
        ? (...args) => (seen.gets++, target.get(...args))
        : key === 'query'
          ? table => (seen.ranges++, target.query(table))
          : target[key],
  });
  const result = await reached.teamReachedProjects({ ...s.ctx, db }, 'mate');
  assert.equal(result.length, reached.REACHED_PROJECTS);
  // 3 team gets + 25 project gets; 1 membership range + 3 link ranges + 25 own-row lookups.
  assert.deepEqual(seen, { gets: 3 + 25, ranges: 1 + 3 + 25 });
});

test('the device picker lists a team-reached project on its first page once, and not on later pages', async () => {
  const { s, team, project, link } = world();
  for (const id of ['p', 'direct', 'direct-2']) project(id);
  team('core');
  link('core', 'p');
  link('core', 'direct');
  for (const id of ['direct', 'direct-2'])
    s.tables.projectContributors.set(id, { _id: id, _creationTime: 1, projectId: id, contributor: 'mate' });
  s.caller('mate');
  const one = await contributors.shared._handler(s.ctx, { paginationOpts: { cursor: null, numItems: 1 } });
  assert.equal(one.isDone, false);
  assert.equal(new Set(ids(one)).size, ids(one).length, 'no project twice');
  assert.ok(ids(one).includes('p'), 'the team project is on the first page');
  const later = await contributors.shared._handler(s.ctx, {
    paginationOpts: { cursor: one.continueCursor, numItems: 1 },
  });
  assert.equal(ids(later).length, 1);
  assert.ok(!ids(later).includes('p'), 'later pages list no team project');
});

test('a link row on a project that records no team links lists nothing, as authorization would refuse it', async () => {
  const { s, team, project, link } = world();
  project('stale', { teamLinks: 0 });
  team('core');
  link('core', 'stale');
  s.caller('mate');
  assert.deepEqual((await accountProjects.list._handler(s.ctx, first)).page, []);
});

test('the picker lists a team project whose direct grant was removed while its order row stayed', async () => {
  const { s, team, project, link } = world();
  project('p');
  team('core');
  link('core', 'p');
  // Removing the direct grant keeps the person's order row while a team still gives access (accountProjectOrder).
  s.tables.accountProjectOrder.set('o', {
    _id: 'o',
    person: 'mate',
    projectId: 'p',
    role: 'write',
    activityHour: 1,
  });
  s.caller('mate');
  const picker = await contributors.shared._handler(s.ctx, {
    paginationOpts: { cursor: null, numItems: 20 },
  });
  assert.deepEqual(ids(picker), ['p']);
  assert.deepEqual(
    ids(await accountProjects.list._handler(s.ctx, first)),
    ['p'],
    'Account lists it once, from the row',
  );
});

test('a device limited to one project is shown no team project in the picker', async () => {
  const { s, team, project, link } = world();
  project('p');
  team('core');
  link('core', 'p');
  s.caller('mate');
  s.tables.cliCredentials.set('cred', {
    _id: 'cred',
    _creationTime: 1,
    credentialId: 'synthetic-device',
    owner: 'mate',
    name: 'test',
    tokenHash: 'synthetic-hash',
    issuedAt: 1,
    expiresAt: 4_000_000_000_000,
    revoked: false,
    scope: 'cli',
    settings: { projects: { kind: 'project', projectId: 'other' } },
  });
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'mate', forgeCredential: 'synthetic-device' });
  const picker = await contributors.shared._handler(s.ctx, {
    paginationOpts: { cursor: null, numItems: 20 },
  });
  assert.deepEqual(picker.page, []);
});

test('the first page of Account > Projects never holds more than the 100-row page maximum with team projects', async () => {
  const { s, team, project, link } = world();
  for (let i = 0; i < 110; i++) {
    project(`own-${i}`, { owner: 'mate' });
    s.tables.accountProjectOrder.set(`o${i}`, {
      _id: `o${i}`,
      person: 'mate',
      projectId: `own-${i}`,
      role: 'owner',
      activityHour: i,
    });
  }
  for (let i = 0; i < 30; i++) {
    project(`t${i}`);
    link('core', `t${i}`);
  }
  team('core');
  s.caller('mate');
  const result = await accountProjects.list._handler(s.ctx, {
    paginationOpts: { cursor: null, numItems: 100 },
  });
  assert.equal(result.page.length, 100);
  assert.equal(ids(result).filter(id => id.startsWith('t')).length, 25);
});
