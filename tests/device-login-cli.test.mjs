// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const cli = new URL('../dist/cli.js', import.meta.url).pathname;
test('real CLI login, saved authentication, env override, denial, logout and status never print the credential', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-device-cli-'));
  let decision = 'approved',
    revoked = false,
    seenAuth = '';
  const token = 'synthetic-forge-issued-token',
    envToken = 'synthetic-ci-override';
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/auth/device/start') {
      assert.match(input.clientNonce, /^[0-9a-f]{64}$/);
      assert.equal(input.scope, 'cli');
      response.end(
        JSON.stringify({
          device_code: 'a'.repeat(64),
          user_code: 'ABCDE-FGHJK',
          verification_uri: 'https://forge.example/device',
          verification_uri_complete: 'https://forge.example/device?code=ABCDE-FGHJK',
          expires_in: 600,
          interval: 5,
        }),
      );
    } else if (request.url === '/auth/device/poll') {
      assert.equal(input.deviceCode, 'a'.repeat(64));
      response.end(
        JSON.stringify(
          decision === 'approved'
            ? { status: 'approved', token, credentialId: 'synthetic-device', expiresAt: Date.now() + 60000 }
            : { status: 'access_denied' },
        ),
      );
    } else {
      seenAuth = request.headers.authorization;
      if (input.path === 'deviceCredentials:revoke') revoked = true;
      response.end(
        JSON.stringify({
          status: 'success',
          value:
            input.path === 'deviceCredentials:status'
              ? { subject: 'synthetic-owner', credentialId: 'synthetic-device' }
              : input.path === 'projectCoordination:sessions'
                ? { page: [], isDone: true, continueCursor: '' }
                : null,
        }),
      );
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const deployment = `http://127.0.0.1:${server.address().port}`;
  const run = (args, override) =>
    new Promise((resolve, reject) => {
      const env = { ...process.env, XDG_CONFIG_HOME: directory };
      delete env.FORGE_AUTH_TOKEN;
      delete env.FORGE_HTTP_URL;
      delete env.FORGE_DEPLOYMENT_URL;
      if (override) env.FORGE_AUTH_TOKEN = override;
      const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', chunk => (stdout += chunk));
      child.stderr.on('data', chunk => (stderr += chunk));
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout, stderr }));
    });
  const login = await run(['login', deployment, '--name', 'Synthetic CLI', '--no-browser']);
  assert.equal(login.code, 0);
  assert.match(login.stderr, /ABCDE-FGHJK/);
  assert.equal(login.stdout.includes(token) || login.stderr.includes(token), false);
  const file = join(directory, 'forge', 'auth.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).deployments[deployment].token, token);
  const status = await run(['auth', 'status']);
  assert.equal(status.code, 0);
  assert.equal(JSON.parse(status.stdout).authenticated, true);
  assert.equal(seenAuth, `Bearer ${token}`);
  const coordination = await run(['coordination', deployment, 'synthetic-project', '{"action":"sessions"}']);
  assert.equal(coordination.code, 0);
  assert.equal(seenAuth, `Bearer ${token}`);
  const ci = await run(['auth', 'status'], envToken);
  assert.equal(ci.code, 0);
  assert.equal(seenAuth, `Bearer ${envToken}`);
  assert.equal(ci.stdout.includes(envToken), false);
  decision = 'denied';
  const denied = await run(['login', deployment, '--no-browser']);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /denied/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).deployments[deployment].token, token);
  const cached = JSON.parse(readFileSync(file, 'utf8'));
  cached.deployments[deployment].expiresAt = 0;
  writeFileSync(file, JSON.stringify(cached), { mode: 0o600 });
  const logout = await run(['logout', deployment], envToken);
  assert.equal(logout.code, 0);
  assert.equal(revoked, true);
  assert.equal(seenAuth, `Bearer ${token}`);
  const empty = await run(['auth', 'status', deployment]);
  assert.equal(empty.code, 1);
  assert.equal(JSON.parse(empty.stdout).authenticated, false);
});
