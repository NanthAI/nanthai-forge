// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { state, job, providers } from './hosted-fixture.mjs';
const removal = await import(moduleUrl('../convex/importRemoval.ts'));
const lifecycle = await import(moduleUrl('../convex/lifecycle.ts'));
const imports = await import(moduleUrl('../convex/imports.ts'));
const saved = await import(moduleUrl('../convex/savedViews.ts'));
const remote = await import(moduleUrl('../convex/remote.ts'));
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
      route: {},
    });
    s.tables.projectInterests.set('interest', {
      _id: 'interest',
      importId: 'own',
      owner: 'owner',
      active: true,
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
    assert.deepEqual((await interests.list._handler(s.ctx, { paginationOpts })).page, []);
    assert.equal(await interests.current._handler(s.ctx, { importId: 'own' }), null);
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
    assert.equal(await imports.handoff._handler(s.ctx, { id: 'own', generation: 2 }), false);
    assert.equal(await imports.claim._handler(s.ctx, { id: 'own', generation: 2 }), false);
  }
});

test('cleanup drains every import dependency and nested zone/grant records across batches, deleting unshared storage only', async () => {
  const s = state([job(), { ...job('other'), owner: 'another', artifactKey: 'shared' }]);
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
      s.tables[table].set(id, { _id: id, importId: 'own', artifactKey: `blob-${table}-${i}` });
    }
    s.tables[table].set(`${table}-other`, {
      _id: `${table}-other`,
      importId: 'other',
      artifactKey: 'shared',
    });
  }
  for (const table of ['agentEvents', 'zoneReaders', 'zoneChanges']) {
    for (let i = 0; i < 105; i++) {
      const id = `${table}-${i}`;
      s.tables[table].set(id, { _id: id, agentId: 'agentGrants-0', zoneId: 'sourceZones-0' });
    }
  }
  s.tables.importArtifacts.set('shared-ref', { _id: 'shared-ref', importId: 'own', artifactKey: 'shared' });
  s.tables.derivedArtifacts.set('derived', {
    _id: 'derived',
    original: 'saved',
    removed: false,
    storageId: 'derived-blob',
  });
  s.file('saved', new Blob(['source']));
  s.file('derived-blob', new Blob(['derived']));
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
  assert.ok(s.deleted.includes('saved'));
  assert.ok(s.deleted.includes('derived-blob'));
  assert.ok(s.deleted.includes('blob-sourceZones-0'));
  assert.ok(s.deleted.includes('blob-agentGrants-0'));
  assert.ok(!s.deleted.includes('shared'));
  assert.equal(s.files.has('saved'), false);
  await lifecycle.purge._handler(s.ctx, { id: 'own' });
  await removal.remove._handler(s.ctx, command);
});

test('late remote uploads are discarded after removal without deleting another import’s retained blob', async () => {
  const s = state([
    { ...job(), visibility: 'public', remote: true },
    { ...job('other'), artifactKey: 'shared' },
  ]);
  await removal.remove._handler(s.ctx, command);
  for (const exists of [true, false]) {
    if (!exists) s.tables.imports.delete('own');
    s.file('late', new Blob(['late']));
    assert.equal(
      await remote.update._handler(s.ctx, { id: 'own', generation: 1, phase: 'ready', artifactKey: 'late' }),
      false,
    );
    assert.equal(s.files.has('late'), false);
    assert.equal(
      await remote.update._handler(s.ctx, {
        id: 'own',
        generation: 1,
        phase: 'ready',
        artifactKey: 'shared',
      }),
      false,
    );
    assert.ok(!s.deleted.includes('shared'));
  }
});
