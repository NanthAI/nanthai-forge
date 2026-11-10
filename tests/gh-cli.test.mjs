// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

const cli = new URL('../dist/cli.js', import.meta.url).pathname;
function run(args, cwd, extra = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extra };
    delete env.FORGE_AUTH_TOKEN;
    delete env.FORGE_DEPLOYMENT_URL;
    delete env.FORGE_HTTP_URL;
    if (extra.FORGE_AUTH_TOKEN) env.FORGE_AUTH_TOKEN = extra.FORGE_AUTH_TOKEN;
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', bytes => (stdout += bytes));
    child.stderr.on('data', bytes => (stderr += bytes));
    child.on('error', reject);
    child.on('close', code =>
      resolve({ code, stdout, stderr, json: stdout.trim() ? JSON.parse(stdout) : null }),
    );
  });
}
test('auth status signed out/in, hostname, hosts JSON and environment source never expose tokens', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-gh-auth-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* consume synthetic request */
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        status: 'success',
        value: { handle: 'synthetic-owner', credentialId: 'device', token: 'must-never-leave-response' },
      }),
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const deployment = `http://127.0.0.1:${server.address().port}`,
    env = { XDG_CONFIG_HOME: directory };
  const out = await run(['auth', 'status', '--json'], directory, env);
  assert.equal(out.code, 1);
  assert.equal(out.json.authenticated, false);
  mkdirSync(join(directory, 'forge'));
  writeFileSync(
    join(directory, 'forge', 'auth.json'),
    JSON.stringify({
      defaultDeployment: deployment,
      deployments: {
        [deployment]: {
          token: 'synthetic-saved-token',
          credentialId: 'device',
          name: 'Synthetic',
          scope: 'cli',
          expiresAt: Date.now() + 60000,
        },
      },
    }),
    { mode: 0o600 },
  );
  const status = await run(
    [
      'auth',
      'status',
      '--hostname',
      new URL(deployment).host,
      '--json',
      'hosts,account,tokenSource,identity',
    ],
    directory,
    env,
  );
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.json.account, 'synthetic-owner');
  assert.equal(status.json.hosts[new URL(deployment).host][0].state, 'success');
  assert.equal(status.json.tokenSource, 'saved');
  const override = await run(['auth', 'status', '--json', 'tokenSource,authenticated'], directory, {
    ...env,
    FORGE_AUTH_TOKEN: 'synthetic-env-token',
  });
  assert.equal(override.code, 0);
  assert.equal(override.json.tokenSource, 'FORGE_AUTH_TOKEN');
  for (const output of [status, override])
    assert.doesNotMatch(
      output.stdout + output.stderr,
      /synthetic-saved-token|synthetic-env-token|must-never-leave-response/,
    );
});

test('version probe is stable, one line, and rejects extra flags', () => {
  const probe = () => spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  const first = probe();
  assert.equal(first.status, 0);
  assert.match(first.stdout, /^nforge version \d+\.\d+\.\d+\n$/);
  assert.equal(probe().stdout, first.stdout);
  const invalid = spawnSync(process.execPath, [cli, '--version', '--bogus'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(JSON.parse(invalid.stderr).error.message, /--bogus/);
});

test('SM-C M23: an expired saved login answers authenticated:false with its own state; an empty FORGE_AUTH_TOKEN is unset', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-gh-auth-state-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const deployment = 'http://127.0.0.1:9',
    env = { XDG_CONFIG_HOME: directory };
  mkdirSync(join(directory, 'forge'));
  writeFileSync(
    join(directory, 'forge', 'auth.json'),
    JSON.stringify({
      defaultDeployment: deployment,
      deployments: {
        [deployment]: {
          token: 'synthetic-expired-token',
          credentialId: 'device',
          name: 'Synthetic',
          scope: 'cli',
          expiresAt: Date.now() - 60000,
        },
      },
    }),
    { mode: 0o600 },
  );
  // Expired: the same JSON shape and exit as logged out, with the state and the one next step.
  const expired = await run(['auth', 'status', '--json'], directory, env);
  assert.equal(expired.code, 1, expired.stderr);
  assert.equal(expired.json.authenticated, false);
  assert.equal(expired.json.state, 'expired');
  assert.match(expired.json.nextStep, /nforge login/);
  assert.ok(!JSON.stringify(expired.json).includes('synthetic-expired-token'));
  // An empty environment token counts as unset (state names read the saved login, not the env).
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  });
  const { authState, resolveAuthToken } = await import('../dist/auth-store.js');
  assert.equal(authState(deployment, '').kind, 'expired');
  assert.throws(() => resolveAuthToken(deployment, ''), { code: 'AUTH_EXPIRED' });
  assert.equal(authState(deployment, 'synthetic-env-token').kind, 'envToken');
  assert.equal(resolveAuthToken(deployment, 'synthetic-env-token'), 'synthetic-env-token');
  writeFileSync(
    join(directory, 'forge', 'auth.json'),
    JSON.stringify({
      defaultDeployment: deployment,
      deployments: {
        [deployment]: {
          token: 'synthetic-saved-token',
          credentialId: 'device',
          name: 'Synthetic',
          scope: 'cli',
          expiresAt: Date.now() + 60000,
        },
      },
    }),
    { mode: 0o600 },
  );
  assert.equal(
    resolveAuthToken(deployment, ''),
    'synthetic-saved-token',
    'an empty env token never hides the login',
  );
  assert.equal(authState(deployment, '').kind, 'saved');
  assert.equal(authState('http://127.0.0.1:10', '').kind, 'none');
});
