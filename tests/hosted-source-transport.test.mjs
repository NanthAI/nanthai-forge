// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
const work = await import(moduleUrl('../convex/projectWork.ts'));
const { captureHostedPair, refreshHostedPairTransport } = await import(
  moduleUrl('../web/src/hosted-handoff.ts')
);

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

test('retained journal and source pins survive in-place conversion while handoff adopts its matching object manifest', async () => {
  const snapshot = {
    key: randomUUID(),
    name: 'Original pair',
    backupId: 'original',
    backupDigest: 'a'.repeat(64),
    sourceHead: 'b'.repeat(64),
    sourceKind: 'native',
  };
  const journal = JSON.stringify({
    kind: 'forge-hosted-work-journal',
    projectKey: snapshot.key,
    revision: 41,
    base: { archiveSha256: snapshot.backupDigest, manifestSha256: 'c'.repeat(64) },
    source: { backupId: snapshot.backupId, head: snapshot.sourceHead, kind: 'native' },
    events: [{ id: randomUUID(), text: 'Retained pending collaboration' }],
  });
  let journalReads = 0;
  const original = await captureHostedPair(snapshot, async () => {
      journalReads++;
      return journal;
    }),
    retained = structuredClone(original);
  const observation = {
    backupId: snapshot.backupId,
    digest: snapshot.backupDigest,
    head: snapshot.sourceHead,
    kind: 'native',
    transport: 'objects',
    manifestDigest: 'c'.repeat(64),
  };
  const migrated = refreshHostedPairTransport(original, observation);
  assert.deepEqual(original, retained);
  assert.equal(migrated.journal, journal);
  assert.equal(migrated.journalSha256, createHash('sha256').update(journal).digest('hex'));
  assert.equal(migrated.revision, 41);
  assert.equal(journalReads, 1);
  assert.equal(migrated.archive.transport, 'objects');
  assert.equal(migrated.archive.manifestDigest, observation.manifestDigest);
  assert.equal(migrated.archive.digest, snapshot.backupDigest);
  assert.equal(refreshHostedPairTransport(migrated, observation), migrated);
  // Another selected backup cannot replace this original pair, even with the same bytes.
  assert.equal(refreshHostedPairTransport(original, { ...observation, backupId: 'new-current' }), original);
  for (const patch of [{ digest: 'd'.repeat(64) }, { head: 'e'.repeat(64) }, { kind: 'git' }])
    assert.throws(
      () => refreshHostedPairTransport(original, { ...observation, ...patch }),
      /source identity differs/,
    );
});
