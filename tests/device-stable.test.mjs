// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, randomBytes, sign } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
import { deviceHash, verifyDeviceProof, stableDeviceCode } from '../dist/device-token.js';
const names = ['deviceStore', 'deviceApprovalStore', 'deviceStableStore'];
const modules = Object.fromEntries(
  await Promise.all(names.map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))])),
);
const actions = await import(moduleUrl('../convex/deviceActions.ts'));
const stable = await import(moduleUrl('../convex/deviceStableActions.ts'));
const credentials = await import(moduleUrl('../convex/deviceCredentials.ts'));
const policy = await import(moduleUrl('../convex/accessPolicy.ts'));
const { guard } = await import(moduleUrl('../convex/cliServer.ts'));
const authority = await import(moduleUrl('../convex/projectAuthority.ts'));
const origin = 'https://synthetic.convex.site';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});
function key() {
  const pair = generateKeyPairSync('ed25519');
  return {
    id: randomUUID(),
    key: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: pair.privateKey,
  };
}
function proof(device, purpose, operationId, extra = null, at = Date.now()) {
  const claim = { id: device.id, key: device.key, at };
  return {
    ...claim,
    proof: sign(
      null,
      Buffer.from(JSON.stringify(['forge-device-v1', purpose, origin, operationId, claim, extra])),
      device.privateKey,
    ).toString('base64url'),
  };
}
const code = value => error => (error.data?.code ?? error.code) === value;
function fixture(t) {
  const old = ['FORGE_CLI_PRIVATE_KEY', 'FORGE_CLI_ISSUER', 'FORGE_WEB_URL'].map(name => [
    name,
    process.env[name],
  ]);
  Object.assign(process.env, {
    FORGE_CLI_PRIVATE_KEY: rsa,
    FORGE_CLI_ISSUER: origin,
    FORGE_WEB_URL: 'https://forge.example',
  });
  t.after(() =>
    old.forEach(([name, value]) =>
      value === undefined ? delete process.env[name] : (process.env[name] = value),
    ),
  );
  const f = lanesFixture();
  const projectId = f.insert('hostedProjects', {
    owner: 'owner',
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    autonomyPolicy: { ...policyPreset('trusted'), accessIdentities: { devices: true } },
  });
  f.insert('users', { accountKey: 'owner', emailVerified: false });
  f.insert('users', { accountKey: 'other', emailVerified: false });
  let actor = 'owner';
  const dispatch = (ref, args) => {
    const [name, method] = getFunctionName(ref).split(':');
    return f.call(`${name}:${method}`, modules[name][method], args, actor);
  };
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: actor }) },
    runQuery: dispatch,
    runMutation: dispatch,
  };
  const keys = new Map();
  const start = async (device, fields = {}) => {
    const operationId = randomUUID(),
      clientNonce = randomBytes(32).toString('hex');
    const extra = { clientNonce, name: 'Terminal suggestion', scope: 'cli', projectId, ...fields };
    const input = { origin, operationId, ...extra, device: proof(device, 'start', operationId, extra) };
    const flow = JSON.parse(await stable.start._handler(ctx, input));
    if (flow.device_code) keys.set(flow.device_code, device);
    return { flow, input };
  };
  const inspect = input => actions.inspect._handler(ctx, input);
  const approve = (flow, fields = {}, operationId = randomUUID()) =>
    actions.decide._handler(ctx, { code: flow.user_code, approve: true, operationId, ...fields });
  const poll = async flow => {
    const result = await actions.poll._handler(ctx, {
      deviceCode: flow.device_code,
      operationId: randomUUID(),
    });
    const device = keys.get(flow.device_code);
    if (device && result.deviceId) device.id = result.deviceId;
    return result;
  };
  const renew = (device, operationId = randomUUID(), at) =>
    stable.renew
      ._handler(ctx, { origin, operationId, device: proof(device, 'renew', operationId, null, at) })
      .then(JSON.parse);
  return {
    ...f,
    ctx,
    projectId,
    start,
    inspect,
    approve,
    poll,
    renew,
    actor(value) {
      actor = value;
    },
  };
}

