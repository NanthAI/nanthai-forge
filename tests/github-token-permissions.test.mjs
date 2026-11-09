// SPDX-License-Identifier: Apache-2.0
// Every installation-token request names an explicit permissions object, so a
// token never silently carries all of an installation's permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
const tokens = await import(moduleUrl('../convex/githubAppToken.ts'));
function app(t) {
  const names = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'FORGE_GITHUB_REPO_BINDINGS'],
    prior = names.map(n => process.env[n]);
  process.env.GITHUB_APP_ID = '123';
  process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  });
  process.env.FORGE_GITHUB_REPO_BINDINGS = 'p1=synthetic/repo';
  t.after(() =>
    names.forEach((n, i) => {
      if (prior[i] === undefined) delete process.env[n];
      else process.env[n] = prior[i];
    }),
  );
  const requests = [],
    request = async (url, init) => {
      if (url.endsWith('/installation')) return Response.json({ id: 9 });
      requests.push(init.body ? JSON.parse(init.body) : null);
      return Response.json({ token: 'synthetic-token' });
    };
  return { requests, request };
}
test('mirror, check and import token requests each carry explicit minimal permissions', async t => {
  const { requests, request } = app(t);
  await tokens.installationToken({}, 'p1', 'synthetic/repo', tokens.mirrorPermissions, request);
  await tokens.installationToken({}, 'p1', 'synthetic/repo', tokens.actionsPermissions, request);
  await tokens.importReadToken('synthetic/repo', 42, request);
  await tokens.installationToken({}, 'p1', 'synthetic/repo', tokens.inboundReadPermissions, request);
  assert.deepEqual(
    requests.map(r => r.permissions),
    [
      { contents: 'write' },
      { actions: 'write', contents: 'read' },
      { contents: 'read', metadata: 'read' },
      { contents: 'read' },
    ],
  );
  assert(requests.every(r => !('repository_ids' in r) || r.repository_ids.length === 1));
});
test('a token request without permissions is refused before any mint', async t => {
  const { requests, request } = app(t);
  for (const permissions of [undefined, null, {}])
    await assert.rejects(
      tokens.installationToken({}, 'p1', 'synthetic/repo', permissions, request),
      e => e.code === 'GITHUB_APP_CONFIG',
    );
  assert.equal(requests.length, 0);
});
test('only the shared token module requests installation tokens', () => {
  const owners = [];
  for (const dir of ['convex', 'src'])
    for (const file of readdirSync(new URL(`../${dir}/`, import.meta.url)))
      if (
        file.endsWith('.ts') &&
        readFileSync(new URL(`../${dir}/${file}`, import.meta.url), 'utf8').includes('/access_tokens`')
      )
        owners.push(`${dir}/${file}`);
  assert.deepEqual(owners, ['convex/githubAppToken.ts']);
});

test('mirror permissions follow the plan: workflows write only for workflow paths, both when unplanned', () => {
  const plan = (changes, pending = []) => ({
    changes: changes.map(path => ({ path })),
    pending: pending.map(path => ({ path })),
  });
  const both = { contents: 'write', workflows: 'write' };
  assert.deepEqual(tokens.mirrorPermissionsFor(undefined), both);
  assert.deepEqual(tokens.mirrorPermissionsFor(plan([], ['.github/workflows/sign.yml'])), both);
  assert.deepEqual(tokens.mirrorPermissionsFor(plan(['.github/workflows/old.yml'])), both);
  assert.deepEqual(
    tokens.mirrorPermissionsFor(plan(['docs/a.md'], ['.github/CODEOWNERS', 'github/workflows/x'])),
    {
      contents: 'write',
    },
  );
  assert.deepEqual(tokens.mirrorPermissionsFor(plan([])), { contents: 'write' });
});
