// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  invitationFixture,
  contributors,
  answers,
  inbox,
  mail,
  access,
  values,
  refusal,
} from './invitation-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const accounts = await import(moduleUrl('../convex/urlAccounts.ts'));
const { guard } = await import(moduleUrl('../convex/cliServer.ts'));

test('handle and email invitations grant nothing until their recipient accepts; acceptance replays without restoring a removed grant', async t => {
  for (const person of ['@wren', 'guest@example.test']) {
    const s = invitationFixture(t),
      row = await s.invite(person);
    assert.equal(s.tables.projectReaders.size, 0);
    assert.equal(s.tables.projectContributors.size, 0);
    s.caller();
    await accounts.ensure._handler(s.ctx, {});
    assert.equal(s.tables.projectReaders.size, 0, 'sign-in does not accept');
    const list = await inbox.inbox._handler(s.ctx, { kind: person.startsWith('@') ? 'handle' : 'email' });
    assert.equal(list.rows[0].invitationId, row._id);
    const operationId = randomUUID();
    await s.answer(row, 'accept', operationId);
    assert.equal(values(s, 'projectReaders')[0].reader, 'guest');
    assert.equal(values(s, 'projectInvites')[0].state, 'accepted');
    s.tables.projectReaders.clear();
    s.caller('guest', 'changed@example.test', { emailVerified: false });
    await s.answer(row, 'accept', operationId);
    assert.equal(s.tables.projectReaders.size, 0);
    await assert.rejects(s.answer(row, 'decline', operationId), refusal('WORK_OPERATION_CHANGED'));
  }
});
test('acceptance preserves existing write access and can lift read to write', async t => {
  const s = invitationFixture(t);
  let row = await s.invite('@wren');
  s.tables.projectContributors.set('writer', {
    _id: 'writer',
    _creationTime: 1,
    projectId: 'project',
    contributor: 'guest',
  });
  s.caller();
  await s.answer(row);
  assert.equal(s.tables.projectReaders.size, 0);
  assert.equal(s.tables.projectContributors.size, 1);
  s.tables.projectContributors.clear();
  s.tables.projectReaders.set('reader', {
    _id: 'reader',
    _creationTime: 1,
    projectId: 'project',
    reader: 'guest',
  });
  row = await s.invite('@wren', { role: 'write' });
  s.caller();
  await s.answer(row);
  assert.equal(s.tables.projectReaders.size, 0);
  assert.equal(values(s, 'projectContributors')[0].contributor, 'guest');
});
test('a forwarded link grants nothing; wrong accounts, stale addresses, ambiguous bindings and devices cannot accept', async t => {
  const s = invitationFixture(t),
    row = await s.invite();
  s.tables.cliCredentials.set('invitation-device', {
    _id: 'invitation-device',
    _creationTime: 1,
    owner: 'guest',
    credentialId: 'valid-invitation-device',
    name: 'Invitation test device',
    scope: 'cli',
    tokenHash: 'synthetic',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    revoked: false,
  });
  const cases = [
    ['other', 'other@example.test', {}],
    ['guest', row.email, { emailVerified: false }],
    ['guest', row.email, { forgeCredential: 'valid-invitation-device' }],
    ['guest', row.email, { forgeAuthUser: 'cleared-user' }],
  ];
  for (const [subject, email, fields] of cases) {
    s.caller(subject, email, fields);
    if (fields.forgeCredential)
      assert.equal((await guard(s.ctx, 'cli')).forgeDevice._id, 'invitation-device');
    await assert.rejects(s.answer(row), refusal('PROJECT_UNAVAILABLE'));
    assert.equal(s.tables.projectReaders.size, 0);
  }
  s.tables.users.set('native', {
    _id: 'native',
    _creationTime: 1,
    accountKey: 'guest',
    email: row.email,
    emailVerified: true,
  });
  s.tables.users.set('conflict', {
    _id: 'conflict',
    _creationTime: 1,
    accountKey: 'other',
    email: row.email,
    emailVerified: true,
  });
  s.caller();
  await assert.rejects(s.answer(row), refusal('PROJECT_UNAVAILABLE'));
  s.tables.users.delete('conflict');
  s.tables.users.get('native').emailVerified = false;
  s.caller('guest', row.email, { forgeAuthUser: 'native' });
  await assert.rejects(s.answer(row), refusal('PROJECT_UNAVAILABLE'));
});
test('a handle invitation refuses a different account even when it claims the invited email', async t => {
  const s = invitationFixture(t),
    row = await s.invite('@wren');
  s.caller('other', 'guest@example.test');
  await assert.rejects(s.answer(row), refusal('PROJECT_UNAVAILABLE'));
  assert.equal(s.tables.projectReaders.size, 0);
  assert.equal(s.tables.projectContributors.size, 0);
  s.caller();
  await s.answer(row);
  assert.equal(values(s, 'projectReaders')[0].reader, 'guest');
});
test('a pre-change email invitation grants nothing on sign-in and waits for its verified recipient to accept', async t => {
  const s = invitationFixture(t),
    createdAt = Date.now() - 60_000;
  const row = {
    _id: 'pre-change-invitation',
    _creationTime: createdAt,
    projectId: 'project',
    email: 'guest@example.test',
    role: 'read',
    operationId: 'pre-change-operation',
  };
  s.tables.projectInvites.set(row._id, row);
  s.tables.projectAccessOperations.set(row.operationId, {
    _id: row.operationId,
    _creationTime: createdAt,
    projectId: row.projectId,
    owner: 'owner',
    operationId: row.operationId,
    person: row.email,
    role: row.role,
  });
  s.caller();
  await accounts.ensure._handler(s.ctx, {});
  assert.equal(s.tables.projectReaders.size, 0);
  assert.equal(s.tables.projectContributors.size, 0);
  const listed = (await inbox.inbox._handler(s.ctx, { kind: 'email' })).rows;
  assert.equal(listed[0]?.invitationId, row._id);
  assert.equal(listed[0]?.state, 'pending');
  assert.equal(listed[0]?.expiresAt, createdAt + 7 * 86_400_000);
  s.caller('other', 'other@example.test');
  await assert.rejects(s.answer(row), refusal('PROJECT_UNAVAILABLE'));
  s.caller();
  await s.answer(row);
  assert.equal(values(s, 'projectReaders')[0].reader, 'guest');
  assert.equal(s.tables.projectInvites.get(row._id).state, 'accepted');
});
test('a pre-change invitation older than seven days cannot grant access', async t => {
  const s = invitationFixture(t);
  const row = {
    _id: 'expired-pre-change-invitation',
    _creationTime: Date.now() - 7 * 86_400_000 - 60_000,
    projectId: 'project',
    email: 'guest@example.test',
    role: 'read',
    operationId: 'expired-pre-change-operation',
  };
  s.tables.projectInvites.set(row._id, row);
  s.tables.projectAccessOperations.set(row.operationId, {
    _id: row.operationId,
    _creationTime: row._creationTime,
    projectId: row.projectId,
    owner: 'owner',
    operationId: row.operationId,
    person: row.email,
    role: row.role,
  });
  s.caller();
  await assert.rejects(s.answer(row), refusal('BAD_ARGUMENT'));
  assert.equal(s.tables.projectReaders.size, 0);
  assert.equal(s.tables.projectContributors.size, 0);
});
test('owner reads are identical for known, unknown and ambiguous email recipients until acceptance', async t => {
  const snapshots = [];
  for (const count of [0, 1, 2]) {
    const s = invitationFixture(t);
    for (let i = 0; i < count; i++)
      s.tables.users.set(`recipient-${i}`, {
        _id: `recipient-${i}`,
        _creationTime: 1,
        accountKey: `person-${i}`,
        email: 'guest@example.test',
        emailVerified: true,
      });
    const row = await s.invite('guest@example.test', { operationId: 'same-operation' });
    const result = await access.people._handler(s.ctx, { projectId: 'project' });
    snapshots.push({
      ...result,
      invited: result.invited.map(({ id, at, expiresAt, mail, ...rest }) => ({
        ...rest,
        mail: { ...mail, at: 0 },
      })),
    });
    assert.equal(row.recipient, undefined);
  }
  assert.deepEqual(snapshots[0], snapshots[1]);
  assert.deepEqual(snapshots[1], snapshots[2]);
});
test('decline keeps membership unchanged and block hides later invitations, suppresses mail and can be undone', async t => {
  const s = invitationFixture(t),
    first = await s.invite();
  s.caller();
  await s.answer(first, 'decline');
  assert.equal(s.tables.projectReaders.size, 0);
  const second = await s.invite();
  s.caller();
  await s.answer(second, 'block');
  const third = await s.invite();
  s.caller();
  assert.deepEqual((await inbox.inbox._handler(s.ctx, { kind: 'email' })).rows, []);
  await assert.rejects(s.answer(third), refusal('BAD_ARGUMENT'));
  assert.equal(
    (await mail.details._handler(s.ctx, { projectId: 'project', operationId: third.operationId })).suppressed,
    true,
  );
  const [block] = (await inbox.blocked._handler(s.ctx, {})).rows;
  s.caller('other');
  await assert.rejects(
    answers.unblock._handler(s.ctx, {
      id: block.id,
      expectedVersion: block.version,
      operationId: randomUUID(),
    }),
  );
  s.caller();
  const op = randomUUID();
  await answers.unblock._handler(s.ctx, { id: block.id, expectedVersion: block.version, operationId: op });
  await answers.unblock._handler(s.ctx, { id: block.id, expectedVersion: block.version, operationId: op });
  assert.equal((await inbox.inbox._handler(s.ctx, { kind: 'email' })).rows.length, 1);
});
test('seven-day expiry, cancellation and replacement end acceptance, resend and delivery without extending expiry', async t => {
  for (const ending of ['expiry', 'cancel', 'replace', 'accept']) {
    const s = invitationFixture(t),
      row = await s.invite();
    if (ending === 'expiry') await s.ctx.db.patch(row._id, { expiresAt: Date.now() });
    if (ending === 'cancel')
      await contributors.cancelInvite._handler(s.ctx, { projectId: 'project', id: row._id });
    if (ending === 'replace') await s.invite();
    if (ending === 'accept') {
      s.caller();
      await s.answer(row);
    }
    s.caller();
    await assert.rejects(s.answer(row), refusal('BAD_ARGUMENT'));
    s.caller('owner');
    await assert.rejects(
      mail.resend._handler(s.ctx, {
        projectId: 'project',
        operationId: row.operationId,
        resendId: randomUUID(),
      }),
      refusal('BAD_ARGUMENT'),
    );
    assert.equal(
      await mail.details._handler(s.ctx, { projectId: 'project', operationId: row.operationId }),
      null,
    );
  }
});

test('an inviter blocked by handle cannot mail a later current verified address for the same account', async t => {
  const s = invitationFixture(t),
    handle = await s.invite('@wren');
  s.caller();
  await s.answer(handle, 'block');
  s.tables.users.set('current-recipient', {
    _id: 'current-recipient',
    _creationTime: 1,
    accountKey: 'guest',
    email: 'changed@example.test',
    emailVerified: true,
  });
  const email = await s.invite('changed@example.test');
  const details = await mail.details._handler(s.ctx, {
    projectId: 'project',
    operationId: email.operationId,
  });
  assert.equal(details.suppressed, true);
});
