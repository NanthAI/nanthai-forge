// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import {
  invitationFixture,
  contributors,
  answers,
  inbox,
  access,
  refusal,
  values,
  mail,
} from './invitation-fixture.mjs';
const readers = await import(moduleUrl('../convex/projectReaders.ts'));
const actions = await import(moduleUrl('../convex/projectContributorActions.ts'));
const work = await import(moduleUrl('../convex/projectWork.ts'));
const hour = 3_600_000,
  day = 86_400_000;
const snapshot = s =>
  JSON.stringify(Object.fromEntries(Object.entries(s.tables).map(([k, v]) => [k, [...v]])));

test('handle and email-off invitations across projects consume the same inviter allowance exactly once', async t => {
  const s = invitationFixture(t);
  delete process.env.FORGE_INVITATION_EMAIL;
  s.tables.hostedProjects.set('second', { ...s.tables.hostedProjects.get('project'), _id: 'second' });
  for (let i = 0; i < 20; i++) {
    const input = {
      projectId: i % 2 ? 'second' : 'project',
      owner: 'owner',
      person: i % 2 ? 'guest@example.test' : '@wren',
      operationId: randomUUID(),
    };
    s.caller('owner');
    await contributors.invite._handler(s.ctx, input);
    await contributors.invite._handler(s.ctx, input);
  }
  assert.equal(
    values(s, 'deviceAttempts').find(row => row.owner === 'invitation:inviter-hour:owner')?.count,
    20,
  );
  assert.equal(
    values(s, 'deviceAttempts').find(row => row.owner === 'invitation:inviter-day:owner')?.count,
    20,
  );
  assert.equal(s.tables.deviceAttempts.size, 2);
  const before = snapshot(s);
  await assert.rejects(s.invite('@wren'), refusal('RATE_LIMITED'));
  assert.equal(snapshot(s), before);
  assert.equal(s.scheduled.length, 0);
});

test('email-off resends share the inviter allowance without charging an email send or replay', async t => {
  const s = invitationFixture(t);
  delete process.env.FORGE_INVITATION_EMAIL;
  const row = await s.invite();
  const input = { projectId: 'project', operationId: row.operationId, resendId: randomUUID() };
  await mail.resend._handler(s.ctx, input);
  await mail.resend._handler(s.ctx, input);
  assert.equal(
    values(s, 'deviceAttempts').find(row => row.owner === 'invitation:inviter-hour:owner').count,
    2,
  );
  assert.equal(s.tables.deviceAttempts.size, 2);
  const counter = values(s, 'deviceAttempts').find(row => row.owner === 'invitation:inviter-hour:owner');
  await s.ctx.db.patch(counter._id, { count: 20 });
  const before = snapshot(s);
  await assert.rejects(
    mail.resend._handler(s.ctx, { ...input, resendId: randomUUID() }),
    refusal('RATE_LIMITED'),
  );
  assert.equal(snapshot(s), before);
  assert.equal(s.scheduled.length, 0);
});

for (const kind of ['handle', 'email-off'])
  for (const [window, limit, period] of [
    ['hour', 20, hour],
    ['day', 100, day],
  ])
    test(`${kind} invitations enforce the shared inviter ${window} budget before writes`, async t => {
      const s = invitationFixture(t),
        owner = `invitation:inviter-${window}:owner`;
      if (kind === 'email-off') delete process.env.FORGE_INVITATION_EMAIL;
      s.tables.deviceAttempts.set(owner, {
        _id: owner,
        _creationTime: 1,
        owner,
        count: limit,
        windowAt: Date.now() - (Date.now() % period),
      });
      const before = snapshot(s),
        tasks = s.scheduled.length;
      await assert.rejects(
        s.invite(kind === 'handle' ? '@wren' : 'guest@example.test'),
        refusal('RATE_LIMITED'),
      );
      assert.equal(snapshot(s), before);
      assert.equal(s.scheduled.length, tasks);
    });

test('an account block also hides and refuses an invitation from the same inviter in a new project', async t => {
  const s = invitationFixture(t),
    first = await s.invite('@wren');
  s.caller();
  await s.answer(first, 'block');
  s.tables.hostedProjects.set('second', {
    ...s.tables.hostedProjects.get('project'),
    _id: 'second',
    key: 'second',
    slug: 'second',
  });
  s.caller('owner');
  await contributors.invite._handler(s.ctx, {
    projectId: 'second',
    owner: 'owner',
    person: '@wren',
    operationId: randomUUID(),
    role: 'read',
  });
  const row = values(s, 'projectInvites').find(row => row.projectId === 'second');
  s.caller();
  assert.deepEqual((await inbox.inbox._handler(s.ctx, { kind: 'handle' })).rows, []);
  await assert.rejects(s.answer(row), refusal('BAD_ARGUMENT'));
  assert.equal(s.tables.projectReaders.size, 0);
});

