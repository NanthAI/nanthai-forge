// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
const { installationToken } = await import(moduleUrl('../convex/githubAppToken.ts'));
const { githubRequest } = await import('../dist/hosted-github-api.js');
test('App JWT uses RS256 and short expiry, then mints a token for the selected repository', async t => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const oldId = process.env.GITHUB_APP_ID,
    oldKey = process.env.GITHUB_APP_PRIVATE_KEY;
  process.env.GITHUB_APP_ID = '123';
  process.env.GITHUB_APP_PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  t.after(() => {
    if (oldId === undefined) delete process.env.GITHUB_APP_ID;
    else process.env.GITHUB_APP_ID = oldId;
    if (oldKey === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY;
    else process.env.GITHUB_APP_PRIVATE_KEY = oldKey;
  });
  const oldBindings = process.env.FORGE_GITHUB_REPO_BINDINGS;
  process.env.FORGE_GITHUB_REPO_BINDINGS = 'p1=synthetic/mirror';
  t.after(() => {
    if (oldBindings === undefined) delete process.env.FORGE_GITHUB_REPO_BINDINGS;
    else process.env.FORGE_GITHUB_REPO_BINDINGS = oldBindings;
  });
  const calls = [];
  const token = await installationToken(
    {},
    'p1',
    'synthetic/mirror',
    undefined,
    async (url, init) => {
      calls.push({ url, init });
      const jwt = init.headers.Authorization.slice(7),
        [header, body, signature] = jwt.split('.');
      assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
      assert(
        verify(
          'RSA-SHA256',
          Buffer.from(`${header}.${body}`),
          keys.publicKey,
          Buffer.from(signature, 'base64url'),
        ),
      );
      assert.deepEqual(JSON.parse(Buffer.from(body, 'base64url')), { iss: '123', iat: 940, exp: 1540 });
      return new Response(
        JSON.stringify(url.endsWith('/installation') ? { id: 42 } : { token: 'synthetic-only-token' }),
      );
    },
    1000000,
  );
  assert.equal(token, 'synthetic-only-token');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api.github.com/app/installations/42/access_tokens');
  assert.deepEqual(JSON.parse(calls[1].init.body), { repositories: ['mirror'] });
  await assert.rejects(installationToken({}, 'p1', '../mirror'), e => e.code === 'BAD_REPOSITORY');
});
test('API failures never expose response bodies or tokens and redirects are disabled', async () => {
  await assert.rejects(
    githubRequest('synthetic-token', async (_url, init) => {
      assert.equal(init.redirect, 'error');
      return new Response('synthetic-token secret response', { status: 401 });
    })('/repos/synthetic/mirror'),
    e => e.code === 'GITHUB_SYNC_API' && !e.message.includes('synthetic-token'),
  );
});

test('the App acts only on repositories bound to the requesting project', async () => {
  const { assertRepositoryBinding } = await import(moduleUrl('../convex/githubAppToken.ts'));
  const bindings = 'p1=NanthAI/forge, p2=other/repo';
  assertRepositoryBinding('p1', 'nanthai/Forge', bindings);
  for (const [project, repo, value] of [
    ['p1', 'other/repo', bindings],
    ['p3', 'NanthAI/forge', bindings],
    ['p1', 'NanthAI/forge', undefined],
    ['p1', 'NanthAI/forge', ''],
  ])
    assert.throws(
      () => assertRepositoryBinding(project, repo, value),
      e => e.code === 'GITHUB_REPOSITORY_UNBOUND',
    );
});
