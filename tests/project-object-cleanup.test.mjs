// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { settleR2Purge } from './default-r2.mjs';
const lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function removedProject() {
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
  });
  for (let i = 0; i < 20 && s.tables.hostedProjects.get('project').removal !== 'deleted'; i++) {
    settleR2Purge(s.tables.hostedProjects.get('project'));
    await lifecycle.purge._handler(s.ctx, { projectId: 'project' });
  }
  assert.equal(s.tables.hostedProjects.get('project').removal, 'deleted');
  for (const table of ['projectCoordinationSessions', 'projectCoordinationEvents'])
    assert.deepEqual([...s.tables[table].keys()], ['foreign']);
  return { ...s, bytes, contentType: `application/x-forge-object-${nonce}` };
}
async function reconcile(s) {
  let cursor = null;
  for (let i = 0; i < 20; i++) {
    const page = await lifecycle.reconcile._handler(s.ctx, { projectId: 'project', cursor });
    if (page.isDone) return;
    cursor = page.cursor;
  }
  throw Error('Cleanup did not complete');
}
test('deleted-project reconciliation removes nonce-bound uploads arriving after purge with unknown storage IDs and is retryable', async () => {
  const s = await removedProject();
  const late = await s.ctx.storage.store(new Blob([s.bytes], { type: s.contentType }));
  await reconcile(s);
  assert.equal(s.files.has(late), false);
  await reconcile(s);
  const later = await s.ctx.storage.store(new Blob([s.bytes], { type: s.contentType }));
  await reconcile(s);
  assert.equal(s.files.has(later), false);
});
test('late-object cleanup preserves foreign, differently bound and referenced content and remains owner authorized', async () => {
  const s = await removedProject();
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
  s.caller('stranger');
  await assert.rejects(reconcile(s));
  assert.equal(s.files.has(late), true);
  s.caller('owner');
  await reconcile(s);
  assert.equal(s.files.has(late), false);
  for (const id of [referenced, changed, foreign]) assert.equal(s.files.has(id), true);
});
test('archive cleanup receipt continuation reaches the late-object sweep', async () => {
  const s = await removedProject();
  s.tables.projectUploadCleanup.set('binding', {
    _id: 'binding',
    _creationTime: 1,
    projectId: 'project',
    owner: 'owner',
    actor: 'owner',
    uploadId: 'old-backup',
    operationId: randomUUID(),
    kind: 'backup',
    nonce: 'archive-nonce',
    digest: hash('archive'),
    size: 7,
    pending: false,
  });
  const late = await s.ctx.storage.store(new Blob([s.bytes], { type: s.contentType }));
  await reconcile(s);
  assert.equal(s.files.has(late), false);
});
test('late-object sweep resumes provider cursors with one storage pagination per transaction', async () => {
  const s = await removedProject(),
    late = await s.ctx.storage.store(new Blob([s.bytes], { type: s.contentType }));
  const metadata = s.files.get(late).metadata;
  let calls = 0;
  s.ctx.db.system.query = () => ({
    order: () => ({
      paginate: async ({ cursor }) => {
        assert.equal(++calls, 1);
        return cursor === null
          ? { page: [], isDone: false, continueCursor: 'provider-second-page' }
          : (assert.equal(cursor, 'provider-second-page'),
            { page: [metadata], isDone: true, continueCursor: 'provider-end' });
      },
    }),
  });
  const first = await lifecycle.reconcile._handler(s.ctx, { projectId: 'project', cursor: null });
  assert.equal(first.isDone, false);
  assert.equal(s.files.has(late), true);
  calls = 0;
  const last = await lifecycle.reconcile._handler(s.ctx, { projectId: 'project', cursor: first.cursor });
  assert.equal(last.isDone, true);
  assert.equal(s.files.has(late), false);
});
