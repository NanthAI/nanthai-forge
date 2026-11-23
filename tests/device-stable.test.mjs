// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import { storageClock } from './storage-clock.mjs';
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
  let actor = 'owner',
    authUser,
    freshUntil = Date.now() + 600000;
  const dispatch = (ref, args) => {
    const [name, method] = getFunctionName(ref).split(':');
    return f.call(`${name}:${method}`, modules[name][method], args, {
      subject: actor,
      forgeAuthDeviceVerifiedUntil: freshUntil,
      ...(authUser ? { forgeAuthUser: authUser } : {}),
    });
  };
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: actor, forgeAuthDeviceVerifiedUntil: freshUntil }) },
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
    fresh(value) {
      freshUntil = value ? Date.now() + 600000 : 0;
    },
    actor(value) {
      actor = value;
    },
    authUser(value) {
      authUser = value;
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
  assert.match(flow.verification_uri_complete, /\/device\?code=/);
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
  assert.match(next.flow.verification_uri_complete, /\?code=/);
  assert.equal((await f.inspect({ requestId: next.input.operationId })).device.known, true);
  const known = await f.inspect({ code: next.flow.user_code });
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
  assert.equal((await f.renew(device)).status, 'unapproved');
  assert((await f.start(device)).flow.user_code);
});

for (const format of ['current', 'legacy']) {
  test(`${format} revoke receipts reject changed actions and replay without writes after the sign-in ends`, async t => {
    const f = fixture(t);
    const device = key();
    const signIn = async () => {
      const { flow } = await f.start(device);
      await f.approve(flow);
      const { credentialId, signInId } = await f.poll(flow);
      return { subject: 'owner', forgeCredential: credentialId, forgeSignIn: signInId };
    };
    const first = await signIn();
    const credentialId = first.forgeCredential;
    const checkReceipt = (operationId, action) => {
      const receipt = [...f.tables.authLinkEvents.values()].find(row => row.operationId === operationId);
      assert.deepEqual(JSON.parse(receipt.request), {
        hash: deviceHash(JSON.stringify({ action, credentialId })),
        result: { ended: action },
      });
      if (format === 'legacy')
        f.tables.authLinkEvents.set(receipt._id, {
          ...receipt,
          request: JSON.stringify({
            hash: deviceHash(JSON.stringify({ credentialId })),
            result: { ended: action },
          }),
        });
    };
    const signout = { credentialId, operationId: randomUUID() };
    await f.call('original sign-out', credentials.revoke, signout, first);
    checkReceipt(signout.operationId, 'signout');
    assert.equal(
      await f.call('exact sign-out', credentials.revoke, { ...signout, action: 'signout' }, first),
      null,
    );
    assert.equal(f.counts.at(-1).writes, 0);
    await assert.rejects(
      f.call('changed sign-out', credentials.revoke, { ...signout, action: 'remove' }, first),
      code('AUTH_OPERATION_CHANGED'),
    );
    assert.equal(f.counts.at(-1).writes, 0);

    const second = await signIn();
    const remove = { credentialId, operationId: randomUUID(), action: 'remove' };
    await f.call('original removal', credentials.revoke, remove, second);
    checkReceipt(remove.operationId, 'remove');
    const removed = [...f.tables.cliCredentials.values()][0];
    assert.equal(removed.deviceKey, undefined);
    assert.equal(await f.call('exact removal', credentials.revoke, remove, second), null);
    assert.equal(f.counts.at(-1).writes, 0);
    await assert.rejects(
      f.call(
        'changed removal',
        credentials.revoke,
        { credentialId, operationId: remove.operationId },
        second,
      ),
      code('AUTH_OPERATION_CHANGED'),
    );
    assert.equal(f.counts.at(-1).writes, 0);
    await assert.rejects(
      f.call('foreign removal replay', credentials.revoke, remove, 'other'),
      code('AUTH_REQUIRED'),
    );
    assert.equal(f.counts.at(-1).writes, 0);

    const fresh = { ...remove, operationId: randomUUID() };
    assert.equal(await f.call('removed CLI sign-in', credentials.revoke, fresh, second), null);
    assert.equal(f.counts.at(-1).writes, 0);
    assert.equal(await f.call('owner removes the already removed device', credentials.revoke, fresh), null);
    assert.equal(f.counts.at(-1).writes, 1);

    await signIn();
    await f.call('exact removal after fresh approval', credentials.revoke, remove, second);
    await f.call('owner retries removal after fresh approval', credentials.revoke, fresh);
    const current = [...f.tables.cliCredentials.values()][0];
    assert.equal(current.revoked, false);
    assert.equal(current.deviceKey, device.key);
  });
}

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