test('expired current and pre-change invitations leave the recipient inbox', async t => {
  const s = invitationFixture(t),
    row = await s.invite();
  await s.ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
  s.tables.projectInvites.set('old', {
    _id: 'old',
    _creationTime: Date.now() - 8 * day,
    projectId: 'project',
    email: 'guest@example.test',
    operationId: 'old-expired',
  });
  s.tables.projectAccessOperations.set('old-expired', {
    _id: 'old-expired',
    _creationTime: Date.now() - 8 * day,
    projectId: 'project',
    operationId: 'old-expired',
    owner: 'owner',
    person: 'guest@example.test',
  });
  s.caller();
  assert.deepEqual((await inbox.inbox._handler(s.ctx, { kind: 'email' })).rows, []);
});

test('the legacy pending read returns a bounded live page without scanning kept invitation history', async () => {
  for (const total of [400, 800]) {
    const f = lanesFixture();
    const projectId = f.insert('hostedProjects', {
      owner: 'owner',
      name: 'Synthetic project',
      key: 'synthetic',
      slug: 'tools',
      currentBackup: null,
      revision: 0,
    });
    for (let i = 0; i < total; i++)
      f.insert('projectInvites', {
        projectId,
        email: `@z-live-${i}`,
        kind: 'handle',
        recipient: `person-${i}`,
        inviter: 'owner',
        state: 'pending',
        expiresAt: Date.now() + day,
      });
    for (let i = 0; i < 1000; i++)
      f.insert('projectInvites', {
        projectId,
        email: `@a-ended-${i}`,
        kind: 'handle',
        recipient: `ended-${i}`,
        inviter: 'owner',
        state: 'accepted',
        expiresAt: Date.now() + day,
      });
    const page = await f.call('Pending page', contributors.pending, { projectId });
    assert.equal(page.length, 50);
    const count = f.counts.at(-1);
    assert.ok(count.readDocumentsByTable.projectInvites <= 150, JSON.stringify(count));
    assert.equal(count.writes, 0);
    console.log(
      JSON.stringify({
        invitations: total,
        pendingDocuments: count.documents,
        pendingBytes: count.readBytes,
        pendingInvitationDocuments: count.readDocumentsByTable.projectInvites,
      }),
    );
  }
});

for (const removal of ['people', 'writer-api', 'reader-api'])
  test(`${removal} removal ends both kinds of old invitation; a fresh invitation works at the same time`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_900_000_000_000 });
    const s = invitationFixture(t),
      initial = await s.invite('@wren', { role: removal === 'reader-api' ? 'read' : 'write' });
    s.caller();
    await s.answer(initial);
    const handle = await s.invite('@wren', { role: 'write' }),
      email = await s.invite('guest@example.test', { role: 'write' });
    s.caller('owner');
    if (removal === 'people')
      await access.setRole._handler(s.ctx, {
        projectId: 'project',
        person: 'guest',
        role: 'none',
        operationId: randomUUID(),
      });
    if (removal === 'writer-api')
      await contributors.remove._handler(s.ctx, { projectId: 'project', contributor: 'guest' });
    if (removal === 'reader-api')
      await readers.set._handler(s.ctx, {
        projectId: 'project',
        owner: 'owner',
        reader: 'guest',
        present: false,
        operationId: randomUUID(),
      });
    s.caller();
    for (const row of [handle, email]) await assert.rejects(s.answer(row), refusal('BAD_ARGUMENT'));
    assert.deepEqual((await inbox.inbox._handler(s.ctx, { kind: 'handle' })).rows, []);
    assert.deepEqual((await inbox.inbox._handler(s.ctx, { kind: 'email' })).rows, []);
    assert.equal(s.tables.projectContributors.size, 0);
    assert.equal(s.tables.projectReaders.size, 0);
    const fresh = await s.invite('guest@example.test', { role: 'write' });
    s.caller();
    await s.answer(fresh);
    assert.equal(values(s, 'projectContributors')[0].contributor, 'guest');
  });

test('a snapshot opened before removal must retry and refuse an older invitation after removal commits', async () => {
  const f = lanesFixture();
  const projectId = f.insert('hostedProjects', {
    owner: 'owner',
    name: 'Synthetic project',
    key: 'synthetic',
    slug: 'tools',
    currentBackup: null,
    revision: 0,
  });
  f.insert('forgeAccounts', { owner: 'guest', handle: 'wren' });
  f.insert('projectContributors', { projectId, contributor: 'guest' });
  const invitationId = f.insert('projectInvites', {
    projectId,
    email: '@wren',
    kind: 'handle',
    recipient: 'guest',
    inviter: 'owner',
    state: 'pending',
    role: 'write',
    expiresAt: Date.now() + day,
  });
  let release, entered;
  const gate = new Promise(resolve => (release = resolve)),
    started = new Promise(resolve => (entered = resolve));
  f.decorateContext(async (_ctx, _input, name) => {
    if (name === 'Answer old invitation') {
      entered();
      await gate;
    }
  });
  const accepting = f.call(
    'Answer old invitation',
    answers.answer,
    { invitationId, choice: 'accept', operationId: randomUUID() },
    'guest',
  );
  await started;
  await f.call('Remove member', access.setRole, {
    projectId,
    person: 'guest',
    role: 'none',
    operationId: randomUUID(),
  });
  release();
  await assert.rejects(accepting, refusal('BAD_ARGUMENT'));
  assert.equal(f.tables.projectContributors.size, 0);
});

