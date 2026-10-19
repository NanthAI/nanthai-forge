// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, chmodSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { deviceHash, equalHash, issueDeviceToken, userCode, tokenKeys } from '../dist/device-token.js';
import { authFile, readAuth, writeAuth, resolveAuthToken } from '../dist/auth-store.js';
import { coordinationCredentials } from '../dist/coordination-client.js';
const store = await import(moduleUrl('../convex/deviceStore.ts'));
const actions = await import(moduleUrl('../convex/deviceActions.ts'));
const credentials = await import(moduleUrl('../convex/deviceCredentials.ts'));
const hosted = await import(moduleUrl('../convex/projectBackups.ts'));
const coordination = await import(moduleUrl('../convex/projectCoordination.ts'));
const { guard } = await import(moduleUrl('../convex/cliServer.ts'));
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});
function fixture(t) {
  const names = ['FORGE_CLI_PRIVATE_KEY', 'FORGE_CLI_ISSUER', 'FORGE_WEB_URL'];
  const old = names.map(name => process.env[name]);
  Object.assign(process.env, {
    FORGE_CLI_PRIVATE_KEY: privateKey,
    FORGE_CLI_ISSUER: 'https://forge-test.convex.site',
    FORGE_WEB_URL: 'https://forge.example',
  });
  t.after(() =>
    names.forEach((name, i) =>
      old[i] === undefined ? delete process.env[name] : (process.env[name] = old[i]),
    ),
  );
  const s = state();
  for (const name of ['deviceCodes', 'deviceAttempts', 'cliCredentials']) s.tables[name] = new Map();
  const originalQuery = s.ctx.runQuery;
  s.ctx.runQuery = async (ref, args) => {
    const [module, name] = getFunctionName(ref).split(':');
    return module === 'deviceStore' ? store[name]._handler(s.ctx, args) : originalQuery(ref, args);
  };
  const originalMutation = s.ctx.runMutation;
  s.ctx.runMutation = async (ref, args) => {
    const [module, name] = getFunctionName(ref).split(':');
    return module === 'deviceStore' ? store[name]._handler(s.ctx, args) : originalMutation(ref, args);
  };
  return s;
}
const start = (s, extra = {}) => {
  const input = {
    operationId: randomUUID(),
    clientNonce: randomBytes(32).toString('hex'),
    name: 'Synthetic CLI',
    scope: 'cli',
    ...extra,
  };
  return actions.start._handler(s.ctx, input).then(flow => ({
    input,
    flow,
    pollInput: { deviceCode: flow.device_code },
    row: [...s.tables.deviceCodes.values()].at(-1),
  }));
};
const decide = (s, flow, approve = true, operationId = randomUUID()) =>
  actions.decide._handler(s.ctx, { code: flow.user_code, approve, operationId });
const poll = (s, input, operationId = randomUUID()) =>
  actions.poll._handler(s.ctx, { deviceCode: input.deviceCode, operationId });
const rejected = code => error => (error.data?.code ?? error.code) === code;