test('SI-01: silent renewal ends 30 days after the last sign-in ended and at twelve months despite daily renewal', async t => {
  storageClock(t);
  const f = fixture(t),
    device = key(),
    { flow } = await f.start(device);
  await f.approve(flow);
  await f.poll(flow);
  const row = [...f.tables.cliCredentials.values()][0];
  const day = 86400000;
  f.patch('cliCredentials', row._id, { expiresAt: Date.now() - 30 * day });
  assert.equal((await f.renew(device)).status, 'approval-expired');
  f.patch('cliCredentials', row._id, {
    expiresAt: Date.now() + day,
    deviceLastSeen: Date.now(),
    deviceApprovedAt: Date.UTC(2025, 10, 9),
  });
  assert.equal((await f.renew(device)).status, 'approval-expired');
  const again = await f.start(device);
  await f.approve(again.flow);
  await f.poll(again.flow);
  assert.equal((await f.renew(device)).status, 'approved');
});

test('SI-02: a remembered request cannot approve without the matching typed terminal code, including after sign-out', async t => {
  const f = fixture(t),
    device = key(),
    { flow } = await f.start(device);
  await f.approve(flow);
  const signed = await f.poll(flow);
  await f.call('signout', credentials.revoke, {
    credentialId: signed.credentialId,
    operationId: randomUUID(),
  });
  const next = await f.start(device);
  await assert.rejects(
    f.approve(next.flow, { code: undefined, requestId: next.input.operationId }),
    code('AUTH_REQUIRED'),
  );
  await assert.rejects(
    f.approve(next.flow, { code: 'WRONG-WRONG', requestId: next.input.operationId }),
    code('AUTH_REQUIRED'),
  );
  await f.approve(next.flow, { requestId: next.input.operationId });
  assert.equal((await f.poll(next.flow)).status, 'approved');
  const denied = await f.start(device);
  await actions.decide._handler(f.ctx, {
    requestId: denied.input.operationId,
    approve: false,
    operationId: randomUUID(),
  });
  assert.equal((await f.poll(denied.flow)).status, 'access_denied');
});

test('SI-07: removal clears public key and code, and that same key can be approved afresh', async t => {
  const f = fixture(t),
    device = key(),
    { flow } = await f.start(device);
  await f.approve(flow);
  const signed = await f.poll(flow);
  await f.call('remove', credentials.revoke, {
    credentialId: signed.credentialId,
    operationId: randomUUID(),
    action: 'remove',
  });
  const removed = [...f.tables.cliCredentials.values()][0];
  assert.equal(removed.deviceKey, undefined);
  assert.equal(removed.deviceCode, undefined);
  const next = await f.start(device);
  await f.approve(next.flow, { name: 'Approved again' });
  assert.equal((await f.poll(next.flow)).name, 'Approved again');
});

test('SI-01: every approval writes an account notice atomically, retries leave it alone, and a stale browser must prove a new key first', async t => {
  const f = fixture(t),
    device = key(),
    { flow } = await f.start(device);
  f.fresh(false);
  assert.equal((await f.inspect({ code: flow.user_code })).needsConfirmation, true);
  await assert.rejects(f.approve(flow), code('AUTH_REQUIRED'));
  assert.equal(f.tables.cliCredentials.size, 0);
  assert([...f.tables.users.values()].every(row => !row.deviceNotice));
  f.fresh(true);
  const operationId = randomUUID();
  await f.approve(flow, {}, operationId);
  const user = [...f.tables.users.values()].find(row => row.accountKey === 'owner');
  const notice = user.deviceNotice;
  assert.equal(notice.signInId, operationId);
  const row = [...f.tables.cliCredentials.values()][0];
  assert.equal(notice.credentialId, row.credentialId);
  assert.equal(typeof row.issuedAt, 'number');
  await f.approve(flow, {}, operationId);
  assert.deepEqual(f.tables.users.get(user._id).deviceNotice, notice);
});

