// SPDX-License-Identifier: Apache-2.0
// The project access contract (Item b987e608, docs/access.md): every role is asked every verb against the real
// server handlers, and the answer must match the contract table the People and access screen shows. A removed
// member's next call is refused, and the role resolver reads at most two indexed rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { state, backupRow } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const contract = await import(moduleUrl('../convex/projectAccessContract.ts'));
const { projectRole } = await import(moduleUrl('../convex/projectRole.ts'));
const projectWork = await import(moduleUrl('../convex/projectWork.ts'));
const projectBackups = await import(moduleUrl('../convex/projectBackups.ts'));
const projectContributors = await import(moduleUrl('../convex/projectContributors.ts'));
const projectReaders = await import(moduleUrl('../convex/projectReaders.ts'));
const authority = await import(moduleUrl('../convex/projectAuthority.ts'));

function setup(visibility) {
  const s = state([]);
  s.tables.forgeAccounts.set('new-person', {
    _id: 'new-person',
    _creationTime: 1,
    owner: 'someone',
    handle: 'someone',
  });
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: 'synthetic',
    name: 'Access project',
    visibility,
    currentBackup: 'backup',
    revision: 1,
  });
  s.tables.projectBackups.set(
    'backup',
    backupRow({ _id: 'backup', projectId: 'project', digest: 'a'.repeat(64) }),
  );
  s.tables.projectContributors.set('w', {
    _id: 'w',
    _creationTime: 2,
    projectId: 'project',
    contributor: 'writer',
  });
  s.tables.projectReaders.set('r', { _id: 'r', _creationTime: 3, projectId: 'project', reader: 'reader' });
  return s;
}
const allowed = async run => {
  try {
    await run();
    return true;
  } catch (error) {
    if ((error?.data?.code ?? error?.code) === 'PROJECT_UNAVAILABLE') return false;
    throw error;
  }
};
// One real enforcement point per verb the server answers today (docs/access.md "Enforced in").
const verbs = {
  readSource: s => projectWork.state._handler(s.ctx, { projectId: 'project' }),
  readWork: s => authority.accessibleProject(s.ctx, 'project', s.who),
  readArchives: s =>
    projectBackups.history._handler(s.ctx, {
      projectId: 'project',
      paginationOpts: { cursor: null, numItems: 5 },
    }),
  changeWork: s => authority.activeProject(s.ctx, 'project', s.who),
  removePeople: s =>
    projectContributors.remove._handler(s.ctx, { projectId: 'project', contributor: 'nobody' }),
  addPeople: s =>
    projectReaders.set._handler(s.ctx, {
      projectId: 'project',
      owner: s.who,
      reader: 'someone',
      present: true,
      operationId: randomUUID(),
    }),
};
const people = { owner: 'owner', write: 'writer', read: 'reader', outsider: 'outsider' };

for (const visibility of ['private', 'public'])
  test(`every role gets the contract's answer from the server on a ${visibility} project`, async () => {
    for (const [standing, who] of Object.entries(people))
      for (const [verb, run] of Object.entries(verbs)) {
        const s = setup(visibility);
        s.caller(who);
        s.who = who;
        const role = standing === 'outsider' ? 'public' : standing;
        const expected = contract.projectMay(role, verb, 'person', visibility) === 'yes';
        assert.equal(await allowed(() => run(s)), expected, `${standing} ${verb} on ${visibility}`);
      }
  });

test('a private project without a role answers like a missing one', async () => {
  const s = setup('private');
  s.caller('outsider');
  const missing = await projectWork.state._handler(s.ctx, { projectId: 'project' }).catch(error => error);
  s.tables.hostedProjects.delete('project');
  const absent = await projectWork.state._handler(s.ctx, { projectId: 'project' }).catch(error => error);
  assert.equal(missing.data.code, absent.data.code);
  assert.equal(missing.data.message, absent.data.message);
});

test('removing a write member refuses their next call; lowering to read keeps reading only', async () => {
  const s = setup('private');
  s.caller('writer');
  await authority.activeProject(s.ctx, 'project', 'writer');
  s.tables.projectContributors.delete('w');
  assert.equal(await allowed(() => authority.accessibleProject(s.ctx, 'project', 'writer')), false);
  s.tables.projectReaders.set('r2', { _id: 'r2', _creationTime: 4, projectId: 'project', reader: 'writer' });
  assert.equal(await allowed(() => authority.accessibleProject(s.ctx, 'project', 'writer')), true);
  assert.equal(await allowed(() => authority.activeProject(s.ctx, 'project', 'writer')), false);
});

test('the role resolver reads nothing for the owner, one row for a writer and at most two otherwise', async () => {
  const s = setup('private');
  const project = s.tables.hostedProjects.get('project');
  const reads = async who => {
    const before = s.reads();
    const role = await projectRole(s.ctx, project, who);
    return [role, s.reads() - before];
  };
  assert.deepEqual(await reads('owner'), ['owner', 0]);
  const [writeRole, writeReads] = await reads('writer');
  const [readRole, readReads] = await reads('reader');
  const [noRole, noReads] = await reads('outsider');
  assert.deepEqual([writeRole, readRole, noRole], ['write', 'read', null]);
  assert.ok(writeReads <= 1 && readReads <= 2 && noReads <= 2, `${writeReads} ${readReads} ${noReads}`);
});

test('agents never get more than their person, and person-only verbs refuse agents', () => {
  for (const visibility of ['private', 'public'])
    for (const role of [...contract.projectRoles, 'public', null])
      for (const verb of Object.keys(contract.projectVerbs)) {
        const person = contract.projectMay(role, verb, 'person', visibility);
        const agent = contract.projectMay(role, verb, 'agent', visibility);
        if (person === 'no') assert.equal(agent, 'no', `${role} ${verb}`);
      }
  for (const verb of ['landWithoutCheck', 'approveProtected', 'ownerPersonOnly'])
    assert.equal(contract.projectMay('owner', verb, 'agent', 'private'), 'no', verb);
  assert.equal(contract.projectMay('owner', 'addPeople', 'agent', 'private'), 'held');
  assert.equal(contract.projectMay(null, 'readSource', 'person', 'private'), 'no');
  // The screen's one read of every answer is the same table.
  const answers = contract.projectAnswers('write', 'agent', 'private');
  for (const verb of Object.keys(contract.projectVerbs))
    assert.equal(answers[verb], contract.projectMay('write', verb, 'agent', 'private'), verb);
  assert.equal(contract.projectMay('public', 'readSource', 'person', 'public'), 'yes');
  assert.equal(contract.projectMay('public', 'readArchives', 'person', 'public'), 'no');
});
