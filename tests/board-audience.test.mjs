// SPDX-License-Identifier: Apache-2.0
// Item b6588425 parts (4) and (5): the board and agent coordination belong to the project's team (the owner and write
// members, direct or through a linked team). Under the `team-and-contributors` audience a reader may also message the
// team and read only their own notes. No audience opens them to everyone, and leaving a team ends access on the next
// call. docs/access.md#audience records the rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { boardFixture } from './board-fixture.mjs';
import { projectRow } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const coordination = await import(moduleUrl('../convex/projectCoordination.ts'));
const teamAccess = await import(moduleUrl('../convex/projectTeamAccess.ts'));
const actorNames = await import(moduleUrl('../convex/projectActorNames.ts'));
const { agentDefaultsSchema } = await import(moduleUrl('../src/agent-parallel-defaults.ts'));
const { autonomyPolicySchema, policyPreset } = await import(moduleUrl('../src/autonomy-policy.ts'));

const code = expected => error => (error.data?.code ?? error.code) === expected;
const unavailable = 'This Forge project is unavailable with the current account.';

function setup({ visibility = 'public', audience } = {}) {
  const f = boardFixture();
  for (const table of [
    'teams',
    'teamMembers',
    'projectTeams',
    'zoneReaders',
    'projectCoordinationSessions',
    'projectCoordinationEvents',
    'projectCoordinationReceipts',
    'projectCoordinationClaims',
    'projectActorNames',
  ])
    f.tables[table] ??= new Map();
  // A complete project row: linking a team writes the project's link count.
  const project = projectRow({
    ...f.tables.hostedProjects.get('project'),
    key: 'project-key',
    name: 'project',
  });
  f.tables.hostedProjects.set('project', project);
  project.visibility = visibility;
  if (audience)
    project.autonomyPolicy = {
      ...policyPreset('trusted'),
      agentDefaults: { boardAudience: audience },
    };
  f.tables.teams.set('core', { _id: 'core', owner: 'owner', name: 'core', operationId: randomUUID() });
  f.tables.teamMembers.set('core-mate', { _id: 'core-mate', teamId: 'core', member: 'mate', handle: null });
  // `revision` defaults to the project's current team-access revision, as a fresh People and access read gives.
  const link = (role, revision, teamId = 'core', actor = 'owner') =>
    f.invoke(
      teamAccess.set,
      'projectTeamAccess:set',
      {
        projectId: 'project',
        teamId,
        role,
        revision: revision ?? f.tables.hostedProjects.get('project').teamRevision ?? 0,
      },
      actor,
    );
  const publish = (command, actor = 'owner') =>
    f.invoke(
      coordination.publish,
      'projectCoordination:publish',
      { projectId: 'project', operationId: randomUUID(), command },
      actor,
    );
  const feed = actor =>
    f.invoke(
      coordination.feed,
      'projectCoordination:feed',
      { projectId: 'project', paginationOpts: { cursor: null, numItems: 10 } },
      actor,
    );
  const refused = (promise, expected = 'PROJECT_UNAVAILABLE') => assert.rejects(promise, code(expected));
  return { ...f, link, publish, feed, refused };
}

test('a linked team makes its members the team on the board and coordination; leaving the team ends it on the next call', async () => {
  const f = setup();
  await f.refused(f.post({ to: 'project', text: 'before the link' }, 'mate'));
  // Only the owner person links their own teams; a stale screen refuses instead of overwriting.
  f.tables.teams.set('theirs', { _id: 'theirs', owner: 'writer', name: 'x', operationId: randomUUID() });
  await f.refused(f.link('write', undefined, 'theirs'), 'BAD_ARGUMENT');
  await f.refused(f.link('write', undefined, 'core', 'writer'));
  await f.link('write');
  await f.link('write', 0); // a retry of the same outcome reconciles
  await f.refused(f.link('read', 0), 'WORK_OPERATION_CHANGED');
  // A lost-response retry of the first link, sent after the owner unlinked, cannot re-grant it.
  await f.link(null);
  await f.refused(f.link('write', 0), 'WORK_OPERATION_CHANGED');
  assert.equal(f.tables.hostedProjects.get('project').teamLinks, 0);
  await f.link('write');
  assert.equal(f.tables.hostedProjects.get('project').teamLinks, 1);
  assert.deepEqual(
    await f.invoke(teamAccess.list, 'projectTeamAccess:list', { projectId: 'project' }, 'owner'),
    { revision: 3, teams: [{ teamId: 'core', name: 'core', role: 'write' }] },
  );

  const posted = await f.post({ to: 'project', text: 'mate is on the team' }, 'mate');
  assert.equal(posted.status, 'posted');
  assert.equal((await f.read({}, 'mate')).status, 'ok');
  await f.feed('mate');

  // Removing the member from the team deletes their row: the next call has no role.
  f.tables.teamMembers.delete('core-mate');
  await f.refused(f.post({ to: 'project', text: 'after leaving' }, 'mate'));
  await f.refused(f.read({}, 'mate'));
  await f.refused(f.feed('mate'));

  // A team being deleted grants nothing even while its member rows are still being purged.
  f.tables.teamMembers.set('core-mate', { _id: 'core-mate', teamId: 'core', member: 'mate', handle: null });
  f.tables.teams.get('core').removal = 'deleting';
  await f.refused(f.read({}, 'mate'));
});