test('device flow hashes secrets, reconciles retries, signs Forge JWTs, and binds the approving identity', async t => {
  const s = fixture(t),
    { input, flow, row, pollInput } = await start(s);
  const retry = await actions.start._handler(s.ctx, input);
  assert.deepEqual({ ...retry, expires_in: flow.expires_in }, flow);
  assert.equal(s.tables.deviceCodes.size, 1);
  await assert.rejects(
    actions.start._handler(s.ctx, { ...input, clientNonce: '0'.repeat(64) }),
    rejected('AUTH_OPERATION_CHANGED'),
  );
  assert.equal((await poll(s, { deviceCode: input.clientNonce })).status, 'expired_token');
  assert.notEqual(flow.device_code, input.clientNonce);
  assert.ok(flow.expires_in >= 599 && flow.expires_in <= 600);
  assert.equal(flow.verification_uri, 'https://forge.example/device');
  assert.match(flow.user_code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.equal(JSON.stringify([...s.tables.deviceCodes.values()]).includes(flow.device_code), false);
  assert.equal(JSON.stringify([...s.tables.deviceCodes.values()]).includes(flow.user_code), false);
  const view = await actions.inspect._handler(s.ctx, { code: flow.user_code.toLowerCase() });
  assert.equal(view.name, input.name);
  const decisionId = randomUUID();
  await decide(s, flow, true, decisionId);
  await decide(s, flow, true, decisionId);
  const redemptionId = randomUUID(),
    result = await poll(s, pollInput, redemptionId);
  const payload = JSON.parse(Buffer.from(result.token.split('.')[1], 'base64url'));
  assert.equal(payload.sub, 'owner');
  assert.equal(payload.iss, process.env.FORGE_CLI_ISSUER);
  assert.equal(payload.aud, 'forge-cli');
  assert.equal(payload.exp - payload.iat, 30 * 24 * 3600);
  const [header, body, signature] = result.token.split('.');
  assert.equal(
    verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${body}`),
      createPublicKey(privateKey),
      Buffer.from(signature, 'base64url'),
    ),
    true,
  );
  const credential = [...s.tables.cliCredentials.values()][0];
  assert.equal(credential.tokenHash, deviceHash(result.token));
  assert.equal(JSON.stringify(credential).includes(result.token), false);
  row.nextPollAt = 0;
  assert.equal((await poll(s, pollInput, redemptionId)).token, result.token);
  assert.equal(s.tables.cliCredentials.size, 1);
  assert.equal((await poll(s, pollInput)).status, 'invalid_grant');
  s.caller('another');
  await assert.rejects(decide(s, flow, true, decisionId), rejected('AUTH_OPERATION_CHANGED'));
  await assert.rejects(
    credentials.revoke._handler(s.ctx, { credentialId: credential.credentialId, operationId: randomUUID() }),
    rejected('AUTH_REQUIRED'),
  );
});

test('expired, denied, unknown and reused codes never issue a credential; polling is throttled', async t => {
  const s = fixture(t),
    pending = await start(s);
  assert.equal((await poll(s, pending.pollInput)).status, 'authorization_pending');
  assert.equal((await poll(s, pending.pollInput)).status, 'slow_down');
  pending.row.expiresAt = Date.now() - 1;
  assert.equal((await poll(s, pending.pollInput)).status, 'expired_token');
  await assert.rejects(decide(s, pending.flow), rejected('AUTH_EXPIRED'));
  const denied = await start(s);
  await decide(s, denied.flow, false);
  assert.equal((await poll(s, denied.pollInput)).status, 'access_denied');
  await assert.rejects(decide(s, denied.flow), rejected('AUTH_CODE_USED'));
  assert.equal((await poll(s, { deviceCode: randomBytes(32).toString('hex') })).status, 'expired_token');
  assert.equal(s.tables.cliCredentials.size, 0);
});

test('approval attempts are rate limited even when codes are invalid, and browser sign-in is required', async t => {
  const s = fixture(t);
  for (let i = 0; i < 10; i++)
    await assert.rejects(actions.inspect._handler(s.ctx, { code: 'WRONG-CODE' }), rejected('AUTH_EXPIRED'));
  await assert.rejects(actions.inspect._handler(s.ctx, { code: 'WRONG-CODE' }), rejected('AUTH_SLOW_DOWN'));
  s.caller(undefined);
  await assert.rejects(actions.inspect._handler(s.ctx, { code: 'WRONG-CODE' }), rejected('AUTH_REQUIRED'));
});

test('revocation, expiry and wrong owner reject credentials; coordination scope cannot widen project access', async t => {
  const s = fixture(t),
    login = await start(s, { scope: 'coordination' });
  await decide(s, login.flow);
  const result = await poll(s, login.pollInput);
  const row = [...s.tables.cliCredentials.values()][0];
  s.ctx.auth.getUserIdentity = async () => ({
    subject: 'owner',
    issuer: process.env.FORGE_CLI_ISSUER,
    forgeCredential: result.credentialId,
  });
  await guard(s.ctx, 'coordination');
  await assert.rejects(guard(s.ctx, 'cli'), rejected('AUTH_SCOPE_DENIED'));
  await assert.rejects(
    hosted.list._handler(s.ctx, { paginationOpts: { cursor: null, numItems: 10 } }),
    rejected('AUTH_SCOPE_DENIED'),
  );
  await assert.rejects(
    coordination.sessions._handler(s.ctx, {
      projectId: 'not-authorized',
      paginationOpts: { cursor: null, numItems: 10 },
    }),
    error => ['PROJECT_UNAVAILABLE', 'BAD_ARGUMENT'].includes(error.data?.code ?? error.code),
  );
  await assert.rejects(
    actions.inspect._handler(s.ctx, { code: login.flow.user_code }),
    rejected('AUTH_SCOPE_DENIED'),
  );
  s.ctx.auth.getUserIdentity = async () => ({
    subject: 'another',
    issuer: process.env.FORGE_CLI_ISSUER,
    forgeCredential: result.credentialId,
  });
  await assert.rejects(guard(s.ctx, 'coordination'), rejected('AUTH_REVOKED'));
  s.ctx.auth.getUserIdentity = async () => ({
    subject: 'owner',
    issuer: process.env.FORGE_CLI_ISSUER,
    forgeCredential: result.credentialId,
  });
  row.expiresAt = Date.now() - 1;
  await assert.rejects(guard(s.ctx, 'coordination'), rejected('AUTH_REVOKED'));
  row.expiresAt = Date.now() + 60000;
  await credentials.revoke._handler(s.ctx, { credentialId: row.credentialId, operationId: randomUUID() });
  await credentials.revoke._handler(s.ctx, { credentialId: row.credentialId, operationId: randomUUID() });
  await assert.rejects(credentials.status._handler(s.ctx, {}), rejected('AUTH_REVOKED'));
});

test('full CLI token does not grant access to another owner and checks revocation after actions', async t => {
  const s = fixture(t),
    login = await start(s);
  await decide(s, login.flow);
  const result = await poll(s, login.pollInput);
  const row = [...s.tables.cliCredentials.values()][0];
  s.ctx.auth.getUserIdentity = async () => ({
    subject: 'owner',
    issuer: process.env.FORGE_CLI_ISSUER,
    forgeCredential: result.credentialId,
  });
  await guard(s.ctx, 'cli');
  s.tables.hostedProjects.set('shared-project', {
    _id: 'shared-project',
    owner: 'another',
    key: 'synthetic',
    name: 'Shared',
    revision: 1,
    currentBackup: null,
  });
  s.tables.projectContributors.set('membership', {
    _id: 'membership',
    projectId: 'shared-project',
    contributor: 'owner',
  });
  await coordination.sessions._handler(s.ctx, {
    projectId: 'shared-project',
    paginationOpts: { cursor: null, numItems: 10 },
  });
  s.tables.projectContributors.delete('membership');
  await assert.rejects(
    coordination.sessions._handler(s.ctx, {
      projectId: 'shared-project',
      paginationOpts: { cursor: null, numItems: 10 },
    }),
    rejected('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    coordination.sessions._handler(s.ctx, {
      projectId: 'not-authorized',
      paginationOpts: { cursor: null, numItems: 10 },
    }),
    rejected('PROJECT_UNAVAILABLE'),
  );
  const { action } = await import(moduleUrl('../convex/cliServer.ts'));
  const operation = action({
    args: {},
    handler: async () => {
      row.revoked = true;
      return 'private result';
    },
  });
  const actionCtx = { auth: s.ctx.auth, runQuery: s.ctx.runQuery };
  await assert.rejects(operation._handler(actionCtx, {}), rejected('AUTH_REVOKED'));
});

test('local store is 0600, deployment-bound, environment-overridable and rejects unsafe permissions', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-auth-')),
    oldToken = process.env.FORGE_AUTH_TOKEN,
    old = process.env.XDG_CONFIG_HOME;
  delete process.env.FORGE_AUTH_TOKEN;
  process.env.XDG_CONFIG_HOME = directory;
  t.after(() => {
    if (oldToken === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = oldToken;
    if (old === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = old;
    rmSync(directory, { recursive: true, force: true });
  });
  const deployment = 'https://synthetic.convex.cloud';
  writeAuth({
    defaultDeployment: deployment,
    deployments: {
      [deployment]: {
        token: 'synthetic-token',
        credentialId: 'device-id',
        name: 'Test',
        scope: 'cli',
        expiresAt: Date.now() + 60000,
      },
    },
  });
  assert.equal(statSync(authFile()).mode & 0o777, 0o600);
  assert.equal(resolveAuthToken(deployment, undefined), 'synthetic-token');
  assert.equal(resolveAuthToken(deployment, 'ci-override'), 'ci-override');
  assert.equal(resolveAuthToken('https://other.convex.cloud', undefined), undefined);
  assert.equal(coordinationCredentials(deployment, undefined).token, 'synthetic-token');
  assert.equal(coordinationCredentials(deployment, 'ci-override').token, 'ci-override');
  chmodSync(authFile(), 0o644);
  assert.throws(readAuth, rejected('AUTH_FILE_PERMISSIONS'));
});

test('public backend registrations all use the CLI credential guard; token signing and hash comparison are stable', () => {
  for (const file of readdirSync(new URL('../convex', import.meta.url)).filter(
    name => name.endsWith('.ts') && !['cliServer.ts', 'deviceCredentials.ts'].includes(name),
  )) {
    const source = readFileSync(new URL(`../convex/${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/_generated\/server['"]/g))
      assert.equal(/\b(query|mutation|action)\b/.test(match[1]), false, file);
  }
  assert.equal(equalHash(deviceHash('one'), deviceHash('one')), true);
  assert.equal(equalHash(deviceHash('one'), deviceHash('two')), false);
  assert.equal(equalHash('', ''), false);
  assert.equal(userCode(privateKey, 'op', 'secret'), userCode(privateKey, 'op', 'secret'));
  const args = { owner: 'owner', credentialId: 'id', issuedAt: 1000000 };
  assert.equal(
    issueDeviceToken(privateKey, 'https://issuer.example', args),
    issueDeviceToken(privateKey, 'https://issuer.example', args),
  );
  assert.equal('d' in tokenKeys(privateKey).jwk, false);
});

test('device HTTP routes return no-store responses, reject malformed bodies and publish only the public JWK', async t => {
  const s = fixture(t),
    { default: http } = await import(moduleUrl('../convex/http.ts'));
  const ctx = { runAction: (ref, args) => actions[getFunctionName(ref).split(':')[1]]._handler(s.ctx, args) };
  const route = path => http.getRoutes().find(([value]) => value === path)[2];
  const input = {
    operationId: randomUUID(),
    clientNonce: randomBytes(32).toString('hex'),
    name: 'Synthetic HTTP CLI',
    scope: 'cli',
  };
  const response = await route('/auth/device/start')._handler(
    ctx,
    new Request('https://forge.example/auth/device/start', { method: 'POST', body: JSON.stringify(input) }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const flow = await response.json();
  assert.notEqual(flow.device_code, input.clientNonce);
  assert.match(flow.device_code, /^[0-9a-f]{64}$/);
  const bad = await route('/auth/device/start')._handler(
    { runAction: () => assert.fail('Malformed JSON must not execute an action.') },
    new Request('https://forge.example/auth/device/start', { method: 'POST', body: 'invalid json' }),
  );
  assert.equal(bad.status, 400);
  assert.equal(s.tables.deviceCodes.size, 1);
  const publicKey = await route('/auth/jwks')._handler(ctx, new Request('https://forge.example/auth/jwks'));
  assert.equal(publicKey.status, 200);
  assert.equal(publicKey.headers.get('cache-control'), 'public, max-age=300, must-revalidate');
  const jwks = await publicKey.json();
  assert.equal(jwks.keys[0].kty, 'RSA');
  assert.equal('d' in jwks.keys[0], false);
  assert.equal('p' in jwks.keys[0], false);
});

test('issuer reconfiguration cannot widen a device scope or bypass revocation/browser approval', async t => {
  const s = fixture(t),
    login = await start(s, { scope: 'coordination' });
  await decide(s, login.flow);
  const result = await poll(s, login.pollInput);
  const row = [...s.tables.cliCredentials.values()][0],
    originalIssuer = process.env.FORGE_CLI_ISSUER;
  s.ctx.auth.getUserIdentity = async () => ({
    subject: 'owner',
    issuer: originalIssuer,
    forgeCredential: result.credentialId,
  });
  process.env.FORGE_CLI_ISSUER = 'https://replacement.convex.site';
  await assert.rejects(guard(s.ctx, 'cli'), rejected('AUTH_SCOPE_DENIED'));
  delete process.env.FORGE_CLI_ISSUER;
  await assert.rejects(guard(s.ctx, 'cli'), rejected('AUTH_SCOPE_DENIED'));
  row.revoked = true;
  await assert.rejects(guard(s.ctx, 'coordination'), rejected('AUTH_REVOKED'));
  row.revoked = false;
  row.scope = 'cli';
  await assert.rejects(
    actions.inspect._handler(s.ctx, { code: login.flow.user_code }),
    rejected('AUTH_REQUIRED'),
  );
});
