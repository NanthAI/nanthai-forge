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
  const config = { clerkSecret: 'test-clerk', appClientId: 'test-app', appClientSecret: 'test-secret' };
  let revoked = false,
    provider = 'ghu_test';
  const request = async (url, options) => {
    if (url.startsWith('https://api.clerk.com/')) return new Response(JSON.stringify([{ token: provider }]));
    if (url.includes('/applications/')) return new Response('{}', { status: revoked ? 404 : 200 });
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
