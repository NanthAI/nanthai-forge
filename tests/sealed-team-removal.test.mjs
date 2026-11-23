// SPDX-License-Identifier: Apache-2.0
// Item 41a0df87 "Team removal": a team change that takes write access away marks the writer's sealed entries the
// same way a direct removal does (design 5.5, docs/security.d/sections/1220-sealed-removal.md), and never marks a
// writer who still writes through a direct grant or another write team. Real team, team-access, account-cleanup and
// sealed Convex modules on a synthetic hosted project; synthetic keys and values only.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { setup } from './helpers/sealed-hosted.mjs';
import { device, owner } from './helpers/sealed-devices.mjs';
import { digest } from '../dist/state/hash.js';

const teams = await import(moduleUrl('../convex/teams.ts'));
const teamAccess = await import(moduleUrl('../convex/projectTeamAccess.ts'));
const lifecycle = await import(moduleUrl('../convex/teamLifecycle.ts'));
const accountExecute = await import(moduleUrl('../convex/accountExecute.ts'));
const markers = await import(moduleUrl('../convex/sealedSecretMarkers.ts'));
const { metadataBytes } = await import(moduleUrl('../convex/accountMetadata.ts'));
const code = expected => error => (error.code ?? error.data?.code) === expected;
const VALUE = Buffer.from('synthetic-team-removal-value-0123456789');
const clear = result => {
  result?.key?.fill(0);
  for (const secret of result?.secrets ?? []) secret.value.fill(0);
};
const set = h => [...h.s.tables.sealedSecretSets.values()].find(r => r.active);
const marks = h => (set(h)?.revoked ?? []).map(id => Buffer.from(id).toString('hex')).sort();
const ids = (...devices) => devices.map(d => d.keys.id.toString('hex')).sort();
/** Members with no sealed entry that sort before the fixture writers: more than one marking step of them. */
const FILLERS = Array.from({ length: 150 }, (_, i) => `fixture-a${String(i).padStart(3, '0')}`);

/** A team of the project owner linked to the project with `role`. Its creator is a member, as `teams.create` makes
 * it, so every account the set lists can be on the team (the member scan stops once it has seen them all). */
function team(h, id, members, role = 'write') {
  for (const table of ['teams', 'teamMembers', 'projectTeams']) h.s.tables[table] ??= new Map();
  h.s.tables.teams.set(id, {
    _id: id,
    _creationTime: 1,
    owner: h.account,
    name: id,
    operationId: randomUUID(),
  });
  for (const member of [h.account, ...members])
    h.s.tables.teamMembers.set(`${id}-${member}`, {
      _id: `${id}-${member}`,
      _creationTime: 1,
      teamId: id,
      member,
    });
  h.s.tables.projectTeams.set(`${id}-link`, {
    _id: `${id}-link`,
    _creationTime: 1,
    projectId: h.project,
    teamId: id,
    role,
  });
  const project = h.s.tables.hostedProjects.get(h.project);
  project.teamLinks = (project.teamLinks ?? 0) + 1;
}
/** Runs as a signed-in person in the browser (team management is person-only). */
async function asPerson(h, subject, run) {
  const saved = { ...h.identity };
  for (const key of Object.keys(h.identity)) delete h.identity[key];
  h.identity.subject = subject;
  try {
    return await h.s.transaction(run);
  } finally {
    for (const key of Object.keys(h.identity)) delete h.identity[key];
    Object.assign(h.identity, saved);
  }
}
/** A writer whose device joined Development automatically and read its values. */
async function joined(h, t, o, account, member) {
  const m = device(h, t, account, { member });
  await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
  clear(await o.client.read());
  clear(await m.client.read());
  return m;
}
const revision = h => h.s.tables.hostedProjects.get(h.project).teamRevision ?? 0;
const setRole = (h, teamId, role) =>
  asPerson(h, h.account, () =>
    teamAccess.set._handler(h.s.ctx, { projectId: h.project, teamId, role, revision: revision(h) }),
  );
const deleteTeam = (h, id) =>
  asPerson(h, h.account, () =>
    lifecycle.permanentlyDelete._handler(h.s.ctx, { id, operationId: randomUUID(), expectedCreation: 1 }),
  );
