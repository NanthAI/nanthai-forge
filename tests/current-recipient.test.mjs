// SPDX-License-Identifier: Apache-2.0
// Invitation creation no longer probes another person's identity. Current verified
// binding checks still protect acceptance and the unchanged team integration API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { invitationFixture, refusal } from './invitation-fixture.mjs';
const actions = await import(moduleUrl('../convex/projectContributorActions.ts'));
const teams = await import(moduleUrl('../convex/teams.ts'));
const teamActions = await import(moduleUrl('../convex/teamActions.ts'));
const users = await import(moduleUrl('../convex/authUsers.ts'));
const work = await import(moduleUrl('../convex/projectWork.ts'));
const contributors = await import(moduleUrl('../convex/projectContributors.ts'));
const recipients = await import(moduleUrl('../convex/projectInvitationRecipient.ts'));
const approvals = await import(moduleUrl('../convex/projectMemberApprovals.ts'));
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
  const native = { _id: 'native', _creationTime: 1, accountKey: 'guest', email, emailVerified: true };
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
test('team email additions retain mixed-provider ambiguity refusal and revalidate inside the grant mutation', async t => {
  const s = invitationFixture(t),
    fetch = globalThis.fetch,
    key = process.env.CLERK_SECRET_KEY;
  t.after(() => {
    globalThis.fetch = fetch;
    if (key === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = key;
  });
  process.env.CLERK_SECRET_KEY = 'synthetic';
  const native = { _id: 'native', _creationTime: 1, accountKey: 'guest', email, emailVerified: true };
  s.tables.users.set('native', native);
  s.tables.teams.set('team', {
    _id: 'team',
    _creationTime: 1,
    owner: 'owner',
    name: 'Synthetic',
    operationId: randomUUID(),
  });
  let legacy = 'other',
    beforeGrant;
  globalThis.fetch = async () =>
    Response.json([
      { id: legacy, email_addresses: [{ email_address: email, verification: { status: 'verified' } }] },
    ]);
  const original = s.ctx.runQuery;
  s.ctx.runQuery = s.ctx.runMutation = (ref, args) => {
    const [module, method] = getFunctionName(ref).split(':');
    if (module === 'teams') {
      if (method === 'add') beforeGrant?.();
      return teams[method]._handler(s.ctx, args);
    }
    return original(ref, args);
  };
  await assert.rejects(
    teamActions.addByEmail._handler(s.ctx, { id: 'team', email }),
    refusal('BAD_ARGUMENT'),
  );
  assert.equal(s.tables.teamMembers.size, 0);
  legacy = 'guest';
  await teamActions.addByEmail._handler(s.ctx, { id: 'team', email });
  assert.equal(s.tables.teamMembers.size, 1);
  s.tables.teamMembers.clear();
  beforeGrant = () => {
    native.emailVerified = false;
  };
  await assert.rejects(
    teamActions.addByEmail._handler(s.ctx, { id: 'team', email }),
    refusal('BAD_ARGUMENT'),
  );
  assert.equal(s.tables.teamMembers.size, 0);
});
test('recipient lookup remains one bounded indexed read at 400 and 800 people', async () => {
  for (const total of [400, 800]) {
    const f = lanesFixture();
    for (let i = 0; i < total; i++)
      f.insert('users', {
        accountKey: `native-${i}`,
        email: `person-${i}@example.test`,
        emailVerified: true,
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
