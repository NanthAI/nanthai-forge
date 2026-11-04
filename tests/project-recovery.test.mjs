// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { recoveryPreparationSchema, recoveryConnectionSchema } from '../dist/recovery-protocol.js';
const backend = await import(moduleUrl('../convex/projectRecovery.ts'));

function fixture(t) {
  const s = state([]),
    ownerId = randomUUID(),
    operationId = randomUUID();
  s.tables.forgeAccounts.set('account', { _id: 'account', owner: 'owner', handle: 'synthetic' });
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    owner: 'owner',
    key: ownerId,
    name: 'Synthetic',
    slug: 'restore',
    hostingRequest: 'existing',
    currentBackup: 'backup',
    revision: 1,
    work: { backupId: 'backup', initialRevision: 4, revision: 4 },
  });
  s.tables.projectBackups.set('backup', {
    _id: 'backup',
    projectId: 'project',
    status: 'stored',
    transport: 'objects',
    digest: 'a'.repeat(64),
    size: 123,
    validatedClosure: 1,
    preview: { format: 'native', manifestDigest: 'b'.repeat(64) },
  });
  s.tables.projectWorkHeads.set('head', {
    _id: 'head',
    projectId: 'project',
    backupId: 'backup',
    revision: 7,
  });
  const oldWeb = process.env.FORGE_WEB_URL;
  process.env.FORGE_WEB_URL = 'https://example.invalid';
  t.after(() => {
    if (oldWeb === undefined) delete process.env.FORGE_WEB_URL;
    else process.env.FORGE_WEB_URL = oldWeb;
  });
  const scope = { projectId: 'project', operationId };
  const prepare = async () =>
    recoveryPreparationSchema.parse(JSON.parse(await backend.prepare._handler(s.ctx, scope)));
  const seedConnection = selection => {
    const receipt = recoveryConnectionSchema.parse({
      operationId,
      requestHash: 'c'.repeat(64),
      role: 'owner',
      selection,
      binding: {
        projectId: 'project',
        operationId: ownerId,
        projectUrl: 'https://example.invalid/synthetic/restore',
        name: 'Synthetic',
        visibility: 'private',
        backupId: 'backup',
      },
    });
    s.tables.projectRecoveryConnections.set('old', {
      projectId: 'project',
      operationId,
      receipt: JSON.stringify(receipt),
    });
    return receipt;
  };
  return { ...s, ownerId, scope, prepare, seedConnection };
}

test('prepare reads the current Work head without writing or changing project authority', async t => {
  const f = fixture(t),
    before = structuredClone(f.tables);
  const result = await f.prepare();
  assert.equal(result.selection.revision, 7);
  assert.equal(result.receipt, null);
  assert.deepEqual(f.tables, before);
});

test('current owner authority remains required for fresh and historical recovery reads', async t => {
  const f = fixture(t);
  f.seedConnection((await f.prepare()).selection);
  for (const actor of ['reader', 'contributor', null]) {
    f.caller(actor);
    await assert.rejects(f.prepare(), e => e.data.code === 'PROJECT_UNAVAILABLE');
  }
  f.caller('owner');
  f.tables.hostedProjects.get('project').removal = 'trash';
  await assert.rejects(f.prepare(), e => e.data.code === 'PROJECT_UNAVAILABLE');
});

test('revoked CLI credentials cannot read historical recovery receipts', async t => {
  const f = fixture(t);
  f.seedConnection((await f.prepare()).selection);
  const credentialId = randomUUID();
  f.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: credentialId });
  f.tables.cliCredentials.set('device', {
    credentialId,
    owner: 'owner',
    scope: 'cli',
    revoked: true,
    expiresAt: Date.now() + 10000,
  });
  await assert.rejects(f.prepare(), e => e.data.code === 'AUTH_REVOKED');
});

test('retired reconnect address returns the upgrade error for every role without DB I/O', async t => {
  const f = fixture(t),
    before = structuredClone(f.tables);
  const ctx = {
    auth: { getUserIdentity: async () => null },
    db: new Proxy(
      {},
      {
        get() {
          assert.fail('Retired reconnect accessed the database');
        },
      },
    ),
  };
  for (const role of ['owner', 'client'])
    await assert.rejects(
      backend.reconnect._handler(ctx, { ...f.scope, role, selection: '{}', requestHash: 'c'.repeat(64) }),
      e => e.data.code === 'CLI_UPGRADE_REQUIRED',
    );
  assert.deepEqual(f.tables, before);
});

test('server recovery ignores old native reconnect receipts and selects current hosted authority', async t => {
  const f = fixture(t),
    selected = (await f.prepare()).selection;
  f.seedConnection(selected);
  const authority = { mode: 'server', epoch: 1 };
  f.tables.hostedProjects.get('project').sourceAuthority = authority;
  f.tables.projectHostedChannels ??= new Map();
  f.tables.projectHostedChannels.set('channel', {
    _id: 'channel',
    projectId: 'project',
    name: 'main',
    operationId: randomUUID(),
    selection: JSON.stringify({
      schema: 2,
      projectId: 'project',
      snapshotId: 'seed',
      sourceRevision: 0,
      authority,
      channel: 'main',
      head: 'c'.repeat(64),
      receipt: { id: randomUUID(), kind: 'native', previousHead: null, previousReceiptId: null },
    }),
  });
  const before = structuredClone(f.tables);
  const result = await f.prepare();
  assert.equal(result.selection.authority.mode, 'server');
  assert.equal(result.receipt, null);
  assert.deepEqual(f.tables, before);
});

test('historical native receipt stays readable without rediscovering a checkpoint', async t => {
  const f = fixture(t),
    selected = (await f.prepare()).selection;
  const original = f.seedConnection(selected);
  f.tables.projectBackups.delete('backup');
  const replay = await f.prepare();
  assert.equal(replay.selection, null);
  assert.deepEqual(replay.receipt, original);
  assert.deepEqual(replay.authority, { mode: 'native-owner', epoch: 0 });
});