/** Runs the team's purge until it is done, as the scheduler would; returns how many runs it took. */
async function purge(h, id) {
  let runs = 0;
  while (h.s.tables.teams.get(id).removal !== 'deleted') {
    assert(++runs < 20, 'the purge finishes');
    await h.s.transaction(() => lifecycle.purge._handler(h.s.ctx, { id }));
  }
  return runs;
}
/** The person leaves the team through Your data: one hidden cleanup item, run by the real account step. */
async function leave(h, teamId, member) {
  for (const table of ['accountOperations', 'accountItems']) h.s.tables[table] ??= new Map();
  const operationId = randomUUID(),
    resourceId = `${teamId}-${member}`;
  h.s.tables.accountOperations.set('op', {
    _id: 'op',
    _creationTime: 1,
    owner: member,
    operationId,
    request: 'f'.repeat(64),
    expectedItems: 1,
    leave: ['teams'],
    stage: 'running',
    captured: ['teams'],
    pending: 1,
    at: 1,
  });
  h.s.tables.accountItems.set('item', {
    _id: 'item',
    _creationTime: 1,
    owner: member,
    accountId: 'op',
    key: `teams:${resourceId}`,
    kind: 'teams',
    resourceId,
    pin: digest(metadataBytes(h.s.tables.teamMembers.get(resourceId))),
    operationId,
    hidden: true,
    state: 'pending',
  });
  const result = await asPerson(h, member, () =>
    accountExecute.step._handler(h.s.ctx, { operationId, itemId: 'item' }),
  );
  assert.equal(result.state, 'completed');
  assert(!h.s.tables.teamMembers.has(resourceId));
}

test('Done-when team removal: removing a team-only writer from the team marks them; a member with a direct grant is not marked', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  team(h, 'crew', ['fixture-solo', 'fixture-both']);
  const solo = await joined(h, t, o, 'fixture-solo', false),
    both = await joined(h, t, o, 'fixture-both', true);
  await asPerson(h, h.account, () =>
    teams.removeMember._handler(h.s.ctx, { id: 'crew', member: 'fixture-solo' }),
  );
  assert.deepEqual(marks(h), ids(solo));
  await assert.rejects(solo.client.read(), code('PROJECT_UNAVAILABLE'));
  // Still writes through the direct grant: kept, and keeps reading.
  await asPerson(h, h.account, () =>
    teams.removeMember._handler(h.s.ctx, { id: 'crew', member: 'fixture-both' }),
  );
  assert.deepEqual(marks(h), ids(solo));
  clear(await both.client.read());
});

test('Done-when team removal: lowering a team to read or unlinking it marks members who lose write, not those another write team keeps', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  team(h, 'crew', ['fixture-solo', 'fixture-dual']);
  team(h, 'other', ['fixture-dual']);
  const solo = await joined(h, t, o, 'fixture-solo', false),
    dual = await joined(h, t, o, 'fixture-dual', false);
  await setRole(h, 'crew', 'read');
  assert.deepEqual(marks(h), ids(solo));
  clear(await dual.client.read());
  // Unlinking the other write team leaves dual with read through crew only: now marked too.
  await setRole(h, 'other', null);
  assert.deepEqual(marks(h), ids(solo, dual));
  await assert.rejects(dual.client.read(), code('PROJECT_UNAVAILABLE'));
});

test('Done-when team removal: leaving a team through Your data marks the person where nothing else gives write', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  team(h, 'crew', ['fixture-solo']);
  const solo = await joined(h, t, o, 'fixture-solo', false);
  await leave(h, 'crew', 'fixture-solo');
  assert.deepEqual(marks(h), ids(solo));
});

test('review 2: leaving a team that is being deleted, before its purge, still marks the person', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  team(h, 'crew', ['fixture-solo']);
  const solo = await joined(h, t, o, 'fixture-solo', false);
  await deleteTeam(h, 'crew');
  await leave(h, 'crew', 'fixture-solo');
  assert.deepEqual(marks(h), ids(solo));
  await purge(h, 'crew');
  assert.deepEqual(marks(h), ids(solo));
});

