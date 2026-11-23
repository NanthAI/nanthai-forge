// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, links, binding, refused, assertion } from './auth-links-fixture.mjs';

async function begin(s) {
  return s.call(links.startSignInWithGithub, { redirectTo: 'https://forge.example/signin/passkey' });
}

test('a passkey account links a provider-attested numeric GitHub identity without creating an account and can connect repositories', async t => {
  const s = fixture(t);
  s.keys.push({ userId: 'user', passkeyId: 'existing' });
  await assert.rejects(begin(s), refused('AUTH_REQUIRED'));
  await s.call(links.startConfirmation, {});
  await s.call(links.confirm, { response: assertion });
  const started = await begin(s);
  const args = await s.ticket(started.state);
  const result = await s.call(links.completeSignInWithGithub, args);
  assert.equal(result.status, 'complete');
  assert.equal(result.tokens.userId, 'user');
  assert.equal(s.tables.users.size, 1);
  assert.equal(s.bindings.get('123'), 'user');
  assert.equal(s.tables.users.get('user').githubId, '123');
  assert.equal(s.tables.authLinkEvents.size, 1);
  assert.deepEqual(await binding.linkedGithubAccounts(s.ctx, s.owner), ['123']);
  const repo = await binding.proveRepository(
    'synthetic-token',
    'synthetic/repo',
    ['123'],
    async () => 9,
    async url =>
      Response.json(
        url.endsWith('/user')
          ? { id: 123 }
          : url.includes('/user/installations/')
            ? { repositories: [{ id: 42 }] }
            : { id: 42, full_name: 'synthetic/repo', permissions: { admin: true } },
      ),
  );
  assert.equal(repo.repoId, 42);
  const replay = await s.call(links.completeSignInWithGithub, args);
  assert.equal(replay.userError.error, 'INVALID_CODE');
  assert.equal(await links.current._handler(s.ctx, {}), true);
  assert.equal(s.tables.authLinkEvents.size, 1);
  assert.equal(s.bindings.size, 1);
});

test('GitHub linking refuses component or application identities bound elsewhere and rolls the ticket back', async t => {
  for (const conflict of ['component', 'user', 'flag', 'different']) {
    const s = fixture(t);
    if (conflict === 'component') s.bindings.set('123', 'other');
    if (conflict === 'user')
      s.tables.users.set('other', {
        _id: 'other',
        _creationTime: 1,
        accountKey: 'user_other',
        githubId: '123',
        emailVerified: false,
      });
    if (conflict === 'flag') s.tables.users.get('user').githubConflict = true;
    if (conflict === 'different') s.tables.users.get('user').githubId = '456';
    const started = await begin(s),
      args = await s.ticket(started.state);
    await assert.rejects(s.call(links.completeSignInWithGithub, args), refused('GITHUB_ACCOUNT_MISMATCH'));
    assert.equal(s.tables.authLinkEvents.size, 0);
    assert.equal(s.tickets.size, 1);
    assert.equal(s.sessions.size, 1);
  }
});

test('GitHub completion requires the same live account and session, original state, and any newly added passkey', async t => {
  const s = fixture(t),
    started = await begin(s),
    args = await s.ticket(started.state);
  await assert.rejects(
    s.call(links.completeSignInWithGithub, { ...args, state: 'other' }),
    refused('AUTH_REQUIRED'),
  );
  s.sessions.set('other-session', { userId: 'user' });
  s.identity({ issuer: 'https://auth-fixture.convex.cloud/components/auth', subject: 'other-session' });
  await assert.rejects(s.call(links.completeSignInWithGithub, args), refused('AUTH_REQUIRED'));
  s.sessions.delete('other-session');
  s.sessions.delete('session');
  await assert.rejects(s.call(links.completeSignInWithGithub, args), refused('AUTH_REQUIRED'));
  assert.equal(s.tables.authLinkEvents.size, 0);
  assert.equal(s.bindings.size, 0);
});

test('newly added passkeys prevent an unconfirmed GitHub grant and malformed or unproved identities never link', async t => {
  const s = fixture(t),
    started = await begin(s),
    args = await s.ticket(started.state);
  s.keys.push({ userId: 'user', passkeyId: 'new' });
  await assert.rejects(s.call(links.completeSignInWithGithub, args), refused('AUTH_REQUIRED'));
  s.keys.length = 0;
  assert.equal(
    (await s.call(links.completeSignInWithGithub, { ...args, code: 'unknown' })).userError.error,
    'INVALID_CODE',
  );
  const malformed = await s.ticket(started.state, 'not-numeric', 'malformed');
  await assert.rejects(s.call(links.completeSignInWithGithub, malformed), refused('GITHUB_RESPONSE'));
  assert.equal(s.bindings.size, 0);
  assert.equal(s.tables.authLinkEvents.size, 0);
});

test('binding failure atomically rolls back the profile, minted session, ticket consumption and audit', async t => {
  const s = fixture(t),
    started = await begin(s),
    args = await s.ticket(started.state);
  s.failBinding();
  await assert.rejects(s.call(links.completeSignInWithGithub, args), refused('HOSTED_REQUEST_FAILED'));
  assert.equal(s.tables.users.get('user').githubId, undefined);
  assert.equal(s.sessions.size, 1);
  assert.equal(s.tickets.size, 1);
  assert.equal(s.tables.authLinkEvents.size, 0);
});
