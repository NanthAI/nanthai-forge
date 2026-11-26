// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { authStatus } from '../dist/auth-status.js';
import { authCli } from '../dist/auth-cli.js';
import { readAuth, writeAuth } from '../dist/auth-store.js';
import { githubImportCli } from '../dist/github-import-cli.js';
import { hostedCloneCli } from '../dist/hosted-clone-cli.js';
import { hostCli } from '../dist/host-command.js';
import { defaultForgeSite } from '../dist/forge-site.js';

const site = 'https://forge.example';
const backend = 'https://service.convex.cloud';
const other = 'https://other.convex.cloud';

function fixture(t, response = () => Response.json({ deployment: backend })) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-cli-site-'));
  const cwd = process.cwd();
  process.chdir(directory);
  const keys = [
    'XDG_CONFIG_HOME',
    'FORGE_AUTH_TOKEN',
    'FORGE_DEPLOYMENT_URL',
    'FORGE_HTTP_URL',
    'FORGE_SITE_URL',
  ];
  const previous = keys.map(key => [key, process.env[key]]);
  process.env.XDG_CONFIG_HOME = directory;
  delete process.env.FORGE_AUTH_TOKEN;
  delete process.env.FORGE_DEPLOYMENT_URL;
  delete process.env.FORGE_HTTP_URL;
  delete process.env.FORGE_SITE_URL;
  const fetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push([String(url), options]);
    return response(url, options);
  };
  const exitCode = process.exitCode;
  t.after(() => {
    for (const [key, value] of previous)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    process.exitCode = exitCode;
    globalThis.fetch = fetch;
    process.chdir(cwd);
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, requests };
}

test('auth status reads the selected app asset without credentials and presents its app URL', async t => {
  const { requests } = fixture(t);
  const result = await authStatus([site]);
  assert.equal(result.site, site);
  assert.equal(result.host, new URL(site).host);
  assert.equal(result.state, 'none');
  assert.equal(result.nextStep, "Run nforge login 'https://forge.example'.");
  assert.deepEqual(
    requests.map(([url]) => url),
    [`${site}/_forge/cli.json`],
  );
  const headers = new Headers(requests[0][1].headers);
  assert.equal(headers.has('authorization'), false);
  assert.equal(requests[0][1].redirect, 'error');
});

test('a fresh CLI tells a signed-out user to run bare login, even offline', async t => {
  const { requests } = fixture(t, () => assert.fail('a new configuration needs no status request'));
  const result = await authStatus([]);
  assert.equal(result.site, defaultForgeSite);
  assert.equal(result.nextStep, 'Run nforge login.');
  assert.deepEqual(requests, []);
});

test('an invalid discovery reply never retargets a project clone to the saved default', async t => {
  const { directory, requests } = fixture(t, () => Response.json({ deployment: 'http://other.example' }));
  writeAuth({ defaultDeployment: other, deployments: {} });
  await assert.rejects(hostedCloneCli([`${site}/ada/sample`, join(directory, 'clone')]), {
    code: 'AUTH_UNAVAILABLE',
  });
  assert.deepEqual(
    requests.map(([url]) => url),
    [`${site}/_forge/cli.json`],
  );
});

for (const target of [undefined, site])
  test(`fresh login discovers the ${target ? 'explicit' : 'built-in'} site and status reuses its sign-in`, async t => {
    const app = target ?? defaultForgeSite;
    const start = Promise.withResolvers();
    const now = Date.parse('2026-11-26T12:00:00Z');
    const { requests } = fixture(t, url => {
      switch (new URL(url).pathname) {
        case '/_forge/cli.json':
          assert.equal(new URL(url).origin, app);
          return Response.json({ deployment: backend });
        case '/auth/device/start-v2':
          assert.equal(new URL(url).host, 'service.convex.site');
          start.resolve();
          return Response.json({
            device_code: 'a'.repeat(64),
            verification_uri_complete: `${app}/device`,
            user_code: 'TEST-CODE',
            expires_in: 600,
          });
        case '/auth/device/poll':
          return Response.json({
            status: 'approved',
            token: 'synthetic-login-token',
            credentialId: 'device-credential',
            expiresAt: now + 3_600_000,
          });
        case '/api/query':
          return Response.json({ status: 'success', logLines: [], value: { handle: 'ada' } });
        default:
          assert.fail('unexpected sign-in request');
      }
    });
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
    if (target) process.env.FORGE_DEPLOYMENT_URL = other;
    const pending = authCli('login', [...(target ? ['--url', target] : []), '--no-browser']);
    await start.promise;
    await new Promise(setImmediate);
    t.mock.timers.tick(5000);
    const login = await pending;
    assert.equal(login.site, app);
    assert.equal(login.loggedIn, true);
    assert.deepEqual(Object.keys(readAuth().deployments), [backend]);
    assert.equal(readAuth().defaultDeployment, backend);
    delete process.env.FORGE_DEPLOYMENT_URL;
    assert.equal((await authStatus(['--json', 'site,authenticated'])).authenticated, true);
    assert.equal((await authStatus(['--hostname', new URL(app).host])).site, app);
    assert.deepEqual(
      requests.filter(([url]) => url.endsWith('/_forge/cli.json')).map(([url]) => url),
      [`${app}/_forge/cli.json`],
    );
  });

test('login rejects multiple selectors and missing --url values before discovery', async t => {
  const { requests } = fixture(t);
  for (const flags of [
    ['--url'],
    ['--url', '--no-browser'],
    ['--url', site, other],
    ['--url', site, '--deployment', other],
    ['--url', site, '--url', other],
  ])
    await assert.rejects(authCli('login', flags), { code: 'BAD_ARGUMENT' });
  assert.deepEqual(requests, []);
});

