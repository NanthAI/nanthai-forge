// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFunctionReference } from 'convex/server';
import { readAuth, writeAuth, resolveAuthToken, authFile } from '../dist/auth-store.js';
import { localDevice, renewDevice } from '../dist/device-key.js';
import { verifyDeviceProof } from '../dist/device-token.js';
import { deadlineConvexClient } from '../dist/network-convex-client.js';

test('expired commands renew by their local key, reconcile lost replies, keep private keys local and preserve the environment override', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-stable-renew-'));
  const names = ['XDG_CONFIG_HOME', 'FORGE_HTTP_URL', 'FORGE_AUTH_TOKEN', 'FORGE_DEPLOYMENT_URL'];
  const old = names.map(name => [name, process.env[name]]);
  process.env.XDG_CONFIG_HOME = directory;
  names.slice(1).forEach(name => delete process.env[name]);
  t.after(() => {
    old.forEach(([name, value]) =>
      value === undefined ? delete process.env[name] : (process.env[name] = value),
    );
    rmSync(directory, { recursive: true, force: true });
  });
  let deployment,
    requestCount = 0,
    simulateLostReply = true,
    expireProof = false,
    seenAuth;
  const receipts = new Map();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/auth/device/renew') {
      requestCount++;
      assert(verifyDeviceProof(deployment, 'renew', body.operationId, body.device));
      assert.equal(JSON.stringify(body).includes('PRIVATE KEY'), false);
      let result = receipts.get(body.operationId);
      if (!result) {
        result = expireProof
          ? { status: 'proof-expired' }
          : {
              status: 'approved',
              token: `synthetic-renewed-${receipts.size}`,
              expiresAt: Date.now() + 60000,
              signInId: body.operationId,
            };
        receipts.set(body.operationId, result);
        expireProof = false;
      }
      if (simulateLostReply) {
        simulateLostReply = false;
        res.destroy();
        return;
      }
      return res.end(JSON.stringify(result));
    }
    seenAuth = req.headers.authorization;
    res.end(JSON.stringify({ status: 'success', value: 'read-completed' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  deployment = `http://127.0.0.1:${server.address().port}`;
  const device = localDevice(deployment),
    store = readAuth();
  store.deployments[deployment] = {
    token: 'synthetic-expired',
    credentialId: device.id,
    deviceId: device.id,
    deviceCode: 'dv-synthetic',
    name: 'Private label',
    scope: 'cli',
    expiresAt: 1,
  };
  writeAuth(store);
  const token = resolveAuthToken(deployment);
  const client = deadlineConvexClient(deployment, { skipConvexDeploymentUrlCheck: true });
  client.setAuth(token);
  assert.equal(await client.query(makeFunctionReference('synthetic:read'), {}), 'read-completed');
  assert(requestCount >= 2);
  assert.equal(receipts.size, 1, 'lost reply reuses the saved renewal operation');
  assert.equal(seenAuth, 'Bearer synthetic-renewed-0');
  assert.equal(readAuth().devices[deployment].privateKey, device.privateKey);
  assert.equal(readAuth().devices[deployment].pendingRenewal, undefined);
  assert.equal(statSync(authFile()).mode & 0o777, 0o600);
  const before = requestCount;
  await client.query(makeFunctionReference('synthetic:read'), {});
  assert.equal(requestCount, before, 'valid command has no renewal RPC');
  // A confirmed expired proof is reconciled automatically with a fresh operation.
  const latest = readAuth();
  latest.deployments[deployment].expiresAt = 1;
  writeAuth(latest);
  resolveAuthToken(deployment);
  expireProof = true;
  const renewed = await renewDevice(deployment);
  assert.equal(renewed.token, 'synthetic-renewed-2');
  assert.equal(receipts.size, 3);
  process.env.FORGE_AUTH_TOKEN = 'synthetic-environment';
  process.env.FORGE_DEPLOYMENT_URL = deployment;
  assert.equal(resolveAuthToken(deployment), 'synthetic-environment');
  client.setAuth('synthetic-environment');
  const current = requestCount;
  await client.query(makeFunctionReference('synthetic:read'), {});
  assert.equal(seenAuth, 'Bearer synthetic-environment');
  assert.equal(requestCount, current);
  // Clearing a client must not silently restore its saved device authority later.
  delete process.env.FORGE_AUTH_TOKEN;
  const expiredAgain = readAuth();
  expiredAgain.deployments[deployment].expiresAt = 1;
  writeAuth(expiredAgain);
  client.setAuth(resolveAuthToken(deployment));
  client.clearAuth();
  await client.query(makeFunctionReference('synthetic:read'), {});
  assert.equal(seenAuth, undefined);
  assert.equal(requestCount, current, 'explicitly cleared authentication never renews');
});