test('a device proof binds key, origin, purpose, operation and requested project settings', () => {
  const device = key(),
    operationId = randomUUID(),
    extra = { projectId: 'synthetic' },
    signed = proof(device, 'start', operationId, extra);
  assert(verifyDeviceProof(origin, 'start', operationId, signed, extra));
  assert.equal(verifyDeviceProof('https://other.example', 'start', operationId, signed, extra), false);
  assert.equal(verifyDeviceProof(origin, 'renew', operationId, signed, extra), false);
  assert.equal(verifyDeviceProof(origin, 'start', randomUUID(), signed, extra), false);
  assert.equal(verifyDeviceProof(origin, 'start', operationId, signed, { projectId: 'other' }), false);
  assert.equal(verifyDeviceProof(origin, 'start', operationId, { ...signed, key: key().key }, extra), false);
});

test('first approval names and scopes the key once; remembered login keeps settings and invalidates the old bearer generation', async t => {
  const f = fixture(t),
    device = key(),
    { flow, input } = await f.start(device);
  assert.equal(f.tables.cliCredentials.size, 0);
  assert.match(flow.verification_uri_complete, /\/-\/device\?code=/);
  const view = await f.inspect({ code: flow.user_code });
  assert.equal(view.device.code, stableDeviceCode(device.key));
  assert.equal(view.device.known, false);
  const settings = { source: 'read', projects: { kind: 'project', projectId: f.projectId } };
  const operationId = randomUUID();
  await f.approve(flow, { name: 'Own private label', settings }, operationId);
  await f.approve(flow, { name: 'Own private label', settings }, operationId);
  await assert.rejects(
    f.approve(flow, { name: 'Changed', settings }, operationId),
    code('AUTH_OPERATION_CHANGED'),
  );
  const first = await f.poll(flow),
    before = [...f.tables.cliCredentials.values()][0];
  assert.equal(first.name, 'Own private label');
  assert.equal(first.deviceCode, stableDeviceCode(device.key));
  assert.equal(JSON.parse(Buffer.from(first.token.split('.')[1], 'base64url')).forgeSignIn, operationId);
  const next = await f.start(device, { name: 'Different untrusted suggestion' });
  assert.match(next.flow.verification_uri_complete, /\?request=/);
  const known = await f.inspect({ requestId: next.input.operationId });
  assert.equal(known.name, 'Own private label');
  assert.deepEqual(known.device.settings, settings);
  await f.approve(next.flow);
  const second = await f.poll(next.flow);
  assert.equal(second.deviceId, first.deviceId);
  const current = [...f.tables.cliCredentials.values()][0];
  assert.equal(current.deviceApprovedAt, before.deviceApprovedAt);
  assert.deepEqual(current.settings, settings);
  assert.equal(f.tables.cliCredentials.size, 1);
  const user = { subject: 'owner', forgeCredential: first.credentialId, forgeSignIn: first.signInId };
  await assert.rejects(
    f.call('old bearer', { _handler: ctx => guard(ctx, 'cli') }, {}, user),
    code('AUTH_REVOKED'),
  );
  await assert.rejects(
    f.call(
      'old bearer cannot end a later sign-in',
      credentials.revoke,
      { credentialId: first.credentialId, operationId: randomUUID() },
      user,
    ),
    code('AUTH_REVOKED'),
  );
  const fresh = { ...user, forgeSignIn: second.signInId };
  await f.call('new bearer', { _handler: ctx => guard(ctx, 'cli') }, {}, fresh);
  await assert.rejects(
    f.call(
      'read-only write',
      { _handler: ctx => authority.activeProject(ctx, f.projectId, 'owner') },
      {},
      fresh,
    ),
    code('AUTH_SCOPE_DENIED'),
  );
  const another = f.insert('hostedProjects', {
    owner: 'owner',
    key: 'another',
    name: 'Another',
    currentBackup: null,
    revision: 0,
  });
  await assert.rejects(
    f.call(
      'other project',
      { _handler: ctx => authority.accessibleProject(ctx, another, 'owner') },
      {},
      fresh,
    ),
    code('AUTH_SCOPE_DENIED'),
  );
  assert(!JSON.stringify([...f.tables.authLinkEvents.values()]).includes(first.token));
  assert.equal(deviceHash(first.token), before.tokenHash);
});