test('status and previews can use a saved app while new hosting resolves the current site', async t => {
  const { directory, requests } = fixture(t, () => Response.json({ deployment: other }));
  writeAuth({ defaultDeployment: other, deployments: {}, sites: { [site]: backend } });
  assert.equal((await authStatus([site])).site, site);
  const preview = await githubImportCli(['ada/sample', '--site', site, '--preview'], {
    client(deployment) {
      assert.equal(deployment, backend);
      return {
        action: async () => ({
          repository: 'ada/sample',
          origin: 'public',
          choices: ['public', 'private'],
          ref: 'main',
          commit: 'a'.repeat(40),
          files: 0,
          bytes: 0,
          submodules: 0,
          attributes: 0,
          lfs: 'none',
          warnings: [],
          githubRequests: { user: 0, app: 0, server: 0, anonymous: 0 },
        }),
      };
    },
  });
  assert.equal(preview.repository, 'ada/sample');
  assert.equal(preview.site, site);
  assert.match(preview.next, /--deployment 'https:\/\/service\.convex\.cloud'/);
  const backendPreview = await githubImportCli(['ada/sample', '--deployment', backend, '--preview'], {
    client: deployment => {
      assert.equal(deployment, backend);
      return {
        action: async () =>
          Object.fromEntries(
            Object.entries(preview).filter(
              ([key]) => !['next', 'summary', 'site', 'deployment'].includes(key),
            ),
          ),
      };
    },
  });
  assert.match(backendPreview.next, /--deployment 'https:\/\/service\.convex\.cloud'/);
  const apply = async report => {
    const args = report.next
      .split(' ')
      .slice(2)
      .map(word => word.replace(/^'|'$/g, ''));
    let started = false;
    const stop = new Error('synthetic start boundary');
    await assert.rejects(
      githubImportCli([...args, '--no-wait'], {
        directory,
        client(deployment) {
          assert.equal(deployment, backend, 'the preview pins the import backend');
          return {
            async action(name, input) {
              assert.equal(name, 'projectGithubImport:start');
              assert.equal(input.url, 'ada/sample');
              started = true;
              throw stop;
            },
          };
        },
      }),
    );
    assert(started);
  };
  await apply(preview);
  await apply(backendPreview);
  await assert.rejects(hostCli([directory, '--site', site]), { code: 'AUTH_REQUIRED' });
  assert.deepEqual(
    requests.map(([url]) => url),
    [`${site}/_forge/cli.json`],
  );
});

test('an unsigned clone selects the saved instance before the distribution site', async t => {
  const { directory, requests } = fixture(t);
  writeAuth({
    defaultDeployment: other,
    deployments: {},
    sites: { [site]: other, [defaultForgeSite]: backend },
  });
  await assert.rejects(
    hostedCloneCli(['ada/sample', join(directory, 'clone')]),
    error => error.code === 'SIGN_IN_REQUIRED' && error.message.includes(site),
  );
  assert.equal((await authStatus([])).site, site);
  assert.equal((await authStatus([defaultForgeSite])).site, defaultForgeSite);
  assert.deepEqual(requests, []);
});

test('unqualified host, import, clone and status select the last of two signed-in instances', async t => {
  const credential = account => ({
    token: 'synthetic-' + account,
    credentialId: 'credential-' + account,
    expiresAt: Date.parse('2099-01-01T00:00:00Z'),
    name: 'test-terminal',
    scope: 'cli',
  });
  const { directory, requests } = fixture(t, (url, options) => {
    const address = new URL(url);
    assert.equal(address.origin, other);
    const call = JSON.parse(options.body);
    if (call.path === 'deviceCredentials:status')
      return Response.json({ status: 'success', logLines: [], value: { handle: 'selected' } });
    if (call.path === 'urlProjects:resolve')
      return Response.json({ status: 'success', logLines: [], value: null });
    return Response.json({ status: 'error', errorMessage: 'synthetic host stop', logLines: [] });
  });
  writeAuth({
    defaultDeployment: other,
    deployments: { [backend]: credential('first'), [other]: credential('selected') },
    sites: { [defaultForgeSite]: backend, [site]: other },
  });
  const status = await authStatus([]);
  assert.equal(status.site, site);
  assert.equal(status.authenticated, true);
  await assert.rejects(hostedCloneCli(['ada/sample', join(directory, 'clone')]), {
    code: 'PROJECT_UNAVAILABLE',
  });
  await assert.rejects(hostCli([directory]));
  await assert.rejects(
    githubImportCli(['ada/sample', '--preview'], {
      client(deployment) {
        assert.equal(deployment, other);
        return {
          action: async () => {
            throw new Error('synthetic preview stop');
          },
        };
      },
    }),
  );
  assert(
    requests.some(([url]) => url.endsWith('/api/mutation')),
    'host reaches its selected backend',
  );
  assert(!requests.some(([url]) => url.endsWith('/_forge/cli.json')));
});

test('regular command help advertises URL-free setup', () => {
  const result = spawnSync(process.execPath, ['dist/cli.js', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nforge login \[--url URL\] \[--name NAME\]/);
  assert.match(result.stdout, /nforge clone <OWNER\/PROJECT\|PROJECT_ID> DIR/);
  assert.doesNotMatch(
    result.stdout,
    /nforge (?:login|host|clone|import) [^\n]*(?:--deployment|--site|APP_URL)/,
  );
});
