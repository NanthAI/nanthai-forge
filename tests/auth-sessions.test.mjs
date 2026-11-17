// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionAddress } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { fixture as accountFixture, assertion, refused, users } from './auth-links-fixture.mjs';
const sessionsApi = await import(moduleUrl('../convex/authSessions.ts'));
const first = await import(moduleUrl('../convex/authFirstPasskey.ts'));
const policy = await import(moduleUrl('../convex/accessPolicy.ts'));
function fixture(t) {
  const s = accountFixture(t, { github: true });
  const now = Date.now();
  s.sessions.set('session', { userId: 'user', creationTime: now, lastRefreshedAt: now });
  s.sessions.set('other', { userId: 'user', creationTime: now, lastRefreshedAt: now });
  s.sessions.set('stranger', { userId: 'someone-else', creationTime: now, lastRefreshedAt: now });
  s.tables.cliCredentials = new Map();
  const base = s.ctx.runQuery;
  const dispatch = async (ref, args) => {
    const name = getFunctionAddress(ref).reference ?? '';
    if (name.endsWith('/listSessions'))
      return [...s.sessions]
        .filter(([, row]) => row.userId === args.userId)
        .map(([sessionId, row]) => ({
          sessionId,
          creationTime: row.creationTime,
          lastRefreshedAt: row.lastRefreshedAt,
        }));
    if (name.endsWith('/revokeSessions')) {
      const removed = args.sessionIds.filter(id => s.sessions.has(id));
      for (const id of removed) s.sessions.delete(id);
      return removed;
    }
    return base(ref, args);
  };
  s.ctx.runQuery = dispatch;
  s.ctx.runMutation = dispatch;
  return s;
}
test('B-05: the account list contains only its sessions and passkeys, without bearer credentials', async t => {
  const s = fixture(t);
  s.keys.push({
    userId: 'user',
    passkeyId: 'ours',
    name: 'Security key',
    createdAt: 1,
    credentialId: 'not-returned',
  });
  s.keys.push({ userId: 'someone-else', passkeyId: 'theirs', createdAt: 1 });
  const result = await s.call(sessionsApi.list, { paginationOpts: { numItems: 20, cursor: null } });
  assert.deepEqual(
    result.sessions.map(row => [row.sessionId, row.current]),
    [
      ['session', true],
      ['other', false],
    ],
  );
  assert.deepEqual(result.passkeys, [{ passkeyId: 'ours', name: 'Security key', createdAt: 1 }]);
  assert.doesNotMatch(JSON.stringify(result), /not-returned|someone-else|tokenHash|refreshToken|accessToken/);
});
test('B-05: sign out other sessions requires a fresh passkey for the same account, retains this browser and other accounts, and retries safely', async t => {
  const s = fixture(t);
  await assert.rejects(
    s.call(sessionsApi.revokeOthers, { operationId: 'one', response: assertion }),
    refused('AUTH_REQUIRED'),
  );
  assert(s.sessions.has('other'));
  await s.call(sessionsApi.startConfirmation, {});
  assert.equal(await s.call(sessionsApi.revokeOthers, { operationId: 'one', response: assertion }), 1);
  assert(s.sessions.has('session'));
  assert(s.sessions.has('stranger'));
  assert(!s.sessions.has('other'));
  assert.equal(await s.call(sessionsApi.revokeOthers, { operationId: 'one', response: assertion }), 1);
  await assert.rejects(
    s.call(sessionsApi.revokeOthers, { operationId: 'one', response: { ...assertion, id: 'changed' } }),
    refused('WORK_OPERATION_CHANGED'),
  );
});
test('B-05: revoking the current browser during confirmation prevents any further session cleanup', async t => {
  const s = fixture(t);
  await s.call(sessionsApi.startConfirmation, {});
  s.sessions.delete('session');
  await assert.rejects(
    s.call(sessionsApi.revokeOthers, { operationId: 'one', response: assertion }),
    refused('AUTH_REQUIRED'),
  );
  assert(s.sessions.has('other'));
});
test('B-05: adding a first passkey records a notice; another browser independently sees the notice', async t => {
  const s = fixture(t);
  await s.call(first.start, {});
  await s.call(first.finish, {
    response: {
      id: 'credential',
      rawId: 'credential',
      type: 'public-key',
      response: { clientDataJSON: '', attestationObject: '' },
      clientExtensionResults: {},
    },
  });
  const notice = s.tables.users.get('user').passkeyNotice;
  assert.equal(notice.passkeyId, 'passkey-0');
  assert.deepEqual(
    (await s.call(sessionsApi.list, { paginationOpts: { numItems: 20, cursor: null } })).notice,
    notice,
  );
  s.identity({ subject: 'other', issuer: 'https://auth-fixture.convex.cloud/components/auth' });
  assert.deepEqual(
    (await s.call(sessionsApi.list, { paginationOpts: { numItems: 20, cursor: null } })).notice,
    notice,
    'another browser independently sees the security notice',
  );
});
test('B-07: every GitHub sign-in replaces the current verified address, including clearing it', async t => {
  const s = fixture(t);
  const signIn = profile =>
    s.call(users.signedInGithub, {
      userId: 'user',
      method: {
        name: 'github',
        profile: {
          id: '123',
          login: 'example',
          name: null,
          avatarUrl: null,
          email: null,
          emailVerified: false,
          ...profile,
        },
      },
    });
  await signIn({ email: 'Verified@Example.com', emailVerified: true });
  assert.equal(s.tables.users.get('user').email, 'verified@example.com');
  assert.equal(s.tables.users.get('user').emailVerified, true);
  await signIn({ email: 'unverified@example.com', emailVerified: false });
  assert.equal(s.tables.users.get('user').email, undefined);
  assert.equal(s.tables.users.get('user').emailVerified, false);
  await signIn({ email: null });
  assert.equal(s.tables.users.get('user').email, undefined);
});
test('C1 provisional policies have one decision point for each owner question', () => {
  assert(policy.mayTakeLane('person', 'person', 'owner'));
  assert(policy.mayTakeLane('owner', 'person', 'owner'));
  assert(!policy.mayTakeLane('stranger', 'person', 'owner'));
  assert(policy.takeoverNeedsReason(true));
  assert(!policy.takeoverNeedsReason(false));
  assert(policy.maySeeDeviceName('person', 'person'));
  assert(!policy.maySeeDeviceName('owner', 'person'));
  assert(policy.keepsDeviceSettings('signout'));
  assert(!policy.keepsDeviceSettings('remove'));
  assert.equal(policy.browserInactivitySeconds, 14 * 86400);
});

