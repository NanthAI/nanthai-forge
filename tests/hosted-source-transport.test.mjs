// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
const work = await import(moduleUrl('../convex/projectWork.ts'));

test('selected source transport observes same-ID migration without Work replay and keeps owner/contributor/reader boundaries', async () => {
  const s = state([]),
    projectId = 'project',
    backupId = 'backup',
    head = 'a'.repeat(64),
    digest = 'b'.repeat(64),
    manifestDigest = 'c'.repeat(64);
  const project = {
    _id: projectId,
    _creationTime: 1,
    owner: 'owner',
    key: randomUUID(),
    name: 'Source fixture',
    revision: 9,
    currentBackup: backupId,
    work: { backupId, revision: 7, initialRevision: 7, operationId: randomUUID() },
  };
  s.tables.hostedProjects.set(projectId, project);
  s.tables.projectBackups.set(backupId, {
    _id: backupId,
    projectId,
    status: 'stored',
    digest,
    preview: { head, format: 'native', manifestDigest },
  });
  const get = s.ctx.db.get,
    query = s.ctx.db.query,
    reads = [];
  s.ctx.db.get = async id => {
    reads.push(id);
    return get(id);
  };
  s.ctx.db.query = table => {
    assert.ok(
      ['projectContributors', 'projectReaders'].includes(table),
      'Only indexed access checks; no archive history or Work event enumeration',
    );
    return query(table);
  };
  s.ctx.storage.get = () => {
    throw Error('No source storage read for transport observation');
  };
  s.ctx.runQuery = () => {
    throw Error('No Work reconstruction action');
  };
  const input = { projectId, backupId },
    before = structuredClone(project);
  const archive = await work.sourceTransport._handler(s.ctx, input);
  assert.equal(archive.transport, 'archive');
  assert.deepEqual(reads, [projectId, backupId]);
  Object.assign(s.tables.projectBackups.get(backupId), {
    transport: 'objects',
    objectManifest: { digest: manifestDigest, size: 100 },
  });
  reads.length = 0;
  const objects = await work.sourceTransport._handler(s.ctx, input);
  assert.deepEqual(objects, { ...archive, transport: 'objects' });
  assert.deepEqual(reads, [projectId, backupId]);
  assert.deepEqual(project, before);
  s.tables.projectContributors.set('grant', { _id: 'grant', projectId, contributor: 'contributor' });
  s.caller('contributor');
  assert.equal((await work.sourceTransport._handler(s.ctx, input)).transport, 'objects');
  s.tables.projectContributors.delete('grant');
  await assert.rejects(
    work.sourceTransport._handler(s.ctx, input),
    e => e.data.code === 'PROJECT_UNAVAILABLE',
  );
  s.tables.projectReaders.set('reader-grant', { _id: 'reader-grant', projectId, reader: 'reader' });
  s.caller('reader');
  assert.equal((await work.sourceTransport._handler(s.ctx, input)).transport, 'objects');
  s.tables.projectReaders.delete('reader-grant');
  await assert.rejects(
    work.sourceTransport._handler(s.ctx, input),
    e => e.data.code === 'PROJECT_UNAVAILABLE',
  );
  s.caller(null);
  await assert.rejects(
    work.sourceTransport._handler(s.ctx, input),
    e => e.data.code === 'PROJECT_UNAVAILABLE',
  );
  s.caller('owner');
  s.tables.projectBackups.set('foreign', {
    ...s.tables.projectBackups.get(backupId),
    _id: 'foreign',
    projectId: 'another-project',
  });
  await assert.rejects(
    work.sourceTransport._handler(s.ctx, { projectId, backupId: 'foreign' }),
    e => e.data.code === 'PROJECT_UNAVAILABLE',
  );
});