test('sign-out keeps the approved key and settings; removal revokes them; replaying an old sign-out never ends a later sign-in', async t => {
  const f = fixture(t),
    device = key(),
    { flow } = await f.start(device);
  await f.approve(flow);
  const signed = await f.poll(flow);
  const original = [...f.tables.cliCredentials.values()][0],
    end = { credentialId: signed.credentialId, operationId: randomUUID() };
  await f.call('sign out', credentials.revoke, end);
  assert.deepEqual([...f.tables.cliCredentials.values()][0].settings, original.settings);
  assert.equal((await f.renew(device)).status, 'signed-out');
  const back = await f.start(device);
  await f.approve(back.flow);
  await f.poll(back.flow);
  await f.call('retry old sign out', credentials.revoke, end);
  assert.equal([...f.tables.cliCredentials.values()][0].revoked, false);
  await f.call('remove', credentials.revoke, {
    credentialId: signed.credentialId,
    operationId: randomUUID(),
    action: 'remove',
  });
  const removed = [...f.tables.cliCredentials.values()][0];
  assert.equal(removed.settings, undefined);
  assert.equal(removed.name, '');
  assert.equal(removed.removed, true);
  assert.equal((await f.renew(device)).status, 'removed');
  assert.equal((await f.start(device)).flow.status, 'removed');
});

test('renewal reconciles unknown outcomes, rejects changed proof on replay, and never reactivates a signed-out device', async t => {
  const f = fixture(t),
    device = key(),
    { flow } = await f.start(device);
  await f.approve(flow);
  const first = await f.poll(flow);
  const operationId = randomUUID(),
    at = Date.now();
  const renewed = await f.renew(device, operationId, at);
  assert.equal(renewed.status, 'approved');
  assert.equal((await f.renew(device, operationId, at)).token, renewed.token);
  await assert.rejects(f.renew(device, operationId, at + 1), code('AUTH_OPERATION_CHANGED'));
  assert.equal((await f.renew(device, randomUUID(), Date.now() - 700_000)).status, 'proof-expired');
  await f.call('end renewed', credentials.revoke, {
    credentialId: first.credentialId,
    operationId: randomUUID(),
  });
  await f.renew(device, operationId, at);
  assert.equal([...f.tables.cliCredentials.values()][0].revoked, true);
});

test('switching browser account creates a separate approval without revealing or overwriting the first person’s device', async t => {
  const f = fixture(t),
    device = key(),
    first = await f.start(device);
  await f.approve(first.flow, { name: 'First person private label' });
  const signed = await f.poll(first.flow);
  const own = [...f.tables.cliCredentials.values()][0],
    next = await f.start(device);
  f.actor('other');
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'other' });
  const hidden = await f.inspect({ requestId: next.input.operationId });
  assert.deepEqual(hidden, { needsCode: true });
  const view = await f.inspect({ code: next.flow.user_code });
  assert.equal(view.device.known, false);
  assert.doesNotMatch(JSON.stringify(view), /First person private label/);
  await f.approve(next.flow, { name: 'Second person label' });
  const other = await f.poll(next.flow);
  assert.notEqual(other.credentialId, signed.credentialId);
  assert.deepEqual(f.tables.cliCredentials.get(own._id), own);
  f.actor('owner');
  await assert.rejects(
    f.call('foreign settings', credentials.rename, {
      credentialId: other.credentialId,
      name: 'Denied',
      operationId: randomUUID(),
    }),
    code('AUTH_REQUIRED'),
  );
});

test('the one device-end policy controls the alternate owner answer in the real revocation handler', async t => {
  const f = fixture(t),
    device = key(),
    { flow } = await f.start(device);
  await f.approve(flow);
  const signed = await f.poll(flow);
  const previous = policy.accessPolicy.deviceEnd;
  try {
    policy.accessPolicy.deviceEnd = 'both-revoke';
    await f.call('alternate sign out', credentials.revoke, {
      credentialId: signed.credentialId,
      operationId: randomUUID(),
    });
    assert.equal([...f.tables.cliCredentials.values()][0].removed, true);
    assert.equal([...f.tables.cliCredentials.values()][0].settings, undefined);
  } finally {
    policy.accessPolicy.deviceEnd = previous;
  }
});

