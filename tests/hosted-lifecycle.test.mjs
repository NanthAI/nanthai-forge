import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
const imports = await import(moduleUrl('../convex/imports.ts'));
const lifecycle = await import(moduleUrl('../convex/lifecycle.ts'));
const lifecycleActions = await import(moduleUrl('../convex/lifecycleActions.ts'));
const sync = await import(moduleUrl('../convex/sync.ts'));
const hosted = await import(moduleUrl('../convex/hosted.ts'));
const { snapshotDownload } = await import(moduleUrl('../web/src/snapshot.ts'));
import { job, state, providers } from './hosted-fixture.mjs';

test('owner snapshot inspection reports original native stored bytes without blob reads or writes and rejects access loss, absent files and changed observations', async () => {
  const s = state([job(), { ...job('public'), visibility: 'public', scope: 'public' }]),
    blob = new Blob(['x'.repeat(33)], { type: 'application/gzip' });
  s.file('saved', blob);
  let revoked = false,
    afterMetadata = () => {},
    metadataReads = 0;
  let afterAuthorization = () => {};
  const query = s.ctx.runQuery,
    cleanup = providers(() => {
      afterAuthorization();
      return revoked;
    });
  s.ctx.runQuery = async (fn, args) => {
    const result = await query(fn, args);
    if (getFunctionName(fn) === 'lifecycle:fileInfo') {
      metadataReads++;
      afterMetadata();
    }
    return result;
  };
  const inspect = id => lifecycleActions.snapshotInfo._handler(s.ctx, { id });
  const before = JSON.stringify([...s.tables.imports.values()]);
  try {
    const page = await lifecycle.list._handler(s.ctx, { paginationOpts: { cursor: null, numItems: 20 } });
    assert.equal(page.page[0].snapshotInfoSupported, true);
    for (const caller of [undefined, 'other']) {
      s.caller(caller);
      await assert.rejects(inspect('own'));
    }
    s.caller('reader');
    s.tables.importReaders.set('grant', { _id: 'grant', importId: 'own', reader: 'reader', role: 'read' });
    await assert.rejects(inspect('own'));
    s.caller('owner');
    await assert.rejects(inspect('public'));
    assert.equal(metadataReads, 0);
    const info = await inspect('own');
    assert.deepEqual(info, {
      bytes: 33,
      digest: createHash('sha256').update('x'.repeat(33)).digest('hex'),
      contentType: 'application/gzip',
      head: 'a'.repeat(40),
      generation: 1,
    });
    assert.equal(JSON.stringify([...s.tables.imports.values()]), before);
    assert.equal(s.scheduled.length, 0);
    assert.equal(s.reads(), 0);
    revoked = true;
    await assert.rejects(inspect('own'));
    assert.equal(metadataReads, 1);
    revoked = false;
    afterMetadata = () => {
      revoked = true;
    };
    await assert.rejects(inspect('own'));
    revoked = false;
    for (const change of [{ generation: 2 }, { head: 'b'.repeat(40) }, { artifactKey: 'new' }]) {
      afterMetadata = () => Object.assign(s.tables.imports.get('own'), change);
      await assert.rejects(inspect('own'), e => e.data.code === 'STATE_MISMATCH');
      Object.assign(s.tables.imports.get('own'), job());
    }
    afterMetadata = () => {
      s.tables.imports.get('own').removal = 'trash';
    };
    await assert.rejects(inspect('own'));
    delete s.tables.imports.get('own').removal;
    afterMetadata = () => {
      afterAuthorization = () => {
        s.tables.imports.get('own').removal = 'trash';
        afterAuthorization = () => {};
      };
    };
    // The final authorization itself rereads lifecycle after its provider call.
    await assert.rejects(inspect('own'), e => e.data.code === 'GITHUB_UNAVAILABLE');
    delete s.tables.imports.get('own').removal;
    afterMetadata = () => {};
    s.files.delete('saved');
    await assert.rejects(inspect('own'), e => e.data.code === 'INVALID_ARTIFACT');
    delete s.tables.imports.get('own').artifactKey;
    await assert.rejects(inspect('own'), e => e.data.code === 'INDEX_MISSING');
    assert.equal(s.reads(), 0);
    assert.deepEqual(s.deleted, []);
  } finally {
    cleanup();
  }
});

