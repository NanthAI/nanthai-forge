// SPDX-License-Identifier: Apache-2.0
// Invitation creation no longer probes another person's identity. Current verified
// binding checks still protect acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { invitationFixture, refusal, mail } from './invitation-fixture.mjs';
const actions = await import(moduleUrl('../convex/projectContributorActions.ts'));
const users = await import(moduleUrl('../convex/authUsers.ts'));
const work = await import(moduleUrl('../convex/projectWork.ts'));
const contributors = await import(moduleUrl('../convex/projectContributors.ts'));
const recipients = await import(moduleUrl('../convex/projectInvitationRecipient.ts'));
const approvals = await import(moduleUrl('../convex/projectMemberApprovals.ts'));
const policy = await import(moduleUrl('../convex/projectInvitationPolicy.ts'));
const email = 'guest@example.test';

test('email invitation and legacy addByEmail neither look up nor disclose recipients; retries stay pending', async t => {
  const s = invitationFixture(t),
    oldFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = oldFetch;
  });
  globalThis.fetch = () => {
    throw new Error('Invitation creation must not query an identity provider');
  };
  const original = s.ctx.runQuery;
  s.ctx.runQuery = s.ctx.runMutation = (ref, args) => {
    const [module, name] = getFunctionName(ref).split(':');
    return (
      { projectWork: work, projectContributors: contributors }[module]?.[name]?._handler(s.ctx, args) ??
      original(ref, args)
    );
  };
  const operationId = randomUUID();
  await actions.invitePerson._handler(s.ctx, { projectId: 'project', person: email, operationId });
  await actions.invitePerson._handler(s.ctx, { projectId: 'project', person: email, operationId });
  assert.equal(s.tables.projectInvites.size, 1);
  assert.equal(s.tables.projectContributors.size, 0);
  await actions.addByEmail._handler(s.ctx, { projectId: 'project', email });
  assert.equal(s.tables.projectContributors.size, 0);
  assert.equal([...s.tables.projectInvites.values()].filter(row => row.state === 'pending').length, 1);
});
test('native current verification and uniqueness are rechecked for acceptance; a legacy secondary never becomes a native claim', async t => {
  const s = invitationFixture(t);
  const native = {
    _id: 'native',
    _creationTime: 1,
    accountKey: 'guest',
    email,
    emailVerified: true,
    emailConfirmedAt: Date.now(),
  };
  s.tables.users.set('native', native);
  const user = { subject: 'guest', forgeAuthUser: 'native', email, emailVerified: true };
  assert.equal(await recipients.recipientEmail(s.ctx, user), email);
  native.emailVerified = false;
  assert.equal(await recipients.recipientEmail(s.ctx, user), null);
  native.emailVerified = true;
  s.tables.users.set('conflict', { ...native, _id: 'conflict', accountKey: 'other' });
  assert.equal(await recipients.recipientEmail(s.ctx, user), null);
  s.tables.users.delete('conflict');
  native.email = 'new-primary@example.test';
  assert.equal(await recipients.recipientEmail(s.ctx, user), null);
  assert.equal(
    await recipients.recipientEmail(s.ctx, { subject: 'guest', email, emailVerified: true }),
    email,
  );
  assert.equal(await users.verifiedRecipient._handler(s.ctx, { email }), null);
});
test('delayed membership approval creates a pending invitation and ignores a previously resolved email account', async t => {
  const s = invitationFixture(t);
  await approvals.applyApprovedMember(s.ctx, {
    projectId: 'project',
    requester: 'owner',
    setting: {
      request: JSON.stringify({
        kind: 'invite',
        person: email,
        contributor: 'stale-account',
        operationId: randomUUID(),
      }),
    },
  });
  assert.equal(s.tables.projectContributors.size, 0);
  assert.equal([...s.tables.projectInvites.values()][0].recipient, undefined);
});
test('recipient lookup remains one bounded indexed read at 400 and 800 people', async () => {
  for (const total of [400, 800]) {
    const f = lanesFixture();
    for (let i = 0; i < total; i++)
      f.insert('users', {
        accountKey: `native-${i}`,
        email: `person-${i}@example.test`,
        emailVerified: true,
        emailConfirmedAt: Date.now(),
      });
    assert.equal(
      await f.call('verified lookup', users.verifiedRecipient, { email: 'person-3@example.test' }),
      'native-3',
    );
    const count = f.counts.at(-1);
    assert.deepEqual([count.documents, count.ranges, count.writes], [1, 1, 0]);
  }
});

