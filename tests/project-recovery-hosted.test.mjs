// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { recoveryTables, hostedRecoveryPageSchema } from '../dist/recovery-hosted-protocol.js';
const recovery = await import(moduleUrl('../convex/projectRecovery.ts'));
const hosted = await import(moduleUrl('../convex/projectRecoveryHosted.ts'));
function fixture() {
  const f = state([], { keysetPaging: true });
  for (const table of [...recoveryTables, 'projectHostedChannels']) f.tables[table] ??= new Map();
  f.tables.hostedProjects.set('project', {
    _id: 'project',
    owner: 'owner',
    key: randomUUID(),
    name: 'Synthetic',
    currentBackup: 'backup',
    sourceAuthority: { mode: 'server', epoch: 3 },
    work: { backupId: 'backup', initialRevision: 1, revision: 1 },
  });
  f.tables.projectBackups.set('backup', {
    _id: 'backup',
    projectId: 'project',
    status: 'stored',
    transport: 'objects',
    digest: 'a'.repeat(64),
    size: 100,
    validatedClosure: 1,
    preview: { format: 'native', manifestDigest: 'b'.repeat(64) },
  });
  const main = {
    schema: 2,
    projectId: 'project',
    channel: 'main',
    head: 'c'.repeat(64),
    snapshotId: 'seed',
    sourceRevision: 0,
    authority: { mode: 'server', epoch: 3 },
    receipt: { id: randomUUID(), kind: 'native', previousHead: null, previousReceiptId: null },
  };
  f.tables.projectHostedChannels.set('channel', {
    _id: 'channel',
    projectId: 'project',
    name: 'main',
    operationId: randomUUID(),
    selection: JSON.stringify(main),
  });
  const prepare = async () =>
    JSON.parse(await recovery.prepare._handler(f.ctx, { projectId: 'project', operationId: randomUUID() }));
  return {
    ...f,
    main,
    prepare,
    page: async (selection, table, cursor = null, projectId = 'project') =>
      hostedRecoveryPageSchema.parse(
        JSON.parse(
          await hosted.page._handler(f.ctx, {
            projectId,
            selection: JSON.stringify(selection),
            table,
            cursor,
          }),
        ),
      ),
  };
}

test('all hosted recovery tables use project-prefixed indexes and bounded resumable pages, with no hosted writes', async () => {
  const f = fixture(),
    { selection } = await f.prepare();
  assert.deepEqual(selection.hostedMain, f.main);
  for (const table of recoveryTables) {
    for (let i = 0; i < 133; i++)
      f.tables[table].set(`${table}-${i}`, {
        _id: `${table}-${i}`,
        _creationTime: i,
        projectId: 'project',
        value: `exact-${i}`,
      });
    f.tables[table].set('foreign', {
      _id: 'foreign',
      _creationTime: 0,
      projectId: 'other',
      value: 'private',
    });
  }
  const before = structuredClone(f.tables);
  for (const table of recoveryTables) {
    let cursor = null,
      count = 0;
    do {
      const result = await f.page(selection, table, cursor);
      assert(result.rows.length <= 64);
      assert(result.rows.every(text => JSON.parse(text).projectId === 'project'));
      count += result.rows.length;
      cursor = result.cursor;
    } while (cursor);
    assert.equal(count, 133, table);
  }
  assert.deepEqual(f.tables, before, 'paging does not mutate hosted data');
});

for (const actor of [null, 'reader', 'contributor'])
  test(`recovery pages require current owner authority (${actor})`, async () => {
    const f = fixture(),
      { selection } = await f.prepare();
    f.caller(actor);
    await assert.rejects(f.page(selection, recoveryTables[0]), e => e.data.code === 'PROJECT_UNAVAILABLE');
  });

for (const change of ['main', 'authority', 'journal', 'project'])
  test(`resumed pages reject changed ${change} pins`, async () => {
    const f = fixture(),
      { selection } = await f.prepare();
    if (change === 'main') {
      f.main.head = 'd'.repeat(64);
      f.tables.projectHostedChannels.get('channel').selection = JSON.stringify(f.main);
    }
    if (change === 'authority') f.tables.hostedProjects.get('project').sourceAuthority.epoch++;
    if (change === 'journal') f.tables.hostedProjects.get('project').work.revision++;
    if (change === 'project') selection.projectId = 'other';
    await assert.rejects(
      f.page(selection, 'projectHostedAcceptances'),
      e => e.data.code === (change === 'authority' ? 'SOURCE_AUTHORITY_CHANGED' : 'WORK_STALE'),
    );
  });

test('revocation is enforced again on every continued page', async () => {
  const f = fixture(),
    { selection } = await f.prepare();
  await f.page(selection, 'projectHostedAcceptances');
  const credentialId = randomUUID();
  f.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: credentialId });
  f.tables.cliCredentials.set('device', {
    credentialId,
    owner: 'owner',
    scope: 'cli',
    revoked: true,
    expiresAt: Date.now() + 10000,
  });
  await assert.rejects(f.page(selection, 'projectHostedAcceptances'), e => e.data.code === 'AUTH_REVOKED');
});