test('B-07: recipient lookup refuses ambiguous or unverified addresses and a passkey-only account cannot redeem email invitations', async t => {
  const s = fixture(t);
  const contributors = await import(moduleUrl('../convex/projectContributors.ts'));
  const user = s.tables.users.get('user');
  user.email = 'invite@example.com';
  user.emailVerified = true;
  assert.equal(await s.call(users.verifiedRecipient, { email: ' INVITE@example.com ' }), s.owner);
  user.emailVerified = false;
  assert.equal(await s.call(users.verifiedRecipient, { email: user.email }), null);
  user.emailVerified = true;
  s.tables.users.set('other-user', { ...user, _id: 'other-user', accountKey: 'user_other' });
  await assert.rejects(s.call(users.verifiedRecipient, { email: user.email }), refused('BAD_ARGUMENT'));
  s.tables.projectInvites = new Map([
    ['invite', { _id: 'invite', projectId: 'private-project', email: user.email }],
  ]);
  await contributors.redeemInvites(s.ctx, { subject: s.owner, forgeAuthUser: 'user', emailVerified: false });
  assert(s.tables.projectInvites.has('invite'));
  await assert.rejects(
    contributors.redeemInvites(s.ctx, {
      subject: s.owner,
      forgeAuthUser: 'user',
      email: user.email,
      emailVerified: true,
    }),
    refused('BAD_ARGUMENT'),
  );
  assert(s.tables.projectInvites.has('invite'));
});