test('the effective role is the highest of the direct grant and every linked team; a read team follows a private project only', async () => {
  const f = setup({ visibility: 'private' });
  f.tables.projectReaders.set('mate-read', { _id: 'mate-read', projectId: 'project', reader: 'mate' });
  f.tables.teams.set('wide', { _id: 'wide', owner: 'owner', name: 'wide', operationId: randomUUID() });
  f.tables.teamMembers.set('wide-mate', { _id: 'wide-mate', teamId: 'wide', member: 'mate', handle: null });
  await f.link('read', undefined, 'wide');
  // Direct read and a read team: a reader follows the private project's coordination but cannot post.
  await f.feed('mate');
  await f.refused(f.post({ to: 'project', text: 'reader post' }, 'mate'));
  // A second team with write raises the role, whatever the order of the links.
  await f.link('write');
  assert.equal((await f.post({ to: 'project', text: 'write via core' }, 'mate')).status, 'posted');
  await f.link(null);
  await f.refused(f.post({ to: 'project', text: 'core unlinked' }, 'mate'));
  assert.equal(f.tables.hostedProjects.get('project').teamLinks, 1);
});

test('a project with no linked teams resolves roles without reading any team row', async () => {
  const f = setup();
  const tables = [];
  const query = f.ctx.db.query;
  f.ctx.db.query = (table, ...rest) => {
    tables.push(table);
    return query(table, ...rest);
  };
  await f.refused(f.read({}, 'stranger'));
  await f.read({}, 'writer');
  await f.read({}, 'owner');
  assert.deepEqual(
    tables.filter(table => table === 'projectTeams' || table === 'teamMembers'),
    [],
  );
});

test('an outside agent cannot read or post to a team-only board, and gets the private project refusal', async () => {
  const f = setup();
  for (const actor of ['stranger', 'reader']) {
    for (const call of [
      f.read({}, actor),
      f.post({ to: 'project', text: 'outside post' }, actor),
      f.post({ to: `lane:${f.lanes.A}`, text: 'outside lane note' }, actor),
    ])
      await assert.rejects(call, e => code('PROJECT_UNAVAILABLE')(e) && e.data.message === unavailable);
  }
  const note = await f.post({ to: 'project', text: 'team only' }, 'writer');
  await f.refused(f.read({ id: note.id }, 'reader'));
  await f.refused(f.resolve({ id: note.id }, 'reader'));
});

