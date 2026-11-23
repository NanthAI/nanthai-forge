// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// de67c77d review: with the old provider gone, Forge itself renews an expiring GitHub App user token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { fixtureKeyring, state } from './hosted-fixture.mjs';

const tokens = await import(moduleUrl('../convex/githubUserTokens.ts'));
const actions = await import(moduleUrl('../convex/githubUserTokenActions.ts'));

const NOW = 1_800_000_000_000;
function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const names = ['FORGE_GITHUB_TOKEN_KEYRING', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET'];
  const prior = names.map(name => process.env[name]);
  Object.assign(process.env, {
    FORGE_GITHUB_TOKEN_KEYRING: fixtureKeyring,
    GITHUB_APP_CLIENT_ID: 'synthetic-client',
    GITHUB_APP_CLIENT_SECRET: 'synthetic-secret',
  });
  t.after(() =>
    names.forEach((name, i) =>
      prior[i] === undefined ? delete process.env[name] : (process.env[name] = prior[i]),
    ),
  );
  const s = state([]);
  s.tables.users = new Map([
    ['u', { _id: 'u', _creationTime: 1, accountKey: 'owner', githubId: '7', emailVerified: false }],
  ]);
  s.tables.githubBindingOperations = new Map([
    [
      'op',
      {
        _id: 'op',
        _creationTime: 1,
        state: 'st',
        status: 'processing',
        actor: 'owner',
        githubAccounts: ['7'],
      },
    ],
  ]);
  const writes = [];
  s.ctx.runQuery = s.ctx.runMutation = (ref, args) => {
    const name = getFunctionName(ref).split(':')[1];
    if (name !== 'read') writes.push(name);
    return tokens[name]._handler(s.ctx, args);
  };
  const exchanges = [];
  let answer = n => ({ access_token: `ghu_renewed${n}`, refresh_token: `ghr_next${n}`, expires_in: 28800 });
  const request = async (url, init) => {
    assert.equal(url, 'https://github.com/login/oauth/access_token');
    const body = JSON.parse(init.body);
    exchanges.push(body.refresh_token);
    const value = answer(exchanges.length);
    return value ? Response.json(value) : Response.json({ error: 'bad_refresh_token' });
  };
  const connect = (grant = {}) =>
    actions.storeConnection._handler(s.ctx, { state: 'st', owner: 'owner', token: 'ghu_first', ...grant });
  const expire = () => (s.tables.users.get('u').githubTokenRenewal.expiresAt = NOW - 1);
  return { s, writes, exchanges, request, connect, expire, refuse: () => (answer = () => null) };
}

test('a non-expiring connection makes no GitHub call and stores no renewal', async t => {
  const f = fixture(t);
  await f.connect();
  assert.equal(f.s.tables.users.get('u').githubTokenRenewal, undefined);
  assert.equal(await actions.githubUserToken(f.s.ctx, 'owner', f.request), 'ghu_first');
  assert.deepEqual(f.exchanges, []);
});

test('an expired token is renewed once on use, sealed, and the next read uses the renewed one', async t => {
  const f = fixture(t);
  await f.connect({ refreshToken: 'ghr_first', expiresIn: 28800 });
  const stored = f.s.tables.users.get('u');
  assert.equal(stored.githubTokenRenewal.expiresAt, NOW + 28800 * 1000);
  assert.ok(!JSON.stringify(stored).includes('ghr_first'), 'the refresh token is sealed');
  // Before expiry: no exchange.
  assert.equal(await actions.githubUserToken(f.s.ctx, 'owner', f.request), 'ghu_first');
  assert.deepEqual(f.exchanges, []);
  f.expire();
  assert.equal(await actions.githubUserToken(f.s.ctx, 'owner', f.request), 'ghu_renewed1');
  assert.deepEqual(f.exchanges, ['ghr_first']);
  assert.equal(await actions.githubUserToken(f.s.ctx, 'owner', f.request), 'ghu_renewed1');
  assert.deepEqual(f.exchanges, ['ghr_first'], 'the renewed token is used until it expires');
  f.expire();
  assert.equal(await actions.githubUserToken(f.s.ctx, 'owner', f.request), 'ghu_renewed2');
  assert.deepEqual(f.exchanges, ['ghr_first', 'ghr_next1'], 'each renewal uses the latest refresh token');
});

test('a refused renewal keeps the stored token; a stale renewal never overwrites a newer connection', async t => {
  const f = fixture(t);
  await f.connect({ refreshToken: 'ghr_first', expiresIn: 28800 });
  f.expire();
  f.refuse();
  // GitHub's own token check then names the expiry and asks the person to reconnect.
  assert.equal(await actions.githubUserToken(f.s.ctx, 'owner', f.request), 'ghu_first');
  const previous = f.s.tables.users.get('u').githubToken;
  await f.connect({ token: 'ghu_reconnected' });
  const newer = f.s.tables.users.get('u').githubToken;
  assert.equal(
    await tokens.renew._handler(f.s.ctx, { owner: 'owner', previous, token: previous }),
    false,
    'a renewal of the old token loses to the newer connection',
  );
  assert.deepEqual(f.s.tables.users.get('u').githubToken, newer);
});