test('SI-01: daily use cannot carry a twelve-month device approval beyond its maximum', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2025, 0, 1) });
  const f = fixture(t),
    device = key(),
    { flow } = await f.start(device);
  await f.approve(flow);
  await f.poll(flow);
  let latest;
  for (let day = 1; day < 365; day++) {
    t.mock.timers.tick(86400000);
    latest = await f.renew(device);
    assert.equal(latest.status, 'approved');
  }
  t.mock.timers.tick(86400000 - 10000);
  const action = {
    auth: {
      getUserIdentity: async () => ({
        subject: 'owner',
        forgeCredential: device.id,
        forgeSignIn: latest.signInId,
      }),
    },
    runQuery: (_ref, args) => f.call('cached action credential', modules.deviceStore.authorize, args),
  };
  await guard(action, 'cli');
  t.mock.timers.tick(20000);
  await assert.rejects(guard(action, 'cli'), code('AUTH_REVOKED'));
  assert.equal((await f.renew(device)).status, 'approval-expired');
});

test('SI-07: unknown-key renewals share the existing start budget; retries of a known renewal do not spend it again', async t => {
  const f = fixture(t),
    device = key(),
    { flow } = await f.start(device);
  await f.approve(flow);
  await f.poll(flow);
  const operationId = randomUUID(),
    at = Date.now();
  const before = f.tables.deviceAttempts.size;
  await f.renew(device, operationId, at);
  const count = [...f.tables.deviceAttempts.values()].find(row => row.owner === 'system:device-start').count;
  await f.renew(device, operationId, at);
  assert.equal(
    [...f.tables.deviceAttempts.values()].find(row => row.owner === 'system:device-start').count,
    count,
  );
  assert.equal(f.tables.deviceAttempts.size, before);
  const unknown = key();
  for (let i = count; i < 120; i++) assert.equal((await f.renew(unknown)).status, 'unapproved');
  assert.equal((await f.renew(unknown)).status, 'slow_down');
  assert.equal((await f.start(key())).flow.error, 'slow_down');
});

test('SI-07: legacy keyless credentials cannot accept device settings, and rollout-off login ignores a client credential id', async t => {
  const f = fixture(t),
    credentialId = randomUUID();
  f.insert('cliCredentials', {
    owner: 'owner',
    credentialId,
    name: 'Legacy',
    scope: 'cli',
    tokenHash: 'synthetic',
    issuedAt: 1,
    expiresAt: Date.now() + 60000,
    revoked: false,
  });
  await assert.rejects(
    f.call('legacy settings', credentials.rename, {
      credentialId,
      name: 'Legacy',
      operationId: randomUUID(),
      settings: { source: 'read', projects: { kind: 'all' } },
    }),
    code('AUTH_SCOPE_DENIED'),
  );
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policyPreset('trusted') });
  const device = key(),
    { flow } = await f.start(device),
    selectedId = device.id;
  await f.approve(flow);
  const signed = await f.poll(flow);
  assert.notEqual(signed.credentialId, selectedId);
  assert.equal(signed.deviceId, undefined);
});

test('SI-07: a lost renewal preparation reply reuses its budget reservation and pinned issue time', async t => {
  const f = fixture(t),
    device = key(),
    { flow } = await f.start(device);
  await f.approve(flow);
  await f.poll(flow);
  const operationId = randomUUID(),
    signed = proof(device, 'renew', operationId);
  const input = {
    credentialId: device.id,
    key: device.key,
    operationId,
    at: signed.at,
    proofHash: deviceHash(signed.proof),
  };
  const first = JSON.parse(await f.call('first preparation', modules.deviceStableStore.renewal, input));
  const count = [...f.tables.deviceAttempts.values()].find(row => row.owner === 'system:device-start').count;
  const repeated = JSON.parse(await f.call('lost reply retry', modules.deviceStableStore.renewal, input));
  assert.deepEqual(repeated, first);
  assert.equal(
    [...f.tables.deviceAttempts.values()].find(row => row.owner === 'system:device-start').count,
    count,
  );
  const result = JSON.parse(await stable.renew._handler(f.ctx, { origin, operationId, device: signed }));
  assert.equal(result.status, 'approved');
  assert.equal(
    [...f.tables.deviceAttempts.values()].find(row => row.owner === 'system:device-start').count,
    count,
  );
});

