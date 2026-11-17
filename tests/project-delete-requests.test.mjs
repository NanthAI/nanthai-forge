// SPDX-License-Identifier: Apache-2.0
// Item 7456856f: many projects deleted for good in one owner approval. Anyone signed in to the account prepares the exact
// frozen list; only the owner person approves it, once. A device or agent sign-in cannot approve, another account reads
// the request as missing, a project the approver no longer owns is refused, an expired request deletes nothing, a project
// that gained a landing or changed revision after the list was shown is skipped and named, a replayed approval is a no-op,
// and retry acts only on the projects whose purge stopped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';

const requests = await import(moduleUrl('../convex/projectDeleteRequests.ts'));
const { noteDeleteOutcome } = await import(moduleUrl('../convex/projectDeleteRequestOutcome.ts'));
const code = expected => error => error.data?.code === expected;

function fixture(count = 12) {
  const s = state([]);
  for (let i = 0; i < count; i++) {
    const id = `project-${i}`;
    s.tables.hostedProjects.set(id, {
      _id: id,
      _creationTime: i + 1,
      owner: 'owner',
      key: randomUUID(),
      name: `bench-zoo-${i}`,
      slug: `bench-zoo-${i}`,
      currentBackup: null,
      revision: 1,
      ...(i % 2 ? { removal: 'trash', removedAt: 1 } : {}),
    });
  }
  s.tables.hostedProjects.set('keep-me', {
    _id: 'keep-me',
    _creationTime: 99,
    owner: 'owner',
    key: randomUUID(),
    name: 'tidepool',
    slug: 'tidepool',
    currentBackup: null,
    revision: 3,
  });
  s.tables.cliCredentials.set('device', {
    _id: 'device',
    credentialId: 'synthetic-device',
    owner: 'owner',
    name: 'test',
    tokenHash: 'synthetic-hash',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 600000,
    revoked: false,
    scope: 'cli',
  });
  const as = (subject, device = false) => {
    s.ctx.auth.getUserIdentity = async () => ({
      subject,
      ...(device ? { forgeCredential: 'synthetic-device' } : {}),
    });
  };
  const call = async (name, input) => JSON.parse(await requests[name]._handler(s.ctx, input));
  return { s, as, call };
}
const prepare = (f, select, device = true) => {
  f.as('owner', device);
  return f.call('prepare', { operationId: randomUUID(), select });
};
const approve = (f, request, extra = {}) =>
  f.call('decide', {
    requestId: request.id,
    operationId: extra.operationId ?? randomUUID(),
    decision: 'approve',
    count: extra.count ?? request.projects.length - (extra.kept?.length ?? 0),
    ...(extra.kept ? { kept: extra.kept } : {}),
  });

test('an agent prepares the exact list from a name pattern; only matching projects are listed and nothing is deleted', async () => {
  const f = fixture();
  const request = await prepare(f, { glob: 'bench-zoo-*' });
  assert.equal(request.status, 'requested');
  assert.equal(request.projects.length, 12);
  assert.ok(!request.projects.some(project => project.slug === 'tidepool'));
  assert.ok([...f.s.tables.hostedProjects.values()].every(project => project.removal !== 'deleting'));
  const trash = await prepare(f, { trash: true });
  assert.equal(trash.projects.length, 6, 'only the projects in the trash');
});

test('a device or agent sign-in cannot approve; another account cannot even read the request', async () => {
  const f = fixture();
  const request = await prepare(f, { glob: 'bench-zoo-*' });
  f.as('owner', true);
  await assert.rejects(approve(f, request), code('PROJECT_UNAVAILABLE'));
  f.as('someone-else');
  await assert.rejects(approve(f, request), code('NOT_FOUND'));
  await assert.rejects(f.call('read', { requestId: request.id }), code('NOT_FOUND'));
  assert.ok([...f.s.tables.hostedProjects.values()].every(project => project.removal !== 'deleting'));
});