test('a team agent cannot message outsiders: not a Lane or session left by someone off the team, not an outside account', async () => {
  const f = setup();
  f.tables.projectCoordinationSessions.set('gone-session', {
    _id: 'gone-session',
    projectId: 'project',
    sessionId: 'session-gone',
    actor: 'gone',
    name: 'Former member',
    status: 'active',
    lastSeen: 1_800_000_000_000,
    sequence: 1,
    operationId: randomUUID(),
    environment: {},
    summary: '',
    context: {},
  });
  await f.refused(
    f.publish({ kind: 'message', recipient: 'session-gone', text: 'hi', context: {} }),
    'BAD_ARGUMENT',
  );
  await f.refused(
    f.publish({ kind: 'message', recipient: 'stranger', text: 'hi', context: {} }),
    'BAD_ARGUMENT',
  );
  await f.publish({ kind: 'message', recipient: 'writer', text: 'to the team', context: {} });
  // The writer asks the owner a question and writes a note from Lane A; a reply goes to that Lane while they are on
  // the team.
  const question = randomUUID();
  await f.invoke(
    coordination.publish,
    'projectCoordination:publish',
    {
      projectId: 'project',
      operationId: question,
      command: { kind: 'message', recipient: 'owner', text: 'ship it?', choices: ['Yes', 'No'], context: {} },
    },
    'writer',
  );
  const fromLane = await f.post({ to: 'project', text: 'from Lane A', laneId: f.lanes.A }, 'writer');
  assert.equal((await f.post({ replyTo: fromLane.id, text: 'first answer' })).target, `lane:${f.lanes.A}`);
  // Lane A is the writer's; once the writer leaves, the Lane cannot be messaged, a reply stays in the team inbox and
  // an answer to their question is recorded but addressed to nobody.
  f.tables.projectContributors.delete('c1');
  await f.refused(f.post({ to: `lane:${f.lanes.A}`, text: 'still there?' }), 'BAD_ARGUMENT');
  const reply = await f.post({ replyTo: fromLane.id, text: 'second answer' });
  assert.equal(reply.target, 'project');
  assert.equal(reply.recipients, undefined);
  await f.publish({ kind: 'ack', messageId: question, choice: 'Yes', text: 'Agreed.' });
  const answer = [...f.tables.projectCoordinationEvents.values()].find(
    event => event.command.kind === 'ack' && event.command.messageId === question,
  );
  assert.equal(answer.recipientActor, undefined);
  assert.equal(answer.resumePrompt, undefined);
  assert.equal((await f.post({ to: `lane:${f.lanes.B}`, text: 'own Lane' })).status, 'posted');
});

test('the finish and Plan project headers carry the link count, so a team-only writer resolves there too', async () => {
  const { finishPlanProjectProjection, finishReadFields } = await import(
    moduleUrl('../convex/projectFinishReadProjection.ts')
  );
  assert.ok(finishReadFields.hostedProjects.includes('teamLinks'));
  const header = finishPlanProjectProjection({
    _id: 'project',
    owner: 'owner',
    visibility: 'private',
    teamLinks: 2,
    work: { backupId: 'b', generationId: 'g' },
  });
  assert.equal(JSON.parse(header.value).teamLinks, 2);
});

test('a contributor messages the team but cannot broadcast: no inbox, no other contributor’s notes, no coordination', async () => {
  const f = setup({ audience: 'team-and-contributors' });
  f.tables.projectReaders.set('r2', { _id: 'r2', projectId: 'project', reader: 'reader2' });
  const note = await f.post({ to: 'project', text: 'question for the team', paths: ['src/a.ts'] }, 'reader');
  assert.equal(note.status, 'posted');
  // The team reads it in its inbox and answers in its thread.
  const inbox = await f.read({ all: true }, 'owner');
  assert.ok(inbox.messages.some(message => message.id === note.id));
  await f.post({ replyTo: note.id, text: 'answer from the team' }, 'owner');
  const thread = await f.read({ id: note.id }, 'reader');
  assert.equal(thread.message.text, 'question for the team');
  assert.deepEqual(
    thread.replies.map(reply => reply.text),
    ['answer from the team'],
  );
  // Another contributor sees nothing of it, and a contributor has no inbox.
  await f.refused(f.read({ id: note.id }, 'reader2'), 'NOT_FOUND');
  await f.refused(f.post({ replyTo: note.id, text: 'me too' }, 'reader2'), 'NOT_FOUND');
  await f.refused(f.read({}, 'reader'), 'BAD_ARGUMENT');
  const team = await f.post({ to: 'project', text: 'team internal' }, 'writer');
  await f.refused(f.read({ id: team.id }, 'reader'), 'NOT_FOUND');
  await f.refused(f.resolve({ id: team.id }, 'reader'), 'NOT_FOUND');
  // A coordination message reaches every coordination reader: contributors cannot publish one.
  await f.refused(f.publish({ kind: 'message', text: 'everyone listen', context: {} }, 'reader'));
  await f.refused(f.feed('reader'));
  // An outsider is not a contributor.
  await f.refused(f.post({ to: 'project', text: 'outsider' }, 'stranger'));
  // Back to team only: the contributor's own thread closes too.
  f.tables.hostedProjects.get('project').autonomyPolicy.agentDefaults.boardAudience = 'team';
  await f.refused(f.read({ id: note.id }, 'reader'));
});

