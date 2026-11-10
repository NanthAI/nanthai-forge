// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { settleR2Purge } from './default-r2.mjs';
const lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts'));
const { purgeSettleMs } = await import(moduleUrl('../convex/projectRetention.ts'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
/** A permanently deleted project whose purge is still waiting for issued uploads to expire. */
async function deletingProject() {
  const s = state([]),
    nonce = randomUUID(),
    bytes = 'original private bytes';
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: randomUUID(),
    name: 'Remove',
    currentBackup: null,
    revision: 0,
  });
  s.tables.projectObjects.set('object', {
    _id: 'object',
    _creationTime: 1,
    projectId: 'project',
    nonce,
    digest: hash(bytes),
    size: bytes.length,
    removed: false,
  });
  for (const table of ['projectCoordinationSessions', 'projectCoordinationEvents']) {
    for (let i = 0; i < 55; i++)
      s.tables[table].set(`${table}-${i}`, { _id: `${table}-${i}`, projectId: 'project', sessionId: `${i}` });
    s.tables[table].set('foreign', { _id: 'foreign', projectId: 'other', sessionId: 'keep' });
  }
  await lifecycle.permanentlyDelete._handler(s.ctx, {
    projectId: 'project',
    operationId: randomUUID(),
    expectedRevision: 0,
    confirm: 'Remove',
  });
  // The purge first waits for every upload URL issued before deletion to expire.
  await lifecycle.purge._handler(s.ctx, { projectId: 'project' });
  assert.equal(s.tables.hostedProjects.get('project').removal, 'deleting');
  assert.ok(s.tables.projectObjects.has('object'), 'nothing is purged before uploads settle');
  return { ...s, bytes, contentType: `application/x-forge-object-${nonce}` };
}
async function purge(s) {
  const project = s.tables.hostedProjects.get('project');
  project.removedAt -= purgeSettleMs;
  for (let i = 0; i < 40 && project.removal !== 'deleted'; i++) {
    settleR2Purge(s.tables.hostedProjects.get('project'));
    await lifecycle.purge._handler(s.ctx, { projectId: 'project' });
  }
  assert.equal(s.tables.hostedProjects.get('project').removal, 'deleted');
  for (const table of ['projectCoordinationSessions', 'projectCoordinationEvents'])
    assert.deepEqual([...s.tables[table].keys()], ['foreign']);
  assert.deepEqual(
    [...s.tables.projectObjects.values()].filter(row => row.projectId === 'project'),
    [],
    'object receipts are purged too',
  );
}
test('nonce-bound uploads that finish during the settle wait are removed by the purge itself', async () => {
  const s = await deletingProject();
  const late = await s.ctx.storage.store(new Blob([s.bytes], { type: s.contentType }));
  const later = await s.ctx.storage.store(new Blob([s.bytes], { type: s.contentType }));
  await purge(s);
  assert.equal(s.files.has(late), false);
  assert.equal(s.files.has(later), false);
});
test('the purge keeps foreign, differently bound and referenced content', async () => {
  const s = await deletingProject();
  const late = await s.ctx.storage.store(new Blob([s.bytes], { type: s.contentType }));
  const referenced = await s.ctx.storage.store(new Blob([s.bytes], { type: s.contentType }));
  s.tables.projectBackups.set('foreign-backup', {
    _id: 'foreign-backup',
    _creationTime: 1,
    projectId: 'other',
    storageId: referenced,
  });
  const changed = await s.ctx.storage.store(new Blob(['different bytes'], { type: s.contentType }));
  const foreign = await s.ctx.storage.store(
    new Blob([s.bytes], { type: 'application/x-forge-object-other-nonce' }),
  );
  s.tables.projectObjects.set('other-object', {
    _id: 'other-object',
    _creationTime: 1,
    projectId: 'other',
    nonce: 'other-nonce',
    digest: hash(s.bytes),
    size: s.bytes.length,
    removed: true,
  });
  await purge(s);
  assert.ok(s.tables.projectObjects.has('other-object'));
  assert.equal(s.files.has(late), false);
  for (const id of [referenced, changed, foreign]) assert.equal(s.files.has(id), true);
});

test('compacted object descriptors retain nonce attribution for late legacy uploads without deleting foreign or changed bytes', async () => {
  const s = await deletingProject();
  const original = s.tables.projectObjects.get('object');
  await s.ctx.db.insert('projectObjectReceipts', {
    projectId: 'project',
    key: original._id,
    value: original.digest,
    nonce: original.nonce,
    size: original.size,
  });
  s.tables.projectObjects.delete('object');
  const late = await s.ctx.storage.store(new Blob([s.bytes], { type: s.contentType }));
  const changed = await s.ctx.storage.store(new Blob(['different bytes'], { type: s.contentType }));
  const referenced = await s.ctx.storage.store(new Blob([s.bytes], { type: s.contentType }));
  s.tables.projectBackups.set('foreign-backup', {
    _id: 'foreign-backup',
    _creationTime: 1,
    projectId: 'other',
    storageId: referenced,
  });
  const foreign = await s.ctx.storage.store(
    new Blob([s.bytes], { type: 'application/x-forge-object-foreign' }),
  );
  await purge(s);
  assert.equal(s.files.has(late), false, 'migration retains ownership of the original issued upload');
  for (const id of [changed, referenced, foreign]) assert.equal(s.files.has(id), true);
  assert.equal(s.tables.projectObjectReceipts.size, 0, 'project deletion also purges compact receipts');
});