test('one owner approval purges every listed project; a replay is a no-op and the typed count must match', async () => {
  const f = fixture();
  const request = await prepare(f, { glob: 'bench-zoo-*' });
  f.as('owner');
  await assert.rejects(approve(f, request, { count: 11 }), code('BAD_ARGUMENT'));
  const operationId = randomUUID();
  const done = await approve(f, request, { operationId, kept: ['project-0'] });
  assert.equal(done.status, 'approved');
  assert.equal(done.projects.find(p => p.projectId === 'project-0').outcome, 'kept');
  assert.equal(done.projects.filter(p => p.outcome === 'started').length, 11);
  assert.equal(f.s.tables.hostedProjects.get('project-1').removal, 'deleting');
  assert.notEqual(f.s.tables.hostedProjects.get('project-0').removal, 'deleting', 'a kept project stays');
  const before = f.s.tables.hostedProjects.get('project-1').revision;
  assert.deepEqual(
    await approve(f, request, { operationId, kept: ['project-0'] }),
    done,
    'a replay changes nothing',
  );
  assert.equal(f.s.tables.hostedProjects.get('project-1').revision, before);
  await assert.rejects(
    approve(f, request, { kept: ['project-0'] }),
    code('WORK_STALE'),
    'a second approval is refused',
  );
});

test('a project that gained a landing, changed revision or changed owner after the list was shown is skipped and named', async () => {
  const f = fixture(3);
  const request = await prepare(f, { glob: 'bench-zoo-*' });
  // A new save landed on project-0 after the list was shown.
  f.s.tables.projectHostedAcceptances.set('landing-new', {
    _id: 'landing-new',
    _creationTime: Date.now(),
    projectId: 'project-0',
  });
  f.s.tables.hostedProjects.get('project-1').revision = 2;
  f.s.tables.hostedProjects.get('project-2').owner = 'someone-else';
  f.as('owner');
  const done = await approve(f, request);
  assert.deepEqual(
    done.projects.map(p => [p.slug, p.outcome]),
    [
      ['bench-zoo-0', 'changed'],
      ['bench-zoo-1', 'changed'],
      ['bench-zoo-2', 'refused'],
    ].sort(),
  );
  assert.ok([...f.s.tables.hostedProjects.values()].every(project => project.removal !== 'deleting'));
});

test('an expired request deletes nothing and cannot be approved', async () => {
  const f = fixture(2);
  const request = await prepare(f, { glob: 'bench-zoo-*' });
  const row = f.s.tables.projectDeleteRequests.get(request.id);
  row.expiresAt = Date.now() - 1;
  f.as('owner');
  assert.equal((await f.call('read', { requestId: request.id })).status, 'expired');
  await assert.rejects(approve(f, request), code('WORK_STALE'));
  assert.ok([...f.s.tables.hostedProjects.values()].every(project => project.removal !== 'deleting'));
});

test('a purge that stops is recorded on the request; retry replays only those projects', async () => {
  const f = fixture(2);
  const request = await prepare(f, { glob: 'bench-zoo-*' });
  f.as('owner');
  await approve(f, request);
  const stopped = f.s.tables.hostedProjects.get('project-0');
  await noteDeleteOutcome(f.s.ctx, stopped, 'failed');
  await noteDeleteOutcome(f.s.ctx, f.s.tables.hostedProjects.get('project-1'), 'deleted');
  const read = await f.call('read', { requestId: request.id });
  assert.deepEqual(
    read.projects.map(p => p.outcome),
    ['failed', 'deleted'],
  );
  const again = await f.call('retry', { requestId: request.id });
  assert.deepEqual(
    again.projects.map(p => p.outcome),
    ['started', 'deleted'],
  );
  f.as('owner', true);
  await assert.rejects(f.call('retry', { requestId: request.id }), code('PROJECT_UNAVAILABLE'));
});

test('a decline and a withdrawal delete nothing and reach the requester through the same read', async () => {
  const f = fixture(2);
  const request = await prepare(f, { glob: 'bench-zoo-*' });
  f.as('owner');
  const declined = await f.call('decide', {
    requestId: request.id,
    operationId: randomUUID(),
    decision: 'decline',
    reason: 'keep the zoo for now',
  });
  assert.equal(declined.status, 'declined');
  f.as('owner', true);
  assert.equal((await f.call('read', { requestId: request.id })).reason, 'keep the zoo for now');
  const other = await prepare(f, { glob: 'bench-zoo-*' });
  assert.equal((await f.call('withdraw', { requestId: other.id })).status, 'withdrawn');
  assert.ok([...f.s.tables.hostedProjects.values()].every(project => project.removal !== 'deleting'));
});