test('a retained email-resolved contributor approval keeps the typed address pending without exposing its former account', async t => {
  const s = invitationFixture(t);
  await approvals.applyApprovedMember(s.ctx, {
    projectId: 'project',
    requester: 'owner',
    setting: { request: JSON.stringify({ kind: 'contributor', contributor: 'former-recipient', email }) },
  });
  const row = [...s.tables.projectInvites.values()][0];
  assert.equal(row.email, email);
  assert.equal(row.recipient, undefined);
  assert.equal(s.tables.projectContributors.size, 0);
});
test('Issue 16723708: an address no provider confirmed within 90 days is no recipient until GitHub refreshes it', async t => {
  const s = invitationFixture(t);
  const day = 86_400_000;
  const row = {
    _id: 'native',
    _creationTime: Date.now() - 400 * day,
    accountKey: 'guest',
    email,
    emailVerified: true,
  };
  s.tables.users.set('native', row);
  const user = { subject: 'guest', forgeAuthUser: 'native', email, emailVerified: true };
  // A passkey-only account keeps its old address: counted from creation, it is stale.
  assert.equal(await users.verifiedRecipient._handler(s.ctx, { email }), null);
  assert.equal(await recipients.recipientEmail(s.ctx, user), null);
  row.emailConfirmedAt = Date.now() - 91 * day;
  assert.equal(await users.verifiedRecipient._handler(s.ctx, { email }), null);
  row.emailConfirmedAt = Date.now() - 89 * day;
  assert.equal(await users.verifiedRecipient._handler(s.ctx, { email }), 'guest');
  assert.equal(await recipients.recipientEmail(s.ctx, user), email);
  // A GitHub sign-in confirms the address again; one without a verified address clears it.
  row.githubId = '42';
  row.emailConfirmedAt = Date.now() - 200 * day;
  s.tables.users.set('native', row);
  const profile = { id: '42', login: 'guest', email: 'Guest@Example.test', emailVerified: true };
  const signedInAt = Date.now();
  await users.signedInGithub._handler(s.ctx, { method: { name: 'github', profile }, userId: 'native' });
  assert.ok(
    s.tables.users.get('native').emailConfirmedAt >= signedInAt,
    'the sign-in confirms the address now',
  );
  assert.equal(await users.verifiedRecipient._handler(s.ctx, { email }), 'guest');
  // Invitations still refuse an address two accounts hold, fresh or not.
  s.tables.users.set('other', { ...s.tables.users.get('native'), _id: 'other', accountKey: 'other' });
  await assert.rejects(users.verifiedRecipient._handler(s.ctx, { email }), refusal('BAD_ARGUMENT'));
});

test('Issue 16723708: the age rule only gates granting; a stale account that blocked an inviter stays protected', async t => {
  const s = invitationFixture(t);
  const day = 86_400_000;
  // A passkey-only account whose address no provider confirmed for 91 days.
  s.tables.users.set('native', {
    _id: 'native',
    _creationTime: Date.now() - 400 * day,
    accountKey: 'guest',
    email,
    emailVerified: true,
    emailConfirmedAt: Date.now() - 91 * day,
  });
  const stale = ['guest', email, { forgeAuthUser: 'native' }];
  assert.equal(await users.verifiedRecipient._handler(s.ctx, { email }), null, 'no grant at this age');
  // Blocking a handle-addressed invitation still records the account's address.
  const byHandle = await s.invite('@wren');
  s.caller(...stale);
  await s.answer(byHandle, 'block');
  const [block] = [...s.tables.invitationBlocks.values()];
  assert.equal(block.recipient, 'guest');
  assert.equal(block.emailHash, policy.invitationEmailHash(email));
  // An older block without the address: mail to that address is still suppressed by the account block.
  delete block.emailHash;
  const byEmail = await s.invite(email);
  const details = await mail.details._handler(s.ctx, {
    projectId: 'project',
    operationId: byEmail.operationId,
  });
  assert.equal(details.suppressed, true);
  // Nothing is granted: the stale address cannot claim the email invitation.
  s.caller(...stale);
  await assert.rejects(s.answer(byEmail), refusal('PROJECT_UNAVAILABLE'));
  assert.equal(s.tables.projectReaders.size, 0);
});
