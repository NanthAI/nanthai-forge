// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { storageClock } from './storage-clock.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { invitationFixture, mail, policy, values, refusal } from './invitation-fixture.mjs';
const day = 86400000,
  hour = 3600000;
const snapshot = s =>
  JSON.stringify(Object.fromEntries(Object.entries(s.tables).map(([k, v]) => [k, [...v]])));
const seed = (s, owner, count, period = day) =>
  s.tables.deviceAttempts.set(owner, {
    _id: owner,
    _creationTime: 1,
    owner,
    windowAt: Date.now() - (Date.now() % period),
    count,
  });
for (const [name, key, count, period] of [
  ['20 per UTC hour per inviter', 'invitation:inviter-hour:owner', 20, hour],
  ['100 per UTC day per inviter', 'invitation:inviter-day:owner', 100, day],
  // The deployment and recipient caps hold the mail instead of refusing (P1-03):
  // tests/project-invitation-mail-parity.test.mjs.
])
  test(`email budget ${name} refuses before any write or schedule`, async t => {
    storageClock(t);
    const s = invitationFixture(t);
    seed(s, key, count, period);
    const before = snapshot(s),
      tasks = s.scheduled.length;
    await assert.rejects(s.invite(), refusal('RATE_LIMITED'));
    assert.equal(snapshot(s), before);
    assert.equal(s.scheduled.length, tasks);
  });

test('3 resends per invitation per UTC day refuses before writes; old resend retries never send again', async t => {
  storageClock(t);
  const s = invitationFixture(t),
    row = await s.invite();
  seed(s, `invitation:resend-day:project:${row.operationId}`, 3);
  await mail.settle._handler(s.ctx, { projectId: 'project', operationId: row.operationId, status: 'sent' });
  const before = snapshot(s);
  await assert.rejects(
    mail.resend._handler(s.ctx, {
      projectId: 'project',
      operationId: row.operationId,
      resendId: randomUUID(),
    }),
    refusal('RATE_LIMITED'),
  );
  assert.equal(snapshot(s), before);
  s.tables.deviceAttempts.clear();
  const first = randomUUID(),
    second = randomUUID();
  for (const resendId of [first, second]) {
    await mail.resend._handler(s.ctx, { projectId: 'project', operationId: row.operationId, resendId });
    await mail.settle._handler(s.ctx, {
      projectId: 'project',
      operationId: row.operationId,
      sendId: resendId,
      status: 'sent',
    });
  }
  const tasks = s.scheduled.length;
  await mail.resend._handler(s.ctx, { projectId: 'project', operationId: row.operationId, resendId: first });
  assert.equal(s.scheduled.length, tasks);
});
test('50 open email invitations per project counts email only and excludes ended or expired invitations', async t => {
  const s = invitationFixture(t);
  for (let i = 0; i < 50; i++)
    s.tables.projectInvites.set(`invite-${i}`, {
      _id: `invite-${i}`,
      _creationTime: Date.now(),
      projectId: 'project',
      kind: 'email',
      email: `person-${i}@example.test`,
      state: 'pending',
      expiresAt: Date.now() + day,
    });
  for (let i = 0; i < 75; i++)
    s.tables.projectInvites.set(`handle-${i}`, {
      _id: `handle-${i}`,
      _creationTime: Date.now(),
      projectId: 'project',
      kind: 'handle',
      email: `@person-${i}`,
      state: 'pending',
      expiresAt: Date.now() + day,
    });
  const before = snapshot(s);
  await assert.rejects(s.invite(), refusal('RATE_LIMITED'));
  assert.equal(snapshot(s), before);
  await s.ctx.db.patch('invite-0', { expiresAt: Date.now() });
  await s.invite();
  assert.equal(
    values(s, 'projectInvites').filter(
      row => row.kind === 'email' && policy.invitationStatus(row) === 'pending',
    ).length,
    50,
  );
});
test('counter boundaries reset in place and exact invitation retries charge nothing', async t => {
  storageClock(t);
  const s = invitationFixture(t);
  seed(s, 'invitation:inviter-hour:owner', 20, hour);
  s.tables.deviceAttempts.get('invitation:inviter-hour:owner').windowAt -= hour;
  const operationId = randomUUID();
  await s.invite('guest@example.test', { operationId });
  const before = snapshot(s);
  await s.invite('guest@example.test', { operationId });
  assert.equal(snapshot(s), before);
  assert.equal(s.tables.deviceAttempts.size, 4);
});
test('invitation email is independently off by default and unverified senders are refused before writes', async t => {
  const s = invitationFixture(t);
  delete process.env.FORGE_INVITATION_EMAIL;
  const row = await s.invite();
  assert.equal(row.mail.status, 'off');
  assert.equal(s.scheduled.length, 0);
  assert.equal(s.tables.deviceAttempts.size, 2);
  assert.ok(values(s, 'deviceAttempts').every(row => row.owner.startsWith('invitation:inviter-')));
  s.tables.users.get('verified-owner').emailVerified = false;
  const before = snapshot(s);
  await assert.rejects(s.invite('other@example.test'), refusal('AUTH_REQUIRED'));
  assert.equal(snapshot(s), before);
});
test('a send interrupted for ten minutes can resend without a late completion changing the new attempt', async t => {
  const s = invitationFixture(t),
    row = await s.invite();
  const operation = values(s, 'projectAccessOperations').find(value => value.operationId === row.operationId);
  await s.ctx.db.patch(operation._id, {
    mail: { ...operation.mail, at: Date.now() - policy.invitationSendTimeout },
  });
  const resendId = randomUUID();
  await mail.resend._handler(s.ctx, { projectId: 'project', operationId: row.operationId, resendId });
  await mail.settle._handler(s.ctx, {
    projectId: 'project',
    operationId: row.operationId,
    sendId: row.operationId,
    status: 'failed',
  });
  assert.equal(s.tables.projectAccessOperations.get(operation._id).mail.status, 'sending');
  assert.equal(
    await mail.details._handler(s.ctx, {
      projectId: 'project',
      operationId: row.operationId,
      sendId: row.operationId,
    }),
    null,
  );
});
