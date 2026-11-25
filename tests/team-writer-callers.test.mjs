// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item b6588425 (4c): the places that ask "may this person work here?" count a writer through a linked team as
// they count a direct writer (docs/access.md#teams), and a team reader as no writer. Direct grants stay the first
// and only read for owners and direct members.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { boardFixture } from './board-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const { roleOf } = await import(moduleUrl('../convex/projectCiStatusLifecycle.ts'));
const { planningMembers } = await import(moduleUrl('../convex/personWork.ts'));
const { setReader } = await import(moduleUrl('../convex/projectReaders.ts'));
const { historyViewVersion } = await import(moduleUrl('../convex/projectLandingCapsuleContext.ts'));
const { canonicalPayload } = await import(moduleUrl('../src/hosted-source-operation.ts'));
const { digest } = await import(moduleUrl('../src/state/hash.ts'));
const access = await import(moduleUrl('../convex/projectAccess.ts'));
const { authorize } = await import(moduleUrl('../convex/projectActorNames.ts'));

function setup() {
  const f = boardFixture();
  for (const table of ['teams', 'teamMembers', 'projectTeams', 'projectActorNames'])
    f.tables[table] ??= new Map();
  const project = f.tables.hostedProjects.get('project');
  project.teamLinks = 2;
  const team = (id, role, members) => {
    f.tables.teams.set(id, { _id: id, owner: 'owner', name: id, operationId: randomUUID() });
    f.tables.projectTeams.set(`link-${id}`, { _id: `link-${id}`, projectId: 'project', teamId: id, role });
    for (const member of members)
      f.tables.teamMembers.set(`${id}-${member}`, {
        _id: `${id}-${member}`,
        teamId: id,
        member,
        handle: null,
      });
  };
  team('crew', 'write', ['crew-mate', 'writer']);
  team('guests', 'read', ['guest-mate']);
  return { ...f, project };
}

test('the CI status check treats a team writer as a contributor and a team reader as outside', async () => {
  const f = setup();
  f.caller('owner');
  const role = actor => f.transaction(() => roleOf(f.ctx, f.project, actor));
  assert.equal(await role('owner'), 'owner');
  assert.equal(await role('writer'), 'contributor'); // direct and team
  assert.equal(await role('crew-mate'), 'contributor'); // team only
  assert.equal(await role('guest-mate'), 'outside');
  assert.equal(await role('stranger'), 'outside');
  assert.equal(await role(''), 'outside');
});

test('a partial stats close marks the owner, direct writers and linked team writers once, never team readers', async () => {
  const f = setup();
  f.caller('owner');
  const members = await planningMembers(f.ctx, f.project);
  assert.deepEqual([...members].sort(), ['crew-mate', 'owner', 'writer']);
});

test('a project without team links lists planning members with no team read', async () => {
  const f = setup();
  delete f.project.teamLinks;
  const read = [];
  const query = f.ctx.db.query;
  f.ctx.db.query = table => (read.push(table), query(table));
  const members = await planningMembers(f.ctx, f.project);
  assert.deepEqual([...members].sort(), ['owner', 'writer']);
  assert.deepEqual(read, ['projectContributors']);
});

test('linked teams that share members still list every writer up to the cap', async () => {
  const f = setup();
  f.tables.projectContributors.clear();
  f.tables.teamMembers.clear();
  f.project.teamLinks = 2;
  for (const [team, members] of [
    ['crew', Array.from({ length: 99 }, (_, i) => `a${i}`)],
    ['guests', ['a0', 'late']],
  ])
    for (const member of members)
      f.tables.teamMembers.set(`${team}-${member}`, {
        _id: `${team}-${member}`,
        teamId: team,
        member,
        handle: null,
      });
  f.tables.projectTeams.get('link-guests').role = 'write';
  const members = await planningMembers(f.ctx, f.project);
  assert.equal(members.length, 101); // the owner, 99 in the first team and the one new writer of the second
  assert.ok(members.includes('late'));
});

test('People and access changes the direct grant of a person who also writes through a team', async () => {
  const f = setup();
  f.tables.projectContributors.clear();
  f.tables.projectReaders.set('direct-read', {
    _id: 'direct-read',
    projectId: 'project',
    reader: 'crew-mate',
  });
  const set = role => {
    f.caller('owner');
    return f.transaction(() =>
      access.setRole._handler(f.ctx, {
        projectId: 'project',
        person: 'crew-mate',
        role,
        operationId: randomUUID(),
      }),
    );
  };
  const direct = () => ({
    writer: [...f.tables.projectContributors.values()].some(row => row.contributor === 'crew-mate'),
    reader: [...f.tables.projectReaders.values()].some(row => row.reader === 'crew-mate'),
  });
  await set('write'); // the team already gives write; the person still gets their own grant
  assert.deepEqual(direct(), { writer: true, reader: false });
  await set('none'); // removing it leaves the team's access, which the owner changes on the team link
  assert.deepEqual(direct(), { writer: false, reader: false });
});

test('a reader grant is refused for a person who already writes through a team', async () => {
  const f = setup();
  f.caller('owner');
  const grant = reader =>
    f.transaction(() =>
      setReader(f.ctx, {
        projectId: 'project',
        owner: 'owner',
        reader,
        present: true,
        operationId: randomUUID(),
      }),
    );
  await assert.rejects(
    grant('crew-mate'),
    error =>
      (error.data?.code ?? error.code) === 'BAD_ARGUMENT' && /already has write access/.test(error.message),
  );
  await assert.rejects(grant('writer'), error => /already has write access/.test(error.message));
});

test('the landing history view version reads a team writer as a writer and a team reader as a reader', async () => {
  const f = setup();
  const version = async actor => {
    f.caller(actor);
    return f.transaction(() => historyViewVersion(f.ctx, f.project));
  };
  const expected = (viewer, role) => digest(canonicalPayload({ viewer, role }));
  assert.equal(await version('crew-mate'), expected('crew-mate', 'writer'));
  assert.equal(await version('guest-mate'), expected('guest-mate', 'reader'));
  assert.equal(await version('owner'), expected('owner', 'owner'));
});

test('the owner may name a team writer in actor names, and a stranger may not', async () => {
  const f = setup();
  f.tables.hostedProjects.get('project').visibility = 'public';
  const named = (actor, reader) =>
    f.invoke(
      authorize,
      'projectActorNames:authorize',
      { projectId: 'project', reader, actors: [actor] },
      reader,
    );
  assert.deepEqual(await named('crew-mate', 'owner'), ['crew-mate']);
  await assert.rejects(
    named('crew-mate', 'stranger'),
    error => (error.data?.code ?? error.code) === 'PROJECT_UNAVAILABLE',
  );
  await assert.rejects(
    named('stranger', 'owner'),
    error => (error.data?.code ?? error.code) === 'PROJECT_UNAVAILABLE',
  );
});
