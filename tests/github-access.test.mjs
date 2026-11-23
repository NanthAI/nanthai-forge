// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeGithub, assertImporter } from '../dist/github-access.js';

test('private reads require the importer and a current human token issued by the Forge GitHub App', async () => {
  const repository = {
    full_name: 'example/project',
    private: true,
    default_branch: 'main',
    html_url: 'https://github.com/example/project',
    license: null,
  };
  let revoked = false,
    provider = 'ghu_test';
  const config = { userToken: async () => provider, appClientId: 'test-app', appClientSecret: 'test-secret' };
  const request = async (url, options) => {
    if (url.includes('/applications/')) return new Response('{}', { status: revoked ? 404 : 200 });
    if (url.endsWith('/user')) return new Response('{}', { status: revoked ? 401 : 200 });
    if (!options.headers.Authorization) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(repository));
  };
  await assert.rejects(authorizeGithub('example/project', undefined, config, request), {
    code: 'GITHUB_UNAVAILABLE',
  });
  assert.throws(() => assertImporter('private', 'owner', 'someone-else'), { code: 'GITHUB_UNAVAILABLE' });
  assertImporter('private', 'owner', 'owner');
  assert.equal((await authorizeGithub('example/project', 'owner', config, request)).repository.private, true);
  revoked = true;
  await assert.rejects(authorizeGithub('example/project', 'owner', config, request), {
    code: 'GITHUB_UNAVAILABLE',
  });
  revoked = false;
  provider = 'gho_other_oauth_app';
  await assert.rejects(authorizeGithub('example/project', 'owner', config, request), {
    code: 'GITHUB_UNAVAILABLE',
  });
});

test('anonymous access uses current public visibility and never inherits private access from a server credential', async () => {
  const repository = {
    full_name: 'example/project',
    private: false,
    default_branch: 'main',
    html_url: 'https://github.com/example/project',
    license: null,
  };
  const request = async () => new Response(JSON.stringify(repository));
  assert.equal((await authorizeGithub('example/project', undefined, {}, request)).repository.private, false);
  repository.private = true;
  await assert.rejects(
    authorizeGithub('example/project', undefined, { publicToken: 'overprivileged-server-token' }, request),
    { code: 'GITHUB_UNAVAILABLE' },
  );
});

test('a repository outside the App installation names the exact install step', async () => {
  const config = {
    userToken: async () => 'ghu_test',
    appClientId: 'test-app',
    appClientSecret: 'test-secret',
  };
  let installations = [],
    installationStatus = 200;
  const urls = [];
  const request = async (url, options) => {
    urls.push(url);
    if (url.includes('/applications/')) return new Response('{}');
    if (url.includes('/user/installations'))
      return new Response(JSON.stringify({ installations }), { status: installationStatus });
    return new Response('{}', { status: 404 });
  };
  const refusal = async (repository = 'acme/secret', extra = config) => {
    try {
      await authorizeGithub(repository, 'owner', extra, request);
    } catch (error) {
      return error;
    }
    assert.fail('expected a refusal');
  };
  installations = [
    {
      id: 7,
      app_slug: 'forge-app',
      repository_selection: 'selected',
      html_url: 'https://github.com/organizations/acme/settings/installations/7',
      account: { login: 'Acme', type: 'Organization' },
    },
  ];
  let error = await refusal();
  assert.equal(error.code, 'GITHUB_UNAVAILABLE');
  assert.match(error.message, /acme\/secret is not in the Forge GitHub App installation for acme/);
  assert.match(error.message, /https:\/\/github\.com\/organizations\/acme\/settings\/installations\/7/);
  assert.match(error.message, /selected repositories/);
  installations = [
    { id: 8, repository_selection: 'selected', account: { login: 'someone', type: 'User' } },
    {
      id: 9,
      app_slug: 'forge-app',
      repository_selection: 'selected',
      account: { login: 'other', type: 'User' },
    },
  ];
  error = await refusal('someone/private');
  assert.match(
    error.message,
    /https:\/\/github\.com\/settings\/installations\/8/,
    'user-account fallback link',
  );
  installations = [
    {
      id: 9,
      app_slug: 'forge-app',
      repository_selection: 'selected',
      account: { login: 'other', type: 'User' },
    },
  ];
  error = await refusal();
  assert.equal(error.code, 'GITHUB_UNAVAILABLE');
  assert.match(error.message, /not installed for acme/);
  assert.match(error.message, /https:\/\/github\.com\/apps\/forge-app\/installations\/new/);
  installations = [];
  error = await refusal('acme/secret', { ...config, appSlug: 'configured-app' });
  assert.match(error.message, /apps\/configured-app\/installations\/new/);
  error = await refusal();
  assert.match(error.message, /not installed for acme/);
  assert.doesNotMatch(error.message, /https:/);
  installationStatus = 500;
  error = await refusal();
  assert.equal(error.code, 'GITHUB_UNAVAILABLE');
  assert.match(error.message, /GitHub could not provide this repository/);
  assert.equal(urls.filter(url => url.includes('/user/installations')).length > 0, true);
});