test('C1 holder reader expansion preserves exact saved source and accepts earlier Lanes without a holder', async () => {
  const { hostedLaneSchema } = await import('../dist/hosted-lane.js');
  const base = {
    kind: 'lane',
    id: '10000000-0000-4000-8000-000000000001',
    version: 0,
    at: '2026-01-01T00:00:00.000Z',
    intentId: '10000000-0000-4000-8000-000000000002',
    actor: 'person',
    base: { head: 'a'.repeat(64), receiptId: 'receipt' },
    head: 'b'.repeat(64),
    sourceVersion: 1,
    lifecycleVersion: 0,
    state: 'active',
    authorityEpoch: 1,
  };
  assert.equal(hostedLaneSchema.parse(base).holder, undefined);
  const holder = { actor: 'person', agent: 'quiet-fox', since: 1, lastSeen: 2 };
  assert.deepEqual(hostedLaneSchema.parse({ ...base, holder }), { ...base, holder });
  const moved = {
    ...holder,
    sessionId: 'new-session',
    change: {
      operationId: '10000000-0000-4000-8000-000000000003',
      kind: 'takeover',
      by: 'person',
      previous: holder,
      reason: 'Continue the saved work',
      savedHead: base.head,
    },
  };
  const read = hostedLaneSchema.parse({ ...base, holder: moved });
  assert.equal(read.head, base.head);
  assert.equal(read.sourceVersion, base.sourceVersion);
  assert.deepEqual(read.holder.change.previous, holder);
});

const githubSessions = await import(moduleUrl('../convex/authSessionGithub.ts'));
function githubFixture(t) {
  const s = fixture(t);
  const base = s.ctx.runMutation;
  s.ctx.runMutation = async (ref, args) => {
    const result = await base(ref, args);
    if ((getFunctionAddress(ref).reference ?? '').endsWith('/_internal_dangerous_signIn')) {
      const now = Date.now();
      s.sessions.set('new-session', { userId: args.userId, creationTime: now, lastRefreshedAt: now });
      return {
        ...result,
        accessToken:
          'header.' +
          Buffer.from(JSON.stringify({ sub: 'new-session' })).toString('base64url') +
          '.signature',
      };
    }
    return result;
  };
  return s;
}
test('B-05: a fresh GitHub check ends only this account’s other browsers and keeps its new returning session', async t => {
  const s = githubFixture(t);
  const started = await s.call(githubSessions.startSignInWithGithub, {
    redirectTo: 'https://forge.example/-/account/devices',
  });
  const proof = await s.ticket(started.state);
  const result = await s.call(githubSessions.completeSignInWithGithub, proof);
  assert.equal(result.status, 'complete');
  assert(s.sessions.has('new-session'));
  assert(s.sessions.has('stranger'));
  assert(!s.sessions.has('other'));
  assert(!s.sessions.has('session'));
});
test('B-05: a GitHub re-check cannot use another account, another originating browser, expired state or a revoked browser', async t => {
  const s = githubFixture(t);
  const start = () =>
    s.call(githubSessions.startSignInWithGithub, { redirectTo: 'https://forge.example/-/account/devices' });
  let started = await start();
  await assert.rejects(
    s.call(githubSessions.completeSignInWithGithub, await s.ticket(started.state, 456)),
    refused('GITHUB_ACCOUNT_MISMATCH'),
  );
  assert(s.sessions.has('other'));
  started = await start();
  const proof = await s.ticket(started.state);
  s.tables.users.get('user').sessionEnd.sessionId = 'other';
  await assert.rejects(s.call(githubSessions.completeSignInWithGithub, proof), refused('AUTH_REQUIRED'));
  started = await start();
  s.tables.users.get('user').sessionEnd.verifiedUntil = 0;
  await assert.rejects(
    s.call(githubSessions.completeSignInWithGithub, await s.ticket(started.state)),
    refused('AUTH_REQUIRED'),
  );
  started = await start();
  const last = await s.ticket(started.state);
  s.sessions.delete('session');
  await assert.rejects(s.call(githubSessions.completeSignInWithGithub, last), refused('AUTH_REQUIRED'));
  assert(s.sessions.has('other'));
});
