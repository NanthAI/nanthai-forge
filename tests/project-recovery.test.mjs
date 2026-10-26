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
  const connect = async (selection, overrides = {}) =>
    recoveryConnectionSchema.parse(
      JSON.parse(
        await backend.reconnect._handler(s.ctx, {
          ...scope,
          selection: JSON.stringify(selection),
          requestHash: 'c'.repeat(64),
          role: 'owner',
          ...overrides,
        }),
      ),
    );
  return { ...s, ownerId, scope, prepare, connect };
}

test('reconnect pins the journal head, records a retry receipt and preserves project identity/authority/source', async t => {
  const f = fixture(t),
    original = structuredClone(f.tables.hostedProjects.get('project'));
  const selected = (await f.prepare()).selection;
  assert.equal(selected.revision, 7, 'revision comes from current Work head, not stale project field');
  const receipt = await f.connect(selected);
  assert.equal(receipt.binding.operationId, f.ownerId);
  assert.equal(receipt.binding.projectUrl, 'https://example.invalid/synthetic/restore');
  assert.deepEqual(f.tables.hostedProjects.get('project'), original);
  f.tables.projectWorkHeads.get('head').revision++;
  assert.deepEqual(await f.connect(selected), receipt, 'unknown reconnect replays exact original receipt');
  assert.deepEqual((await f.prepare()).receipt, receipt);
  assert.equal(f.tables.projectRecoveryConnections.size, 1);
  await assert.rejects(
    f.connect(selected, { role: 'client' }),
    e => e.data.code === 'WORK_OPERATION_CHANGED',
  );
  await assert.rejects(
    f.connect(selected, { requestHash: 'd'.repeat(64) }),
    e => e.data.code === 'WORK_OPERATION_CHANGED',
  );
});

for (const change of ['journal', 'checkpoint', 'authority', 'owner'])
  test(`concurrent ${change} change fails existing-pin CAS before reconnect`, async t => {
    const f = fixture(t),
      selected = (await f.prepare()).selection;
    if (change === 'journal') f.tables.projectWorkHeads.get('head').revision++;
    if (change === 'checkpoint') f.tables.projectBackups.get('backup').digest = 'd'.repeat(64);
    if (change === 'authority')
      f.tables.hostedProjects.get('project').sourceAuthority = { mode: 'native-owner', epoch: 1 };
    if (change === 'owner') f.tables.hostedProjects.get('project').key = randomUUID();
    await assert.rejects(f.connect(selected), e => e.data.code === 'WORK_STALE');
    assert.equal(f.tables.projectRecoveryConnections.size, 0);
  });

test('current owner authority is required for fresh and cached reconnect; read/contributor access does not confer ownership', async t => {
  const f = fixture(t),
    selected = (await f.prepare()).selection;
  await f.connect(selected);
  for (const actor of ['reader', 'contributor', null]) {
    f.caller(actor);
    await assert.rejects(f.prepare(), e => e.data.code === 'PROJECT_UNAVAILABLE');
    await assert.rejects(f.connect(selected), e => e.data.code === 'PROJECT_UNAVAILABLE');
  }
  f.caller('owner');
  f.tables.hostedProjects.get('project').removal = 'trash';
  await assert.rejects(f.prepare(), e => e.data.code === 'PROJECT_UNAVAILABLE');
});

test('revoked CLI credential cannot retrieve a cached reconnect receipt', async t => {
  const f = fixture(t),
    selected = (await f.prepare()).selection;
  await f.connect(selected);
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
  await assert.rejects(f.connect(selected), e => e.data.code === 'AUTH_REVOKED');
});

test('client reconnect records the requested local role without leases or canonical source changes', async t => {
  const f = fixture(t),
    selected = (await f.prepare()).selection;
  const before = structuredClone(f.tables.hostedProjects.get('project'));
  const result = await f.connect(selected, { role: 'client' });
  assert.equal(result.role, 'client');
  assert.equal(result.selection.authority.epoch, 0);
  assert.deepEqual(f.tables.hostedProjects.get('project'), before);
});

test('improving history coverage does not introduce a reconnect gate', async t => {
  const f = fixture(t);
  f.tables.projectBackups.get('backup').historyBackfilling = true;
  const selected = (await f.prepare()).selection;
  assert.equal(selected.completeHistory, 'incomplete');
  f.tables.projectBackups.get('backup').historyBackfilling = false;
  const result = await f.connect(selected);
  assert.equal(result.selection.completeHistory, 'complete');
});

for (const receipt of [false, true])
  test(`server authority never returns or replays native reconnect authority (cached=${receipt})`, async t => {
    const f = fixture(t),
      selected = (await f.prepare()).selection;
    if (receipt) await f.connect(selected);
    f.tables.hostedProjects.get('project').sourceAuthority = { mode: 'server', epoch: 1 };
    await assert.rejects(f.connect(selected), e => e.data.code === 'SOURCE_AUTHORITY_STALE');
    assert.equal(f.tables.projectRecoveryConnections.size, receipt ? 1 : 0);
  });

test('server recovery ignores old native reconnect receipts and selects current hosted authority', async t => {
  const f = fixture(t),
    selected = (await f.prepare()).selection;
  await f.connect(selected);
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

test('native reconnect receipt replay remains available without rediscovering a checkpoint', async t => {
  const f = fixture(t),
    selected = (await f.prepare()).selection;
  const original = await f.connect(selected);
  f.tables.projectBackups.delete('backup');
  const replay = await f.prepare();
  assert.equal(replay.selection, null);
  assert.deepEqual(replay.receipt, original);
  assert.deepEqual(replay.authority, { mode: 'native-owner', epoch: 0 });
});