test('public imports recover anonymously from a rejected deployment credential without GitHub sign-in', async () => {
  const repo = {
    full_name: 'example/public',
    private: false,
    default_branch: 'main',
    html_url: 'https://github.com/example/public',
    license: null,
  };
  for (const status of [401, 403, 404]) {
    const requests = [];
    const result = await authorizeGithub(
      'example/public',
      'owner',
      { publicToken: 'rejected-server-token' },
      async (url, options) => {
        requests.push(url);
        assert.equal(url, 'https://api.github.com/repos/example/public');
        return options.headers.Authorization ? new Response('{}', { status }) : Response.json(repo);
      },
    );
    assert.equal(result.repository.private, false);
    assert.equal(result.token, undefined, 'subsequent source reads must not reuse the rejected credential');
    assert.equal(requests.length, 2, 'one failed credential read and one anonymous visibility proof');
  }
});

test('public recovery never grants private access or bypasses GitHub rate limits', async () => {
  await assert.rejects(
    authorizeGithub('example/private', undefined, { publicToken: 'server-token' }, async (_, options) =>
      options.headers.Authorization
        ? new Response('{}', { status: 403 })
        : new Response('{}', { status: 404 }),
    ),
    { code: 'GITHUB_UNAVAILABLE' },
  );
  for (const remaining of ['0', '10']) {
    let calls = 0;
    await assert.rejects(
      authorizeGithub('example/public', 'owner', { publicToken: 'server-token' }, async () => {
        calls++;
        return new Response('{}', {
          status: 403,
          headers: remaining === '0' ? { 'x-ratelimit-remaining': remaining } : { 'retry-after': '60' },
        });
      }),
      { code: 'GITHUB_RATE_LIMIT' },
    );
    assert.equal(calls, 1, 'a rate-limit refusal retains its provider retry');
  }
});

test('a saved connection from a different App is named before any repository read with it', async () => {
  const config = {
    userToken: async () => 'ghu_synthetic',
    appClientId: 'synthetic-app',
    appClientSecret: 'synthetic-app-secret',
  };
  let checkedStatus = 404,
    userStatus = 200;
  const authorized = [];
  const request = async (url, options) => {
    if (url.includes('/applications/')) return new Response('{}', { status: checkedStatus });
    if (url === 'https://api.github.com/user') return new Response('{}', { status: userStatus });
    // Anonymous lookups cannot see the private repository; a token read happens only after the App check.
    if (!options.headers.Authorization) return new Response('{}', { status: 404 });
    authorized.push(url);
    return Response.json({
      full_name: 'example/private',
      private: true,
      default_branch: 'main',
      html_url: 'https://github.com/example/private',
      license: null,
    });
  };
  const access = () => authorizeGithub('example/private', 'synthetic-user', config, request);
  await assert.rejects(access(), error => {
    assert.equal(error.code, 'GITHUB_SETUP_REQUIRED');
    assert.match(error.message, /different GitHub App/);
    assert.doesNotMatch(error.message, /expired|synthetic/);
    return true;
  });
  userStatus = 401;
  await assert.rejects(access(), { code: 'GITHUB_UNAVAILABLE', message: /expired or been revoked/ });
  checkedStatus = 401;
  await assert.rejects(access(), { code: 'GITHUB_SETUP_REQUIRED', message: /App client credentials/ });
  checkedStatus = 503;
  await assert.rejects(access(), { code: 'GITHUB_UNAVAILABLE', message: /could not validate/ });
  checkedStatus = 404;
  userStatus = 503;
  await assert.rejects(access(), { code: 'GITHUB_UNAVAILABLE', message: /could not validate/ });
  assert.deepEqual(authorized, []);
  checkedStatus = 200;
  assert.equal((await access()).repository.private, true);
  assert.equal(authorized.length, 1);
});

test('no saved GitHub connection asks the person to connect', async () => {
  const config = { userToken: async () => undefined, appClientId: 'app', appClientSecret: 'secret' };
  const request = async () => new Response('{}', { status: 404 });
  await assert.rejects(authorizeGithub('example/private', 'person', config, request), {
    code: 'GITHUB_UNAVAILABLE',
    message: /Connect your GitHub account/,
  });
});