test('a redirected Git session from an earlier device sign-in cannot become valid after re-login', async t => {
  const f = fixture(t),
    device = key(),
    { flow } = await f.start(device);
  await f.approve(flow);
  const first = await f.poll(flow);
  const next = await f.start(device);
  await f.approve(next.flow);
  await f.poll(next.flow);
  const git = await import(moduleUrl('../convex/gitServeStore.ts'));
  assert.deepEqual(
    await f.call('old Git session', git.load, {
      projectId: f.projectId,
      sessionCredentialId: first.credentialId,
      sessionSignIn: first.signInId,
    }),
    { status: 'bad-credential' },
  );
  assert.deepEqual(
    await f.call('missing Git generation', git.load, {
      projectId: f.projectId,
      sessionCredentialId: first.credentialId,
    }),
    { status: 'bad-credential' },
  );
});

test('member device pages keep owner-only labels and bounded reads at current and doubled device scale', async t => {
  for (const total of [1200, 2400]) {
    const f = fixture(t);
    f.insert('projectContributors', { projectId: f.projectId, contributor: 'peer' });
    for (let i = 0; i < total; i++)
      f.insert('cliCredentials', {
        owner: 'owner',
        credentialId: randomUUID(),
        name: 'Private device label',
        scope: 'cli',
        tokenHash: 'synthetic',
        issuedAt: 1,
        expiresAt: Date.now() + 60000,
        revoked: false,
        deviceKey: `synthetic-key-${i}`,
        deviceCode: `dv-synthetic-${i}`,
        deviceApprovedAt: 1,
        settings: { source: 'write', projects: { kind: 'all' } },
      });
    const input = { projectId: f.projectId, person: 'owner', paginationOpts: { numItems: 25, cursor: null } };
    const page = await f.call('member devices', credentials.project, input, 'peer');
    assert.equal(page.page.length, 25);
    assert.equal(page.isDone, false);
    assert(page.page.every(row => row.name === undefined && row.code && row.approvedAt === 1));
    assert.doesNotMatch(JSON.stringify(page), /Private device label|tokenHash|synthetic-key/);
    const count = f.counts.at(-1);
    assert(count.documents <= 32);
    assert.equal(count.writes, 0);
    console.log(
      JSON.stringify({
        devices: total,
        rows: page.page.length,
        ranges: count.ranges,
        documents: count.documents,
        readBytes: count.readBytes,
        writes: count.writes,
      }),
    );
    const mine = await f.call('own devices', credentials.project, input, 'owner');
    assert(mine.page.every(row => row.name === 'Private device label'));
  }
});

test('device settings never expand current person membership and browser settings changes reject another account', async t => {
  const f = fixture(t),
    device = key(),
    { flow } = await f.start(device);
  await f.approve(flow);
  const signed = await f.poll(flow);
  const user = { subject: 'owner', forgeCredential: signed.credentialId, forgeSignIn: signed.signInId };
  f.patch('hostedProjects', f.projectId, { owner: 'other' });
  const member = f.insert('projectContributors', { projectId: f.projectId, contributor: 'owner' });
  await f.call(
    'current writer',
    { _handler: ctx => authority.activeProject(ctx, f.projectId, 'owner') },
    {},
    user,
  );
  f.tables.projectContributors.delete(member);
  await assert.rejects(
    f.call(
      'removed writer',
      { _handler: ctx => authority.activeProject(ctx, f.projectId, 'owner') },
      {},
      user,
    ),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    f.call(
      'foreign configure',
      credentials.rename,
      {
        credentialId: signed.credentialId,
        name: 'Denied',
        settings: { source: 'write', projects: { kind: 'all' } },
        operationId: randomUUID(),
      },
      'other',
    ),
    code('AUTH_REQUIRED'),
  );
});

test('the central device-end policy preserves older credential names on sign-out and deletes them on removal', async t => {
  const f = fixture(t),
    credentialId = randomUUID();
  const id = f.insert('cliCredentials', {
    owner: 'owner',
    credentialId,
    name: 'Older private label',
    scope: 'cli',
    issuedAt: 1,
    expiresAt: Date.now() + 60000,
    tokenHash: 'synthetic',
    revoked: false,
  });
  await f.call('old sign out', credentials.revoke, { credentialId, operationId: randomUUID() });
  assert.equal(f.tables.cliCredentials.get(id).name, 'Older private label');
  await f.call('old remove', credentials.revoke, {
    credentialId,
    operationId: randomUUID(),
    action: 'remove',
  });
  const removed = f.tables.cliCredentials.get(id);
  assert.equal(removed.revoked, true);
  assert.equal(removed.removed, true);
  assert.equal(removed.name, '');
  assert.equal(removed.settings, undefined);
});