test('private owner list, Trash/Restore and lifecycle metadata preserve tenant isolation and stopped workers', async () => {
  const s = state([
    job(),
    { ...job('other'), owner: 'other', scope: 'other' },
    { ...job('public'), visibility: 'public', scope: 'public' },
  ]);
  const list = () => lifecycle.list._handler(s.ctx, { paginationOpts: { cursor: null, numItems: 20 } });
  assert.deepEqual(
    (await list()).page.map(row => row.id),
    ['own'],
  );
  s.caller(undefined);
  assert.deepEqual((await list()).page, []);
  await assert.rejects(
    lifecycle.trash._handler(s.ctx, { id: 'own' }),
    error => error.data.code === 'GITHUB_UNAVAILABLE',
  );
  s.caller('other');
  await assert.rejects(lifecycle.trash._handler(s.ctx, { id: 'own' }));
  await lifecycle.permanentlyDelete._handler(s.ctx, { id: 'own' });
  assert.equal(s.scheduled.length, 0);
  s.caller('owner');
  const own = s.tables.imports.get('own');
  own.phase = 'fetching';
  own.task = 'worker';
  s.tasks.set('worker', { state: { kind: 'pending' } });
  const revision = await sync.begin._handler(s.ctx, { id: 'own' });
  await lifecycle.trash._handler(s.ctx, { id: 'own' });
  assert.equal(own.removal, 'trash');
  assert.equal(own.artifactKey, 'saved');
  assert.equal(own.phase, 'ready');
  assert.equal(s.tasks.get('worker').state.kind, 'canceled');
  await lifecycle.trash._handler(s.ctx, { id: 'own' });
  assert.equal(own.generation, 2);
  assert.equal(
    await imports.update._handler(s.ctx, { id: 'own', generation: 1, phase: 'ready', artifactKey: 'late' }),
    false,
  );
  assert.equal(await sync.begin._handler(s.ctx, { id: 'own' }), null);
  assert.equal(
    await sync.finish._handler(s.ctx, {
      id: 'own',
      revision,
      observation: { checkedAt: 2, result: 'checked' },
    }),
    false,
  );
  await assert.rejects(imports.begin._handler(s.ctx, own), error => error.data.code === 'IMPORT_REMOVED');
  let revoked = true;
  const cleanup = providers(() => revoked);
  try {
    assert.equal(
      (await list()).page[0].removal,
      'trash',
      'Ownership metadata remains available with revoked source access.',
    );
    await assert.rejects(lifecycleActions.restore._handler(s.ctx, { id: 'own' }));
    revoked = false;
    await assert.rejects(
      hosted.start._handler(s.ctx, { url: 'example/project' }),
      error => error.data.code === 'IMPORT_REMOVED' && /Restore/.test(error.data.message),
    );
    await lifecycleActions.restore._handler(s.ctx, { id: 'own' });
    assert.equal(own.removal, undefined);
    assert.equal(own.generation, 2);
    assert.equal(own.artifactKey, 'saved');
  } finally {
    cleanup();
  }
  await assert.rejects(lifecycle.trash._handler(s.ctx, { id: 'public' }));
});

test('permanent deletion paginates owned artifacts, preserves shared files and reconciles interrupted/de-duplicated deletion', async () => {
  const s = state([
    job(),
    { ...job('public'), visibility: 'public', scope: 'public', artifactKey: 'shared' },
  ]);
  for (let i = 0; i < 104; i++) {
    const key = i === 0 ? 'saved' : `old-${i}`;
    s.tables.importArtifacts.set(key, { _id: key, importId: 'own', artifactKey: key });
  }
  s.tables.importArtifacts.set('shared-owner', {
    _id: 'shared-owner',
    importId: 'own',
    artifactKey: 'shared',
  });
  s.tables.importArtifacts.set('shared-other', {
    _id: 'shared-other',
    importId: 'public',
    artifactKey: 'shared',
  });
  await lifecycle.permanentlyDelete._handler(s.ctx, { id: 'own' });
  await lifecycle.permanentlyDelete._handler(s.ctx, { id: 'own' });
  assert.equal(s.scheduled.length, 1);
  const first = s.scheduled[0];
  s.tasks.set(first.id, { state: { kind: 'failed' } });
  await lifecycle.permanentlyDelete._handler(s.ctx, { id: 'own' });
  assert.equal(s.scheduled.length, 2);
  for (let i = 1; i < s.scheduled.length; i++) await lifecycle.purge._handler(s.ctx, s.scheduled[i].args);
  assert.equal(s.deleted.length, 104);
  assert.ok(!s.deleted.includes('shared'));
  assert.equal(s.tables.imports.has('own'), false);
  assert.equal(s.tables.imports.has('public'), true);
  assert.equal(s.tables.importArtifacts.size, 1);
  assert.equal(s.tables.importArtifacts.get('shared-other').importId, 'public');
  await lifecycle.permanentlyDelete._handler(s.ctx, { id: 'own' });
  assert.equal(s.scheduled.length, 4);
  assert.equal(
    await imports.update._handler(s.ctx, { id: 'own', generation: 1, phase: 'ready', artifactKey: 'late' }),
    false,
  );
});