test('SI-01: sign out everywhere ends every pre-start device on every page, even one renewed between pages, and keeps a sign-in issued after the start in the same millisecond', async t => {
  const f = fixture(t),
    started = Date.now();
  const end = await import(moduleUrl('../convex/deviceEndAll.ts'));
  const settings = { source: 'write', projects: { kind: 'all' } };
  const synthetic = () =>
    f.insert('cliCredentials', {
      owner: 'owner',
      credentialId: randomUUID(),
      name: 'Synthetic',
      scope: 'cli',
      issuedAt: started - 1000,
      expiresAt: started + 600000,
      tokenHash: 'synthetic',
      revoked: false,
      settings,
      deviceLastSeen: started - 1000,
    });
  for (let i = 0; i < 150; i++) synthetic();
  // A real pre-start device on the second page.
  const used = key(),
    usedFlow = (await f.start(used)).flow;
  await f.approve(usedFlow);
  await f.poll(usedFlow);
  for (let i = 0; i < 50; i++) synthetic();
  const usedRow = () => [...f.tables.cliCredentials.values()].find(row => row.credentialId === used.id);
  const owner = [...f.tables.users.values()].find(row => row.accountKey === 'owner');
  // The start runs at `started`; the clock is then moved, never used to order the sign-ins.
  let clock = started;
  t.mock.method(Date, 'now', () => clock);
  await f.call(
    'end all start',
    {
      _handler: async ctx => {
        await end.endAccountDevices(ctx, 'owner');
        return null;
      },
    },
    {},
  );
  const startCall = f.counts.at(-1);
  // The start's only extra write is the account's next epoch.
  assert.equal(startCall.writes, 101);
  assert.equal([...f.tables.users.values()].find(row => row._id === owner._id).deviceSignOutEpoch, 1);
  // Used between pages, a minute later: a renewal moves issuedAt and deviceLastSeen past the start, not the epoch.
  clock = started + 60_000;
  assert.equal((await f.renew(used)).status, 'approved');
  assert(usedRow().issuedAt > started && usedRow().deviceLastSeen > started);
  assert.equal(usedRow().revoked, false);
  assert.equal(usedRow().signOutEpoch, 0);
  // Signed in after the start, in the start's own millisecond.
  clock = started;
  const later = key(),
    laterFlow = (await f.start(later)).flow;
  await f.approve(laterFlow);
  const laterSignIn = await f.poll(laterFlow);
  assert.equal(laterSignIn.status, 'approved');
  assert.equal(
    [...f.tables.cliCredentials.values()].find(row => row.credentialId === later.id).signOutEpoch,
    1,
  );
  const pages = [startCall];
  for (let i = 0; i < f.scheduled.length; i++) {
    if (getFunctionName(f.scheduled[i].fn) !== 'deviceEndAll:next') continue;
    await f.call('continue device sign-out', end.next, f.scheduled[i].args);
    pages.push(f.counts.at(-1));
  }
  assert.equal(pages.length, 3);
  for (const page of pages) assert(page.documents <= 101 && page.writes <= 101);
  const rows = [...f.tables.cliCredentials.values()];
  assert.equal(rows.length, 202);
  assert.equal(usedRow().revoked, true);
  assert.equal(rows.find(row => row.credentialId === later.id).revoked, false);
  assert.equal(rows.filter(row => row.revoked).length, 201);
  for (const row of rows.filter(row => row.name === 'Synthetic')) assert.deepEqual(row.settings, settings);
  assert.equal((await f.renew(used)).status, 'signed-out');
  assert.equal((await f.renew(later)).status, 'approved');
});

