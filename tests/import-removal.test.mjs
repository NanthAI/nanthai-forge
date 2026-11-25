// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { state, job, providers, r2Reference } from './hosted-fixture.mjs';
const removal = await import(moduleUrl('../convex/importRemoval.ts'));
const lifecycle = await import(moduleUrl('../convex/lifecycle.ts'));
const imports = await import(moduleUrl('../convex/imports.ts'));
const saved = await import(moduleUrl('../convex/savedViews.ts'));
const interests = await import(moduleUrl('../convex/interests.ts'));
const { currentAccess } = await import(moduleUrl('../convex/access.ts'));
const paginationOpts = { cursor: null, numItems: 50 };
const command = { importId: 'own', operationId: 'remove-1' };

test('owner-only removal uses the same unavailable response for absent and other-owner imports; retries retain identity', async () => {
  const s = state();
  for (const caller of [undefined, 'reader', 'stranger']) {
    s.caller(caller);
    for (const importId of ['own', 'missing']) {
      await assert.rejects(
        removal.remove._handler(s.ctx, { ...command, importId }),
        e =>
          e.data.code === 'GITHUB_UNAVAILABLE' &&
          e.data.message === 'This Codescape is unavailable with the current access.',
      );
    }
  }
  assert.equal(s.scheduled.length, 0);
  s.caller('owner');
  s.tables.imports.get('own').task = 'indexer';
  s.tasks.set('indexer', { state: { kind: 'pending' } });
  await removal.remove._handler(s.ctx, command);
  await removal.remove._handler(s.ctx, command);
  assert.equal(s.tasks.get('indexer').state.kind, 'canceled');
  assert.equal(s.scheduled.length, 1);
  assert.equal(s.tables.imports.get('own').generation, 2);
  await assert.rejects(
    removal.remove._handler(s.ctx, { ...command, importId: 'other' }),
    e => e.data.code === 'BAD_ARGUMENT',
  );
  s.tasks.set(s.scheduled[0].id, { state: { kind: 'failed' } });
  await removal.remove._handler(s.ctx, command);
  assert.equal(s.scheduled.length, 2, 'A failed cleanup can be resumed with the original operation.');
  s.tables.imports.delete('own');
  await removal.remove._handler(s.ctx, command);
  s.caller('reader');
  await assert.rejects(removal.remove._handler(s.ctx, command));
});

test('public and private removals disappear immediately from owner, shared projection, saved views, interests and source routes', async () => {
  for (const visibility of ['private', 'public']) {
    const s = state([{ ...job(), visibility }]);
    s.tables.savedViews.set('bookmark', {
      _id: 'bookmark',
      importId: 'own',
      owner: 'owner',
      name: 'Saved',
      route: { view: 'source', state: 'source-pin', file: 'src/a.ts', line: 1 },
    });
    s.tables.projectInterests.set('interest', {
      _id: 'interest',
      importId: 'own',
      owner: 'owner',
      repository: 'example/project',
      ref: 'main',
      starred: true,
      watching: false,
      seenHead: null,
      active: true,
      revision: 1,
      _creationTime: 1,
    });
    assert.equal((await removal.listMine._handler(s.ctx, { paginationOpts })).page.length, 1);
    const listed = await removal.listAsOwner._handler(s.ctx, { owner: 'owner', paginationOpts });
    assert.deepEqual(listed.page[0], {
      id: 'own',
      repository: 'example/project',
      ref: 'main',
      phase: 'ready',
      createdAt: 1,
    });
    await removal.removeAsOwner._handler(s.ctx, { ...command, owner: 'owner' });
    assert.deepEqual((await removal.listMine._handler(s.ctx, { paginationOpts })).page, []);
    assert.deepEqual((await saved.list._handler(s.ctx, { paginationOpts })).page, []);
    assert.deepEqual(await removal.removed._handler(s.ctx, { ids: ['own', 'missing'] }), ['own', 'missing']);
    const cleanup = providers(() => false);
    try {
      await assert.rejects(currentAccess(s.ctx, 'own', 'owner'), e => e.code === 'GITHUB_UNAVAILABLE');
    } finally {
      cleanup();
    }
    assert.equal(
      await imports.update._handler(s.ctx, { id: 'own', generation: 1, phase: 'ready', artifactKey: 'late' }),
      false,
    );
  }
});

test('cleanup drains every import dependency and nested zone/grant records across batches, deleting unshared storage only', async () => {
  const s = state([job(), { ...job('other'), owner: 'another', artifactKey: 'shared' }]);
  const refs = new Map();
  const ref = id => refs.get(id) ?? refs.set(id, r2Reference(s, `blob-${id}`)).get(id);
  s.tables.imports.get('own').artifactKey = ref('saved');
  s.tables.imports.get('other').artifactKey = ref('shared');
  for (const table of [
    'savedViews',
    'projectInterests',
    'interestChanges',
    'importReaders',
    'teamImports',
    'importArtifacts',
    'agentGrants',
    'sourceZones',
  ]) {
    for (let i = 0; i < 105; i++) {
      const id = `${table}-${i}`;
      s.tables[table].set(id, { _id: id, importId: 'own', artifactKey: ref(`blob-${table}-${i}`) });
    }
    s.tables[table].set(`${table}-other`, {
      _id: `${table}-other`,
      importId: 'other',
      artifactKey: ref('shared'),
    });
  }
  for (const table of ['agentEvents', 'zoneReaders', 'zoneChanges']) {
    for (let i = 0; i < 105; i++) {
      const id = `${table}-${i}`;
      s.tables[table].set(id, { _id: id, agentId: 'agentGrants-0', zoneId: 'sourceZones-0' });
    }
  }
  s.tables.importArtifacts.set('shared-ref', {
    _id: 'shared-ref',
    importId: 'own',
    artifactKey: ref('shared'),
  });
  s.tables.derivedArtifacts.set('derived', {
    _id: 'derived',
    original: ref('saved'),
    removed: false,
    storageId: ref('derived-blob'),
  });
  await removal.remove._handler(s.ctx, command);
  let batches = 0;
  while (s.tables.imports.has('own')) {
    assert.ok(++batches < 100);
    await lifecycle.purge._handler(s.ctx, { id: 'own' });
  }
  assert.ok(batches > 5);
  for (const table of [
    'savedViews',
    'projectInterests',
    'interestChanges',
    'importReaders',
    'teamImports',
    'importArtifacts',
    'agentGrants',
    'sourceZones',
  ]) {
    assert.equal(s.tables[table].size, 1, table);
    assert.equal([...s.tables[table].values()][0].importId, 'other');
  }
  for (const table of ['agentEvents', 'zoneReaders', 'zoneChanges', 'derivedArtifacts'])
    assert.equal(s.tables[table].size, 0, table);
  const removed = id => s.tables.artifactBlobs.get(`blob-${id}`).removed;
  for (const id of ['saved', 'derived-blob', 'blob-sourceZones-0', 'blob-agentGrants-0'])
    assert.equal(removed(id), true, id);
  assert.equal(removed('shared'), false);
  await lifecycle.purge._handler(s.ctx, { id: 'own' });
  await removal.remove._handler(s.ctx, command);
});
