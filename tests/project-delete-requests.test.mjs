// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
const lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts'));
const { pageResult, prefixComplete } = await import(moduleUrl('../convex/projectR2Maintenance.ts'));
const { purgeSettleMs } = await import(moduleUrl('../convex/projectRetention.ts'));
const code = expected => error => error.data?.code === expected;
const fixtureNow = Date.parse('2026-11-17T08:00:00Z');

function fixture(t, count = 12) {
  t.mock.timers.enable({ apis: ['Date'], now: fixtureNow });
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
    issuedAt: fixtureNow,
    expiresAt: fixtureNow + 600000,
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

async function finishPurge(f, projectId) {
  const get = () => f.s.tables.hostedProjects.get(projectId);
  for (let page = 0; get().removal === 'deleting'; page++) {
    assert.ok(page < 250, 'permanent deletion reaches a terminal receipt');
    const project = get();
    if (project.r2Purge && !project.r2PrefixPurged) {
      const args = { projectId, generation: project.r2Purge.generation };
      if (project.r2Purge.references?.next === null)
        await prefixComplete._handler(f.s.ctx, {
          ...args,
          operationId: project.purge.operationId,
          objects: 1,
          bytes: 32,
        });
      else await pageResult._handler(f.s.ctx, { ...args, outcome: 'references' });
    }
    await lifecycle.purge._handler(f.s.ctx, { projectId });
  }
}

test('an agent prepares the exact list from a name pattern; only matching projects are listed and nothing is deleted', async t => {
  const f = fixture(t);
  const request = await prepare(f, { glob: 'bench-zoo-*' });
  assert.equal(request.status, 'requested');
  assert.equal(request.projects.length, 12);
  assert.ok(!request.projects.some(project => project.slug === 'tidepool'));
  assert.ok([...f.s.tables.hostedProjects.values()].every(project => project.removal !== 'deleting'));
  const trash = await prepare(f, { trash: true });
  assert.equal(trash.projects.length, 6, 'only the projects in the trash');
});

test('the trash holds more than one request: the request lists the first 100 and the rest stay in the trash (Item 8fba39a4)', async t => {
  const f = fixture(t, 0);
  for (let i = 0; i < 130; i++)
    f.s.tables.hostedProjects.set(`trashed-${i}`, {
      _id: `trashed-${i}`,
      _creationTime: i + 1,
      owner: 'owner',
      key: randomUUID(),
      name: `old-${i}`,
      slug: `old-${i}`,
      currentBackup: null,
      revision: 1,
      removal: 'trash',
      removedAt: 1,
    });
  const request = await prepare(f, { trash: true }, false);
  assert.equal(request.projects.length, 100, 'one request holds 100 trashed projects, not an error');
  assert.equal(request.selector, 'the trash');
  assert.ok(request.projects.every(project => project.trash));
  assert.equal(
    f.s.tables.hostedProjects.get('keep-me').removal,
    undefined,
    'an active project is never listed',
  );
});

test('a device or agent sign-in cannot approve; another account cannot even read the request', async t => {
  const f = fixture(t);
  const request = await prepare(f, { glob: 'bench-zoo-*' });
  f.as('owner', true);
  await assert.rejects(approve(f, request), code('PROJECT_UNAVAILABLE'));
  f.as('someone-else');
  await assert.rejects(approve(f, request), code('NOT_FOUND'));
  await assert.rejects(f.call('read', { requestId: request.id }), code('NOT_FOUND'));
  assert.ok([...f.s.tables.hostedProjects.values()].every(project => project.removal !== 'deleting'));
});

test('one owner approval purges every listed project; a replay is a no-op and the typed count must match', async t => {
  const f = fixture(t);
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
  t.mock.timers.tick(purgeSettleMs);
  for (const project of done.projects.filter(p => p.outcome === 'started')) {
    await finishPurge(f, project.projectId);
    assert.equal(f.s.tables.hostedProjects.get(project.projectId).removal, 'deleted');
    assert.ok(f.s.tables.hostedProjects.get(project.projectId).purge.completedAt);
    const live = await f.call('read', { requestId: request.id });
    assert.equal(live.projects.find(p => p.projectId === project.projectId).outcome, 'deleted');
  }
  const terminal = await f.call('read', { requestId: request.id });
  assert.equal(terminal.projects.filter(p => p.outcome === 'deleted').length, 11);
  assert.equal(terminal.projects.find(p => p.projectId === 'project-0').outcome, 'kept');
});

test('overlapping requests skip projects whose purge started or finished under another approval', async t => {
  const f = fixture(t, 2);
  const selection = { ids: ['project-0', 'project-1'] };
  const first = await prepare(f, selection);
  const next = await prepare(f, selection);
  assert.deepEqual(
    next.projects.map(project => project.projectId),
    selection.ids,
  );
  f.as('owner');
  await approve(f, first);
  t.mock.timers.tick(purgeSettleMs);
  await finishPurge(f, 'project-1');
  const done = await approve(f, next);
  assert.deepEqual(
    done.projects.map(project => project.outcome),
    ['changed', 'changed'],
  );
  await finishPurge(f, 'project-0');
  const original = await f.call('read', { requestId: first.id });
  assert.deepEqual(
    original.projects.map(project => project.outcome),
    ['deleted', 'deleted'],
  );
  assert.deepEqual(await f.call('read', { requestId: next.id }), done);
});

test('a fresh tiny purge reports the upload window and returns from one wait on completion', async t => {
  const { waitForDeleteRequest } = await import('../dist/host-delete-projects.js');
  const f = fixture(t, 1);
  const request = await prepare(f, { ids: ['project-0'] });
  const messages = [];
  let listener,
    fail,
    closed = false;
  const waiting = waitForDeleteRequest(
    {
      onUpdate(_reference, { requestId }, onUpdate, onError) {
        assert.equal(requestId, request.id);
        assert.equal(listener, undefined);
        listener = onUpdate;
        fail = onError;
        return () => {
          listener = undefined;
        };
      },
      async close() {
        closed = true;
      },
    },
    request.id,
    message => messages.push(message),
  );
  void waiting.catch(() => {});
  t.after(() => fail?.(Error('fixture closed')));
  const publish = async () => listener?.(JSON.stringify(await f.call('read', { requestId: request.id })));
  await publish();
  assert.match(messages[0], /waiting for owner approval/);
  f.as('owner');
  await approve(f, request);
  f.as('owner', true);
  await publish();
  await publish();
  assert.equal(messages.length, 2);
  assert.match(messages[1], /0 of 1 purges finished.*20 minutes/);
  assert.equal(closed, false);
  t.mock.timers.tick(purgeSettleMs);
  f.s.tables.cliCredentials.get('device').expiresAt = fixtureNow + purgeSettleMs + 600_000;
  // The durable purge receipt can identify this approval even without the lifecycle marker.
  const project = f.s.tables.hostedProjects.get('project-0');
  delete project.lifecycle;
  await finishPurge(f, project._id);
  const finished = await f.call('read', { requestId: request.id });
  assert.equal(finished.projects[0].outcome, 'deleted');
  await publish();
  assert.deepEqual(await waiting, finished);
  assert.equal(listener, undefined);
  assert.equal(closed, true);
});

test('a legacy bulk wait sees completed purge receipts when the request still says started', async t => {
  const { waitForDeleteRequest } = await import('../dist/host-delete-projects.js');
  const f = fixture(t, 3);
  const request = await prepare(f, { ids: ['project-0', 'project-1', 'project-2'] });
  f.as('owner');
  await approve(f, request);
  t.mock.timers.tick(purgeSettleMs);
  await finishPurge(f, 'project-0');
  await finishPurge(f, 'project-2');
  const row = f.s.tables.projectDeleteRequests.get(request.id);
  delete row.tracksPurgeReceipt;
  row.results = row.results.map(entry => ({ ...entry, outcome: 'started' }));
  const other = f.s.tables.hostedProjects.get('project-2');
  other.purge.operationId = 'a different purge';
  let listener,
    fail,
    reads = 0;
  const checked = Promise.withResolvers();
  const waiting = waitForDeleteRequest(
    {
      onUpdate(_reference, _args, onUpdate, onError) {
        listener = onUpdate;
        fail = onError;
        return () => {
          listener = undefined;
        };
      },
      async close() {},
    },
    request.id,
    () => {},
    async () => {
      reads++;
      const view = await f.call('read', { requestId: request.id, reconcile: true });
      checked.resolve(view);
      return JSON.stringify(view);
    },
  );
  void waiting.catch(() => {});
  t.after(() => fail?.(Error('fixture closed')));
  const publish = async () => listener?.(JSON.stringify(await f.call('read', { requestId: request.id })));
  await publish();
  const inspected = await checked.promise;
  assert.deepEqual(
    inspected.projects.map(p => p.outcome),
    ['deleted', 'started', 'changed'],
  );
  await publish();
  assert.equal(reads, 1);
  assert.ok(
    row.results.every(p => p.outcome === 'started'),
    'observing a legacy request writes nothing',
  );
  await finishPurge(f, 'project-1');
  await publish();
  const settled = await waiting;
  assert.deepEqual(
    settled.projects.map(p => p.outcome),
    ['deleted', 'deleted', 'changed'],
  );
  assert.equal(reads, 1);
});

test('the owner can retry a blocked legacy purge pinned by its receipt while the request still says started', async t => {
  const f = fixture(t, 1);
  const request = await prepare(f, { ids: ['project-0'] });
  f.as('owner');
  await approve(f, request);
  delete f.s.tables.projectDeleteRequests.get(request.id).tracksPurgeReceipt;
  const project = f.s.tables.hostedProjects.get('project-0');
  delete project.lifecycle;
  delete project.task;
  project.purgeBlocked = 'R2_PURGE_RETRY_EXHAUSTED';
  project.r2Purge = { generation: 1, cursor: null, failures: 8 };
  const before = await f.call('read', { requestId: request.id, reconcile: true });
  assert.equal(before.projects[0].outcome, 'failed');
  const result = await f.call('retry', { requestId: request.id });
  assert.equal(result.projects[0].outcome, 'started');
  assert.equal(f.s.tables.hostedProjects.get('project-0').purgeBlocked, undefined);
  t.mock.timers.tick(purgeSettleMs);
  await finishPurge(f, 'project-0');
  assert.equal((await f.call('read', { requestId: request.id })).projects[0].outcome, 'deleted');
});

test('a project that gained a landing, changed revision or changed owner after the list was shown is skipped and named', async t => {
  const f = fixture(t, 3);
  const request = await prepare(f, { glob: 'bench-zoo-*' });
  // A new save landed on project-0 after the list was shown.
  f.s.tables.projectHostedAcceptances.set('landing-new', {
    _id: 'landing-new',
    _creationTime: fixtureNow,
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

test('an expired request deletes nothing and cannot be approved', async t => {
  const f = fixture(t, 2);
  const request = await prepare(f, { glob: 'bench-zoo-*' });
  t.mock.timers.setTime(Date.parse(request.expiresAt));
  f.as('owner');
  assert.equal((await f.call('read', { requestId: request.id })).status, 'expired');
  await assert.rejects(approve(f, request), code('WORK_STALE'));
  assert.ok([...f.s.tables.hostedProjects.values()].every(project => project.removal !== 'deleting'));
});

test('a purge that stops is recorded on the request; retry replays only those projects', async t => {
  const f = fixture(t, 2);
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

test('a decline and a withdrawal delete nothing and reach the requester through the same read', async t => {
  const f = fixture(t, 2);
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