test('SI-01: a keyless sign-in approved before sign out everywhere is refused at issue, even after every page ran', async t => {
  const f = fixture(t);
  const end = await import(moduleUrl('../convex/deviceEndAll.ts'));
  const issue = (credentialId, signOutEpoch) =>
    f.call('legacy issue', modules.deviceStore.issue, {
      owner: 'owner',
      name: 'Keyless',
      scope: 'cli',
      credentialId,
      issuedAt: 1_000,
      expiresAt: 4_102_444_800_000,
      tokenHash: 'synthetic',
      revoked: false,
      ...(signOutEpoch === undefined ? {} : { signOutEpoch }),
    });
  await f.call(
    'end all',
    {
      _handler: async ctx => {
        await end.endAccountDevices(ctx, 'owner');
        return null;
      },
    },
    {},
  );
  await assert.rejects(issue(randomUUID(), 0), code('AUTH_REVOKED'));
  await assert.rejects(issue(randomUUID()), code('AUTH_REVOKED'));
  const issued = await issue(randomUUID(), 1);
  assert.equal(issued.revoked, false);
  assert.equal(issued.signOutEpoch, 1);
});

test('SI-07: renewal calls and indexed I/O stay constant at current and doubled device scale', async t => {
  for (const total of [1200, 2400]) {
    const f = fixture(t),
      device = key(),
      { flow } = await f.start(device);
    await f.approve(flow);
    await f.poll(flow);
    for (let i = 1; i < total; i++)
      f.insert('cliCredentials', {
        owner: 'owner',
        credentialId: randomUUID(),
        name: 'Synthetic',
        scope: 'cli',
        issuedAt: 1,
        expiresAt: Date.now() + 60000,
        tokenHash: 'synthetic',
        revoked: false,
      });
    const start = f.counts.length;
    await f.renew(device);
    const calls = f.counts.slice(start),
      docs = calls.reduce((n, c) => n + c.documents, 0),
      writes = calls.reduce((n, c) => n + c.writes, 0);
    assert.equal(calls.length, 2);
    assert.equal(docs, 7);
    assert.equal(writes, 4);
    console.log(
      JSON.stringify({
        renewalDevices: total,
        internalCalls: calls.length,
        documents: docs,
        writes,
        readBytes: calls.reduce((n, c) => n + c.readBytes, 0),
        writeBytes: calls.reduce((n, c) => n + c.writeBytes, 0),
      }),
    );
  }
});

test('SI-01 review: renewal at month 11.9 cannot authorize Git after the twelve-month approval end', async t => {
  let now = Date.UTC(2025, 0, 1);
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t),
    device = key(),
    { flow } = await f.start(device);
  await f.approve(flow);
  await f.poll(flow);
  const row = [...f.tables.cliCredentials.values()][0];
  const end = Date.UTC(2026, 0, 1);
  now = Date.UTC(2025, 11, 29);
  f.patch('cliCredentials', row._id, { expiresAt: now - 1, deviceLastSeen: now });
  const renewed = await f.renew(device);
  assert.equal(renewed.status, 'approved');
  const git = await import(moduleUrl('../convex/gitServeStore.ts'));
  const input = {
    projectId: 'missing-project',
    credential: { credentialId: renewed.credentialId, tokenHash: deviceHash(renewed.token) },
  };
  assert.deepEqual(await f.call('Git before approval end', git.load, input), {
    status: 'not-found',
    signedIn: true,
  });
  now = end;
  assert.deepEqual(await f.call('Git at approval end', git.load, input), { status: 'bad-credential' });
  assert.equal(renewed.expiresAt, end);
  assert.equal(f.tables.cliCredentials.get(row._id).expiresAt, end);
  assert.equal(JSON.parse(Buffer.from(renewed.token.split('.')[1], 'base64url')).exp, end / 1000);
  // Older stored tokens may still carry a later expiry; the Git row check also enforces approval age.
  f.patch('cliCredentials', row._id, { expiresAt: end + 30 * 86400000 });
  assert.deepEqual(
    await f.call('older Git row at approval end', git.load, {
      projectId: 'missing-project',
      sessionCredentialId: renewed.credentialId,
      sessionSignIn: renewed.signInId,
    }),
    { status: 'bad-credential' },
  );
});