test('publication registers old/new artifacts transactionally for future owned cleanup', async () => {
  const s = state();
  assert.equal(
    await imports.update._handler(s.ctx, { id: 'own', generation: 1, phase: 'ready', artifactKey: 'new' }),
    true,
  );
  assert.deepEqual(
    [...s.tables.importArtifacts.values()].map(row => row.artifactKey),
    ['saved', 'new'],
  );
  await imports.update._handler(s.ctx, { id: 'own', generation: 1, phase: 'ready', artifactKey: 'new' });
  assert.equal(s.tables.importArtifacts.size, 2);
});

test('chunked snapshot transfer exceeds one response budget, verifies bytes and denies revoked/other/Trash access before storage', async () => {
  const s = state([{ ...job(), sync: { checkedAt: 1, result: 'checked', head: 'b'.repeat(40) } }]),
    blob = new Blob(['x'.repeat(22 * 1024 * 1024)], { type: 'application/gzip' });
  s.file('saved', blob);
  let revoked = false;
  const cleanup = providers(() => revoked);
  try {
    for (const caller of [undefined, 'other']) {
      s.caller(caller);
      await assert.rejects(lifecycleActions.downloadPart._handler(s.ctx, { id: 'own', offset: 0 }));
    }
    assert.equal(s.reads(), 0);
    s.caller('owner');
    const { blob: downloaded, filename } = await snapshotDownload((offset, digest) =>
      lifecycleActions.downloadPart._handler(s.ctx, { id: 'own', offset, digest }),
    );
    assert.equal(downloaded.size, blob.size);
    assert.equal(s.reads(), 11);
    assert.ok(filename.endsWith('.forge.json.gz'));
    assert.ok(
      filename.includes('a'.repeat(12)),
      'Export keeps the indexed revision when sync observes a newer head.',
    );
    assert.equal(
      createHash('sha256')
        .update(Buffer.from(await downloaded.arrayBuffer()))
        .digest('hex'),
      s.files.get('saved').metadata.sha256,
    );
    const data = new Uint8Array([1, 2, 3]).buffer,
      digest = createHash('sha256').update(Buffer.from(data)).digest('base64');
    const base64 = await snapshotDownload(async () => ({
      data,
      size: 3,
      digest,
      contentType: 'application/json',
      repository: 'fixture',
      head: 'a',
    }));
    assert.deepEqual(new Uint8Array(await base64.blob.arrayBuffer()), new Uint8Array(data));
    const before = s.reads();
    revoked = true;
    await assert.rejects(
      lifecycleActions.downloadPart._handler(s.ctx, { id: 'own', offset: 2 * 1024 * 1024 }),
    );
    assert.equal(s.reads(), before);
    revoked = false;
    await lifecycle.trash._handler(s.ctx, { id: 'own' });
    await assert.rejects(lifecycleActions.downloadPart._handler(s.ctx, { id: 'own', offset: 0 }));
    assert.equal(s.reads(), before);
    await lifecycleActions.restore._handler(s.ctx, { id: 'own' });
    await assert.rejects(lifecycleActions.downloadPart._handler(s.ctx, { id: 'own', offset: -1 }));
    await assert.rejects(lifecycleActions.downloadPart._handler(s.ctx, { id: 'own', offset: blob.size }));
    await assert.rejects(
      lifecycleActions.downloadPart._handler(s.ctx, { id: 'own', offset: 0, digest: 'old' }),
    );
    await assert.rejects(
      snapshotDownload(async () => ({
        data: new Uint8Array([1]).buffer,
        size: 1,
        digest: 'wrong',
        contentType: 'application/gzip',
        repository: 'fixture',
        head: 'a',
      })),
      /integrity check/,
    );
  } finally {
    cleanup();
  }
});

test('Codescape status rechecks removal and importer after GitHub calls; a concurrent removal or transfer returns nothing', async () => {
  const s = state([job(), { ...job('public'), visibility: 'public' }]);
  const status = id => hosted.status._handler(s.ctx, { id });
  const denied = error => error.data?.code === 'GITHUB_UNAVAILABLE';
  for (const [id, caller, change, privateRepository] of [
    ['own', 'owner', row => (row.removal = 'trash'), true],
    ['own', 'owner', row => (row.owner = 'transferred'), true],
    ['public', 'visitor', row => (row.removal = 'deleting'), false],
    ['public', undefined, row => (row.removal = 'trash'), false],
  ]) {
    const cleanup = providers(() => false, privateRepository),
      provider = globalThis.fetch,
      original = { ...s.tables.imports.get(id) };
    let during = () => {};
    globalThis.fetch = async (input, init) => {
      const response = await provider(input, init);
      if (new URL(input).hostname === 'api.github.com') during();
      return response;
    };
    try {
      s.caller(caller);
      assert.equal(JSON.parse(await status(id)).id, id);
      during = () => change(s.tables.imports.get(id));
      await assert.rejects(status(id), denied);
    } finally {
      globalThis.fetch = provider;
      cleanup();
      s.tables.imports.set(id, original);
    }
  }
});