test('Done-when team removal: deleting a team stops its write at once and its purge marks members who lost it', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  team(h, 'crew', ['fixture-solo', 'fixture-both']);
  const solo = await joined(h, t, o, 'fixture-solo', false),
    both = await joined(h, t, o, 'fixture-both', true);
  await deleteTeam(h, 'crew');
  await assert.rejects(solo.client.read(), code('PROJECT_UNAVAILABLE'));
  await purge(h, 'crew');
  assert.deepEqual(marks(h), ids(solo));
  assert.equal(h.s.tables.hostedProjects.get(h.project).teamLinks, 0);
  clear(await both.client.read());
});

test('review 1: a deleted team larger than one step is marked across purge runs, and its link goes only after', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  team(h, 'crew', [...FILLERS, 'fixture-solo', 'fixture-both']);
  const solo = await joined(h, t, o, 'fixture-solo', false),
    both = await joined(h, t, o, 'fixture-both', true);
  await deleteTeam(h, 'crew');
  // The first run reads one step of members (fillers only), keeps its place and keeps the link.
  await h.s.transaction(() => lifecycle.purge._handler(h.s.ctx, { id: 'crew' }));
  assert.deepEqual(marks(h), []);
  assert(h.s.tables.projectTeams.has('crew-link'));
  assert.equal(h.s.tables.teams.get('crew').marking.link, 'crew-link');
  await purge(h, 'crew');
  assert.deepEqual(marks(h), ids(solo));
  assert.equal(h.s.tables.teams.get('crew').marking, undefined);
  assert.equal(h.s.tables.hostedProjects.get(h.project).teamLinks, 0);
  clear(await both.client.read());
});

test('review 1: unlinking a team larger than one step marks the rest in scheduled steps', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  team(h, 'crew', [...FILLERS, 'fixture-solo']);
  const solo = await joined(h, t, o, 'fixture-solo', false);
  const before = h.s.scheduled.length;
  await setRole(h, 'crew', null);
  assert.deepEqual(marks(h), []);
  const steps = h.s.scheduled.slice(before);
  assert.equal(steps.length, 1);
  await h.s.transaction(() => markers.markTeam._handler(h.s.ctx, steps[0].args));
  assert.deepEqual(marks(h), ids(solo));
  assert.equal(h.s.scheduled.length, before + 1, 'the last step schedules nothing more');
});

test('cost: a team change on a project with no sealed set reads three empty set ranges and no team member or project row', async t => {
  const h = setup(t);
  team(h, 'crew', ['fixture-solo']);
  team(h, 'viewers', ['fixture-solo'], 'read');
  const queried = [],
    fetched = [];
  const db = h.s.ctx.db;
  const counting = {
    ...h.s.ctx,
    db: new Proxy(db, {
      get(target, key) {
        if (key === 'query') return table => (queried.push(table), target.query(table));
        if (key === 'get') return id => (fetched.push(id), target.get(id));
        const member = Reflect.get(target, key);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    }),
  };
  await asPerson(h, h.account, () =>
    teams.removeMember._handler(counting, { id: 'crew', member: 'fixture-solo' }),
  );
  assert.equal(queried.filter(name => name === 'sealedSecretSets').length, 3);
  assert(!fetched.includes(h.project), 'no project row read');
  // A read team gives no write: removing its member reads no sealed set.
  queried.length = 0;
  await asPerson(h, h.account, () =>
    teams.removeMember._handler(counting, { id: 'viewers', member: 'fixture-solo' }),
  );
  assert.equal(queried.filter(name => name === 'sealedSecretSets').length, 0);
  // Unlinking: the project row is already read; no team member is read without a sealed set.
  queried.length = 0;
  await asPerson(h, h.account, () =>
    teamAccess.set._handler(counting, {
      projectId: h.project,
      teamId: 'crew',
      role: null,
      revision: revision(h),
    }),
  );
  assert.equal(queried.filter(name => name === 'sealedSecretSets').length, 3);
  assert(!queried.includes('teamMembers'));
});