test('SI-01 review: a remembered browser approval near month twelve caps its stored, returned and signed expiry', async t => {
  let now = Date.UTC(2025, 0, 1);
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t),
    device = key(),
    { flow } = await f.start(device);
  await f.approve(flow);
  await f.poll(flow);
  const row = [...f.tables.cliCredentials.values()][0];
  const end = Date.UTC(2026, 0, 1);
  now = Date.UTC(2025, 11, 29);
  f.patch('cliCredentials', row._id, { expiresAt: now - 1, deviceLastSeen: now });
  f.fresh(true);
  const again = await f.start(device);
  await f.approve(again.flow);
  const signed = await f.poll(again.flow);
  assert.equal(f.tables.cliCredentials.get(row._id).deviceApprovedAt, Date.UTC(2025, 0, 1));
  assert.equal(f.tables.cliCredentials.get(row._id).expiresAt, end);
  assert.equal(signed.expiresAt, end);
  assert.equal(JSON.parse(Buffer.from(signed.token.split('.')[1], 'base64url')).exp, end / 1000);
});

test('df06081d: approving a folder grant starts its clock, re-approval in the browser gives it again, and settings without folders end it', async t => {
  storageClock(t);
  const now = Date.UTC(2026, 10, 10, 12);
  const f = fixture(t),
    device = key(),
    { flow } = await f.start(device);
  const settings = {
    source: 'write',
    projects: { kind: 'project', projectId: f.projectId },
    paths: ['docs/'],
  };
  await assert.rejects(
    f.approve(flow, { name: 'Agent', settings: { ...settings, paths: ['../outside'] } }),
    code('BAD_ARGUMENT'),
  );
  await f.approve(flow, { name: 'Agent', settings });
  const signed = await f.poll(flow);
  const row = () => [...f.tables.cliCredentials.values()][0];
  assert.equal(row().grant.at, row().grant.usedAt);
  const user = { subject: 'owner', forgeCredential: signed.credentialId, forgeSignIn: signed.signInId };
  const status = await f.call('status', credentials.status, {}, user);
  assert.equal(
    status.device.grantEndsAt,
    row().grant.usedAt + 7 * 86400000,
    'nforge auth status shows the end',
  );
  assert.deepEqual(status.device.settings.paths, ['docs/']);
  // Ended: 31 days after it was given. A write is refused; re-login approved in the browser gives it again.
  f.patch('cliCredentials', row()._id, {
    grant: { at: now - 31 * 86400000, usedAt: now - 3600000 },
  });
  await assert.rejects(
    f.call('ended write', { _handler: ctx => authority.activeProject(ctx, f.projectId, 'owner') }, {}, user),
    code('AUTH_EXPIRED'),
  );
  const next = await f.start(device);
  await f.approve(next.flow);
  const again = await f.poll(next.flow);
  assert.equal(row().grant.at, now, 'browser re-approval gives the grant again');
  await f.call(
    'renewed write',
    { _handler: ctx => authority.activeProject(ctx, f.projectId, 'owner') },
    {},
    { subject: 'owner', forgeCredential: again.credentialId, forgeSignIn: again.signInId },
  );
  await assert.rejects(
    f.call('bad folders', credentials.rename, {
      credentialId: again.credentialId,
      name: 'Agent',
      settings: { ...settings, paths: [] },
      operationId: randomUUID(),
    }),
    code('BAD_ARGUMENT'),
  );
  await f.call('whole project', credentials.rename, {
    credentialId: again.credentialId,
    name: 'Agent',
    settings: { source: 'write', projects: { kind: 'project', projectId: f.projectId } },
    operationId: randomUUID(),
  });
  assert.equal(row().grant, undefined);
  assert.equal(row().settings.paths, undefined);
});

test('df06081d: a stale browser is offered the GitHub check only when its account has a linked GitHub identity', async t => {
  const f = fixture(t),
    device = key(),
    { flow } = await f.start(device);
  f.fresh(false);
  const owner = [...f.tables.users.entries()].find(([, row]) => row.accountKey === 'owner')[0];
  f.authUser(owner);
  assert.equal(
    (await f.inspect({ code: flow.user_code })).github,
    false,
    'no linked GitHub: no GitHub button',
  );
  f.patch('users', owner, { githubId: '424242' });
  assert.equal((await f.inspect({ code: flow.user_code })).github, true);
  f.patch('users', owner, { githubConflict: true });
  assert.equal((await f.inspect({ code: flow.user_code })).github, false, 'a conflicted link is not offered');
  f.fresh(true);
  assert.equal(
    (await f.inspect({ code: flow.user_code })).github,
    undefined,
    'a fresh browser needs no check and reads nothing more',
  );
});
