import { historicalArchiveActions } from './historical-archive-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
const projectBackups = await import(moduleUrl('../convex/projectBackups.ts'));
const actions = historicalArchiveActions(await import(moduleUrl('../convex/projectBackupActions.ts')));
const { snapshotDownload } = await import(moduleUrl('../web/src/snapshot.ts'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const page = { paginationOpts: { cursor: null, numItems: 20 } };
function fixture() {
  const s = state([]),
    native = s.ctx.runQuery;
  let urls = 0;
  s.tables.hostedProjects = new Map();
  s.tables.projectBackups = new Map();
  s.ctx.runQuery = s.ctx.runMutation = (ref, args) =>
    getFunctionName(ref).startsWith('projectBackups:')
      ? projectBackups[getFunctionName(ref).split(':')[1]]._handler(s.ctx, args)
      : native(ref, args);
  s.ctx.storage.generateUploadUrl = async () => `https://fixture.invalid/${++urls}`;
  s.ctx.db.system.query = () => ({
    order: () => ({
      paginate: async ({ cursor, numItems }) => {
        const rows = [...s.files].map(([id, file]) => ({ _id: id, ...file.metadata })),
          start = Number(cursor ?? 0);
        return {
          page: rows.slice(start, start + numItems),
          isDone: start + numItems >= rows.length,
          continueCursor: String(start + numItems),
        };
      },
    }),
  });
  s.put = (id, bytes, type) =>
    s.files.set(id, {
      blob: new Blob([bytes], { type }),
      metadata: {
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('base64'),
        contentType: type,
      },
    });
  s.urls = () => urls;
  return s;
}
const input = bytes => ({
  key: randomUUID(),
  name: 'Forge',
  operationId: randomUUID(),
  previous: null,
  digest: sha(bytes),
  size: bytes.length,
  preview: {
    manifestDigest: 'a'.repeat(64),
    head: 'b'.repeat(40),
    format: 'sha1',
    revision: 7,
    intents: 2,
    lanes: 4,
    views: 3,
    runs: 3,
    files: 15,
    unavailable: 0,
    channels: [{ name: 'main', head: 'c'.repeat(40) }],
  },
});

test('owner-bound native archives reconcile unknown upload replies, paginate metadata and preserve concurrent/newer pointers and original operations', async () => {
  const s = fixture(),
    bytes = Buffer.from('retained source and Work'),
    request = input(bytes);
  const prepare = args => actions.prepare._handler(s.ctx, args),
    reconcile = id => actions.reconcileUpload._handler(s.ctx, { id });
  const first = await prepare(request);
  assert.equal(first.backup.status, 'uploading');
  assert.equal(s.urls(), 1);
  for (let i = 0; i < 105; i++) s.put(`unrelated-${i}`, bytes, 'application/gzip');
  s.put('original', bytes, first.contentType); // Native upload completed but its reply never reached the client.
  const stored = await reconcile(first.backup.id);
  assert.equal(stored.status, 'stored');
  assert.equal(stored.current, true);
  assert.equal(
    (await prepare({ ...request, preview: Object.fromEntries(Object.entries(request.preview).reverse()) }))
      .backup.id,
    stored.id,
  );
  assert.equal(s.urls(), 1);
  assert.equal(s.reads(), 0, 'Reconciliation reads native file metadata, not blob bytes.');
  await assert.rejects(
    prepare({ ...request, digest: 'd'.repeat(64) }),
    e => e.data.code === 'WORK_OPERATION_CHANGED',
  );
  const second = await prepare({ ...request, operationId: randomUUID(), previous: stored.id }),
    concurrent = await prepare({ ...request, operationId: randomUUID(), previous: stored.id });
  s.put('second', bytes, second.contentType);
  s.put('concurrent', bytes, concurrent.contentType);
  assert.equal((await reconcile(second.backup.id)).current, true);
  assert.equal((await reconcile(concurrent.backup.id)).current, false);
  assert.equal(
    (await prepare(request)).backup.current,
    false,
    'Old request replay never rewinds the current remote backup.',
  );
  const history = await projectBackups.history._handler(s.ctx, { ...page, projectId: stored.projectId });
  assert.equal(history.page.length, 3);
  assert.equal(history.page.filter(row => row.current).length, 1);
  assert.equal(s.tables.hostedProjects.get(stored.projectId).revision, 2);
  assert.equal(s.tables.imports.size, 0);
  assert.equal(s.scheduled.length, 0);
  assert.deepEqual(s.deleted, []);
});

test('private archive identity and native ownership/hash/size binding reject foreign claims before source reads and download validates original bytes', async t => {
  const s = fixture(),
    bytes = Buffer.alloc(2 * 1024 * 1024 + 7, 'x'),
    request = input(bytes);
  const prepared = await actions.prepare._handler(s.ctx, request),
    id = prepared.backup.id;
  s.put('foreign', bytes, 'application/gzip');
  await assert.rejects(
    actions.complete._handler(s.ctx, { id, storageId: 'foreign' }),
    e => e.data.code === 'INVALID_WORK_BACKUP',
  );
  s.put('own', bytes, prepared.contentType);
  for (const change of [{ size: 2 }, { sha256: 'wrong' }, { contentType: 'application/gzip' }]) {
    const saved = { ...s.files.get('own').metadata };
    Object.assign(s.files.get('own').metadata, change);
    await assert.rejects(actions.complete._handler(s.ctx, { id, storageId: 'own' }));
    Object.assign(s.files.get('own').metadata, saved);
  }
  await actions.complete._handler(s.ctx, { id, storageId: 'own' });
  for (const caller of [undefined, 'other']) {
    s.caller(caller);
    assert.deepEqual((await projectBackups.list._handler(s.ctx, page)).page, []);
    for (const invoke of [
      () => projectBackups.history._handler(s.ctx, { ...page, projectId: prepared.backup.projectId }),
      () => actions.reconcileUpload._handler(s.ctx, { id }),
      () => actions.complete._handler(s.ctx, { id, storageId: 'own' }),
      () => actions.downloadPart._handler(s.ctx, { id, offset: 0, digest: request.digest }),
    ])
      await assert.rejects(invoke());
  }
  assert.equal(s.reads(), 0);
  s.caller('other');
  const foreignRequest = await actions.prepare._handler(s.ctx, request);
  assert.notEqual(foreignRequest.backup.projectId, prepared.backup.projectId);
  await assert.rejects(actions.complete._handler(s.ctx, { id: foreignRequest.backup.id, storageId: 'own' }));
  s.caller('owner');
  const { blob, filename } = await snapshotDownload(async offset => ({
    ...(await actions.downloadPart._handler(s.ctx, { id, offset, digest: request.digest })),
    contentType: 'application/gzip',
    repository: request.name,
    head: request.preview.head,
  }));
  assert.equal(sha(Buffer.from(await blob.arrayBuffer())), request.digest);
  assert.equal(s.reads(), 2);
  assert.match(filename, /\.tar\.gz$/);
  for (const args of [
    { offset: -1, digest: request.digest },
    { offset: bytes.length, digest: request.digest },
    { offset: 0, digest: 'old' },
  ])
    await assert.rejects(actions.downloadPart._handler(s.ctx, { id, ...args }));
  const fetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = fetch;
  });
  globalThis.fetch = async (...args) => {
    const response = await fetch(...args);
    s.tables.hostedProjects.get(prepared.backup.projectId).owner = 'other';
    return response;
  };
  await assert.rejects(actions.downloadPart._handler(s.ctx, { id, offset: 0, digest: request.digest }));
});

test('native archive uploads retain their declared source format and original request reconciliation', async () => {
  const s = fixture(),
    bytes = Buffer.from('native archive'),
    request = input(bytes);
  request.preview.format = 'native';
  request.preview.head = 'b'.repeat(64);
  request.preview.channels[0].head = 'c'.repeat(64);
  const prepared = await actions.prepare._handler(s.ctx, request);
  s.put('native', bytes, prepared.contentType);
  const stored = await actions.complete._handler(s.ctx, { id: prepared.backup.id, storageId: 'native' });
  assert.equal(stored.preview.format, 'native');
  assert.equal((await actions.prepare._handler(s.ctx, request)).backup.id, stored.id);
  await assert.rejects(
    actions.prepare._handler(s.ctx, { ...request, preview: { ...request.preview, format: 'sha256' } }),
    e => e.data.code === 'WORK_OPERATION_CHANGED',
  );
});