test('no board audience opens the board to everyone: the setting refuses "everyone"', () => {
  assert.equal(agentDefaultsSchema.safeParse({ boardAudience: 'everyone' }).success, false);
  assert.equal(agentDefaultsSchema.safeParse({ boardAudience: 'team-and-contributors' }).success, true);
  const policy = { ...policyPreset('trusted'), agentDefaults: { boardAudience: 'everyone' } };
  assert.equal(autonomyPolicySchema.safeParse(policy).success, false);
});

test('no path or message shows for anyone who cannot read it: outsiders, public readers, zone readers and people who left', async () => {
  const f = setup();
  const secret = { text: 'secret plan', paths: ['src/private/plan.ts'] };
  const note = await f.post({ to: 'project', ...secret }, 'writer');
  await f.publish({ kind: 'message', text: secret.text, context: {} });
  // A source Zone reader of some import holds no project role.
  f.tables.zoneReaders.set('z', { _id: 'z', zoneId: 'zone', reader: 'zone-reader' });
  // A removed member keeps only the provenance row, never a grant.
  f.tables.projectActorNames.set('left', {
    _id: 'left',
    projectId: 'project',
    actor: 'left',
    wasMember: true,
  });
  for (const actor of ['stranger', 'reader', 'zone-reader', 'left']) {
    for (const call of [f.read({}, actor), f.read({ id: note.id }, actor), f.feed(actor)]) {
      const error = await call.then(
        () => assert.fail(`${actor} read the team's board or coordination`),
        e => e,
      );
      assert.ok(code('PROJECT_UNAVAILABLE')(error), actor);
      assert.doesNotMatch(error.data.message, /secret|src\/private/, actor);
    }
  }
  // The team sees the note, its paths included.
  const shown = await f.read({ id: note.id }, 'owner');
  assert.deepEqual(shown.message.paths, secret.paths);
});

test('an outsider cannot learn from actor names whether a member ran a session or sent a message', async () => {
  const f = setup();
  f.tables.projectCoordinationSessions.set('writer-session', {
    _id: 'writer-session',
    projectId: 'project',
    sessionId: 'session-w',
    actor: 'writer',
  });
  const authorize = reader =>
    f.invoke(
      actorNames.authorize,
      'projectActorNames:authorize',
      { projectId: 'project', reader, actors: ['writer'] },
      reader,
    );
  // The team names the session holder; an outsider gets the same refusal as for an unknown actor.
  assert.deepEqual(await authorize('owner'), ['writer']);
  f.tables.projectContributors.set('c2', { _id: 'c2', projectId: 'project', contributor: 'mate2' });
  assert.deepEqual(await authorize('mate2'), ['writer']);
  await assert.rejects(authorize('stranger'), code('PROJECT_UNAVAILABLE'));
  f.tables.projectCoordinationSessions.delete('writer-session');
  await assert.rejects(authorize('stranger'), code('PROJECT_UNAVAILABLE'));
});

test('the Lane holder names a person: select, detail, head and history show it to the team only', async () => {
  const { lifecycleFixture, lanes } = await import('./hosted-lane-lifecycle-fixture.mjs');
  const history = await import(moduleUrl('../convex/projectHostedLaneHistory.ts'));
  const f = await lifecycleFixture();
  const holder = { actor: 'owner', agent: 'brisk-otter', sessionId: 'session-o', since: 1, lastSeen: 2 };
  await f.changeLane(f.laneId, { holder });
  f.patch('hostedProjects', f.projectId, { visibility: 'public' });
  const ask = async (name, fn, actor, extra = {}) => {
    const reply = await f.lifeCall(name, fn, { projectId: f.projectId, laneId: f.laneId, ...extra }, actor);
    return typeof reply === 'string' ? JSON.parse(reply) : reply;
  };
  const views = actor => [
    ask('laneSelect', lanes.select, actor),
    ask('laneDetail', lanes.detail, actor),
    ask('laneHead', lanes.head, actor, { includeHolder: true }),
    ask('laneHistory', history.read, actor),
  ];
  for (const view of await Promise.all(views('owner')))
    assert.equal(view.holder?.agent ?? view.holder?.name, 'brisk-otter');
  for (const view of await Promise.all(views('stranger'))) assert.equal(view.holder ?? undefined, undefined);
  // A private project's reader follows its coordination but, like every reader, sees no person: no holder either.
  f.patch('hostedProjects', f.projectId, { visibility: 'private' });
  f.insert('projectReaders', { projectId: f.projectId, reader: 'private-reader' });
  for (const view of await Promise.all(views('private-reader')))
    assert.equal(view.holder ?? undefined, undefined);
});