test('a removed recipient cannot receive an earlier queued invitation email', async t => {
  const s = invitationFixture(t);
  s.tables.users.set('recipient', {
    _id: 'recipient',
    _creationTime: 1,
    accountKey: 'guest',
    email: 'guest@example.test',
    emailVerified: true,
    emailConfirmedAt: Date.now(),
  });
  s.tables.projectContributors.set('member', {
    _id: 'member',
    _creationTime: 1,
    projectId: 'project',
    contributor: 'guest',
  });
  const row = await s.invite();
  assert.equal(
    (await mail.details._handler(s.ctx, { projectId: 'project', operationId: row.operationId })).suppressed,
    undefined,
  );
  await access.setRole._handler(s.ctx, {
    projectId: 'project',
    person: 'guest',
    role: 'none',
    operationId: randomUUID(),
  });
  assert.equal(
    (await mail.details._handler(s.ctx, { projectId: 'project', operationId: row.operationId })).suppressed,
    true,
  );
});

test('removal does not resolve a pending email address in the owner projection', async t => {
  const results = [];
  for (const known of [false, true]) {
    const s = invitationFixture(t);
    s.tables.projectContributors.set('member', {
      _id: 'member',
      _creationTime: 1,
      projectId: 'project',
      contributor: 'guest',
    });
    if (known)
      s.tables.users.set('recipient', {
        _id: 'recipient',
        _creationTime: 1,
        accountKey: 'guest',
        email: 'guest@example.test',
        emailVerified: true,
      });
    await s.invite('guest@example.test', { operationId: 'same-privacy-operation' });
    s.caller('owner');
    await access.setRole._handler(s.ctx, {
      projectId: 'project',
      person: 'guest',
      role: 'none',
      operationId: randomUUID(),
    });
    const p = await access.people._handler(s.ctx, { projectId: 'project' });
    results.push(
      p.invited.map(({ id, at, expiresAt, mail, ...rest }) => ({ ...rest, mail: { ...mail, at: 0 } })),
    );
  }
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0][0].state, 'pending');
});

for (const originalOwner of ['former-owner', null])
  test(`pre-change invitations require a provable current inviter (${originalOwner ?? 'missing operation'})`, async t => {
    const s = invitationFixture(t),
      row = {
        _id: 'legacy',
        _creationTime: Date.now() - 60_000,
        projectId: 'project',
        email: 'guest@example.test',
        operationId: 'legacy-op',
        role: 'read',
      };
    s.tables.projectInvites.set(row._id, row);
    if (originalOwner)
      s.tables.projectAccessOperations.set('legacy-op', {
        _id: 'legacy-op',
        _creationTime: row._creationTime,
        projectId: 'project',
        owner: originalOwner,
        operationId: row.operationId,
        person: row.email,
        role: row.role,
      });
    s.caller();
    await assert.rejects(s.answer(row), refusal('PROJECT_UNAVAILABLE'));
    assert.deepEqual((await inbox.inbox._handler(s.ctx, { kind: 'email' })).rows, []);
    assert.equal(s.tables.projectReaders.size, 0);
  });

test('legacy add explains an ended invitation instead of silently succeeding', async t => {
  const s = invitationFixture(t),
    input = { projectId: 'project', owner: 'owner', contributor: 'guest' };
  s.caller('owner');
  await contributors.add._handler(s.ctx, input);
  const row = values(s, 'projectInvites')[0];
  s.caller();
  await s.answer(row, 'decline');
  s.caller('owner');
  await assert.rejects(
    contributors.add._handler(s.ctx, input),
    e => refusal('BAD_ARGUMENT')(e) && /new invitation/i.test(e.data?.message ?? e.message),
  );
});

test('legacy addByEmail explains an ended invitation instead of silently succeeding', async t => {
  const s = invitationFixture(t),
    native = s.ctx.runQuery;
  s.ctx.runQuery = (ref, args) =>
    getFunctionName(ref) === 'projectWork:owner' ? work.owner._handler(s.ctx, args) : native(ref, args);
  s.ctx.runMutation = (ref, args) =>
    getFunctionName(ref) === 'projectContributors:invite'
      ? contributors.invite._handler(s.ctx, args)
      : native(ref, args);
  s.caller('owner');
  await actions.addByEmail._handler(s.ctx, { projectId: 'project', email: 'guest@example.test' });
  const row = values(s, 'projectInvites')[0];
  s.caller();
  await s.answer(row, 'decline');
  s.caller('owner');
  await assert.rejects(
    actions.addByEmail._handler(s.ctx, { projectId: 'project', email: 'guest@example.test' }),
    e => refusal('BAD_ARGUMENT')(e) && /new invitation/i.test(e.data?.message ?? e.message),
  );
});
