import { captureNativeArchive } from './native-archive-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { digest } from '../dist/hash.js';
import { ConvexExchange } from '../dist/exchange-client.js';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { reconcileHostedWork } from '../dist/native-companion.js';
import { WorkService } from '../dist/work.js';
import { pullNativeExchange } from '../dist/native-exchange.js';
import { metadataRequest, workBytes } from '../dist/work-metadata.js';
import { NativeSource } from '../dist/native-source.js';
import { readHosted } from './hosted-read.mjs';
const names = [
  'projectObjects',
  'projectExchange',
  'projectExchangeActions',
  'projectExchangeCache',
  'projectBackups',
  'projectWork',
  'projectWorkActions',
];
const modules = Object.fromEntries(
  await Promise.all(names.map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))])),
);
const objects = modules.projectObjects,
  actions = modules.projectExchangeActions;
function fixture() {
  const s = state([]),
    run = s.ctx.runQuery;
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: randomUUID(),
    name: 'Synthetic exchange',
    currentBackup: null,
    revision: 0,
  });
  s.ctx.storage.generateUploadUrl = async () => 'https://fixture.invalid/upload';
  s.ctx.runAction =
    s.ctx.runQuery =
    s.ctx.runMutation =
      (ref, args) => {
        const [name, method] = getFunctionName(ref).split(':');
        return modules[name] ? modules[name][method]._handler(s.ctx, args) : run(ref, args);
      };
  return s;
}
function transport(s, previous = null) {
  return {
    missing: pins =>
      objects.missing._handler(s.ctx, {
        projectId: 'project',
        objects: pins.map(p => ({ digest: p.sha256, size: p.size })),
      }),
    upload: async (p, bytes) => {
      const row = await objects.prepare._handler(s.ctx, {
        projectId: 'project',
        digest: p.sha256,
        size: p.size,
      });
      if (row.stored) return;
      const id = await s.ctx.storage.store(new Blob([bytes], { type: row.contentType }));
      await objects.complete._handler(s.ctx, { id: row.id, storageId: id });
    },
    publish: (p, _metadataOnly, ownerDerived) =>
      actions.publish._handler(s.ctx, {
        projectId: 'project',
        operationId: randomUUID(),
        previous,
        digest: p.sha256,
        size: p.size,
        displayProtocol: 3,
        ownerDerived,
      }),
    manifest: backupId => actions.manifest._handler(s.ctx, { backupId }),
    download: async p => {
      const chunks = [];
      let offset = 0;
      do {
        const part = await actions.downloadPart._handler(s.ctx, {
          projectId: 'project',
          digest: p.sha256,
          offset,
        });
        chunks.push(Buffer.from(part.data));
        offset += part.data.byteLength;
      } while (offset < p.size);
      return Buffer.concat(chunks);
    },
  };
}
test('project object storage reconciles unknown uploads, preserves project isolation and removes duplicate uploads', async () => {
  const s = fixture(),
    bytes = Buffer.from('private source'),
    pin = { projectId: 'project', digest: digest(bytes), size: bytes.length };
  const row = await objects.prepare._handler(s.ctx, pin);
  assert.equal(row.created, true);
  const id = await s.ctx.storage.store(new Blob([bytes], { type: row.contentType }));
  assert.equal((await objects.reconcile._handler(s.ctx, { id: row.id, cursor: null })).stored, true);
  const retry = await objects.prepare._handler(s.ctx, pin);
  assert.equal(retry.id, row.id);
  assert.equal(retry.stored, true);
  const duplicate = await s.ctx.storage.store(new Blob([bytes], { type: row.contentType }));
  await objects.complete._handler(s.ctx, { id: row.id, storageId: duplicate });
  assert.ok(!s.files.has(duplicate));
  assert.ok(s.files.has(id));
  const wrong = await s.ctx.storage.store(new Blob([bytes]));
  await assert.rejects(objects.complete._handler(s.ctx, { id: row.id, storageId: wrong }));
  for (const actor of [undefined, 'stranger']) {
    s.caller(actor);
    await assert.rejects(
      objects.missing._handler(s.ctx, {
        projectId: 'project',
        objects: [{ digest: pin.digest, size: pin.size }],
      }),
    );
    await assert.rejects(
      actions.downloadPart._handler(s.ctx, { projectId: 'project', digest: pin.digest, offset: 0 }),
    );
    await assert.rejects(objects.complete._handler(s.ctx, { id: row.id, storageId: id }));
  }
  s.caller('owner');
  s.tables.hostedProjects.set('other', { ...s.tables.hostedProjects.get('project'), _id: 'other' });
  const other = await objects.prepare._handler(s.ctx, { ...pin, projectId: 'other' });
  assert.notEqual(other.id, row.id);
  await assert.rejects(objects.complete._handler(s.ctx, { id: other.id, storageId: id }));
  assert.deepEqual(
    await objects.missing._handler(s.ctx, {
      projectId: 'other',
      objects: [{ digest: pin.digest, size: pin.size }],
    }),
    [pin.digest],
  );
});

test('explicit project deletion removes shared object bytes once, including unresolved uploads, preserves foreign objects and reconciles late uploads', async () => {
  const s = fixture(),
    lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts')),
    t = transport(s);
  const pin = { sha256: digest('retained'), size: 8 };
  await t.upload(pin, Buffer.from('retained'));
  const unknown = await objects.prepare._handler(s.ctx, {
    projectId: 'project',
    digest: digest('unknown'),
    size: 7,
  });
  const unknownId = await s.ctx.storage.store(new Blob(['unknown'], { type: unknown.contentType }));
  const foreignId = await s.ctx.storage.store(new Blob(['keep'], { type: 'application/x-foreign' }));
  await lifecycle.permanentlyDelete._handler(s.ctx, {
    projectId: 'project',
    operationId: randomUUID(),
    expectedRevision: 0,
  });
  for (let n = 0; n < 20 && s.tables.hostedProjects.get('project').removal !== 'deleted'; n++)
    await lifecycle.purge._handler(s.ctx, { projectId: 'project' });
  assert.equal(s.tables.hostedProjects.get('project').removal, 'deleted');
  assert.ok(!s.files.has(unknownId));
  assert.ok(s.files.has(foreignId));
  assert.equal(
    [...s.tables.projectObjects.values()].every(row => row.removed && !row.storageId),
    true,
  );
  const late = await s.ctx.storage.store(new Blob(['unknown'], { type: unknown.contentType }));
  await objects.complete._handler(s.ctx, { id: unknown.id, storageId: late });
  assert.ok(!s.files.has(late));
  await assert.rejects(
    objects.prepare._handler(s.ctx, { projectId: 'project', digest: pin.sha256, size: pin.size }),
  );
});
test('explicit native archive migration keeps backup IDs and old journals, verifies complete restore, and retires containers only after reference-safe switch', async t => {
  const { setup } = await import('./r2-harness.mjs');
  await setup(t);
  const s = fixture(),
    migration = await import(moduleUrl('../convex/projectExchangeMigration.ts'));
  const { exportNativeWork } = await import('../dist/native-backup.js'),
    { migrateNativeArchive } = await import('../dist/native-exchange-migrate.js');
  const { readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'forge-archive-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(dir, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'source.bin'), Buffer.alloc(65536, 71));
  initNative(root);
  const store = new WorkStore(root);
  const archive = (await exportNativeWork(store, store.load().revision, true)).result,
    manifest = JSON.parse(archive.json),
    data = store.load(),
    nonce = randomUUID();
  const storageId = await s.ctx.storage.store(
    new Blob([readFileSync(archive.archive.path)], { type: `application/x-forge-backup-${nonce}` }),
  );
  const backup = {
    projectId: 'project',
    operationId: randomUUID(),
    request: 'original',
    nonce,
    previous: null,
    digest: archive.archive.sha256,
    size: archive.archive.size,
    status: 'stored',
    storageId,
    preview: {
      manifestDigest: digest(archive.json),
      head: manifest.head,
      format: 'native',
      revision: data.revision,
      intents: 0,
      lanes: 0,
      views: 0,
      runs: 0,
      files: manifest.files.length,
      unavailable: 0,
      channels: [],
    },
  };
  const id = await s.ctx.db.insert('projectBackups', backup);
  s.tables.hostedProjects.get('project').currentBackup = id;
  const shared = await s.ctx.db.insert('projectBackups', { ...backup, operationId: randomUUID() });
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId: id,
    operationId: randomUUID(),
  });
  const before = JSON.parse(await readHosted(s.ctx, { projectId: 'project' })),
    journal = await modules.projectWorkActions.exportJournal._handler(s.ctx, { projectId: 'project' }),
    journalPath = join(dir, 'old-journal.json');
  writeFileSync(journalPath, journal);
  const tr = transport(s);
  tr.migrate = (backupId, operationId, originalDigest, manifest) =>
    migration.migrate._handler(s.ctx, {
      backupId,
      operationId,
      originalDigest,
      manifestDigest: manifest.sha256,
      manifestSize: manifest.size,
    });
  const operation = randomUUID(),
    complete = tr.migrate;
  tr.migrate = async () => {
    throw new Error('lost before switch');
  };
  await assert.rejects(
    migrateNativeArchive(archive.archive.path, backup.digest, tr, id, operation),
    /lost before switch/,
  );
  assert.equal(s.tables.projectBackups.get(id).transport, undefined);
  assert.ok(s.files.has(storageId));
  tr.migrate = complete;
  const first = await migrateNativeArchive(archive.archive.path, backup.digest, tr, id, operation);
  assert.equal(first.logicalClosureVerified, true);
  assert.equal(first.fullRestoreVerified, false);
  assert.equal(first.result.retired, false);
  assert.ok(s.files.has(storageId), 'Another original backup still references compressed bytes.');
  const row = s.tables.projectBackups.get(id);
  assert.equal(row.digest, backup.digest);
  assert.notEqual(row.objectManifest.digest, backup.digest);
  assert.equal(row.archiveReceipt.digest, backup.digest);
  const after = JSON.parse(await readHosted(s.ctx, { projectId: 'project' }));
  assert.deepEqual(after.data, before.data);
  assert.equal(after.backupId, id);
  assert.equal(after.backupDigest, backup.digest);
  const restored = join(dir, 'old-journal-restored');
  await pullNativeExchange(id, restored, tr, { journalPath });
  assert.deepEqual(readFileSync(join(restored, 'source.bin')), readFileSync(join(root, 'source.bin')));
  const secondOperation = randomUUID(),
    nativeMutation = s.ctx.runMutation;
  let fail = true;
  s.ctx.runMutation = async (ref, args) => {
    if (getFunctionName(ref) === 'projectExchange:retireArchive' && fail) {
      fail = false;
      throw new Error('lost retirement reply');
    }
    return nativeMutation(ref, args);
  };
  await assert.rejects(
    migrateNativeArchive(archive.archive.path, backup.digest, tr, shared, secondOperation),
    /lost retirement reply/,
  );
  assert.ok(s.files.has(storageId));
  assert.equal(s.tables.projectBackups.get(shared).transport, 'objects');
  const second = await migrateNativeArchive(archive.archive.path, backup.digest, tr, shared, secondOperation);
  assert.equal(second.uploadedObjects, 0);
  assert.equal(second.result.retired, true);
  assert.ok(!s.files.has(storageId));
  const retry = await migrateNativeArchive(archive.archive.path, backup.digest, tr, id, operation);
  assert.equal(retry.uploadedObjects, 0);
  assert.equal(retry.result.retired, true);
  assert.equal(s.tables.projectBackups.size, 2);
  assert.equal(s.tables.hostedProjects.get('project').work.backupId, id);
  await assert.rejects(
    migrateNativeArchive(archive.archive.path, 'a'.repeat(64), tr, id, operation),
    e => e.code === 'INVALID_WORK_BACKUP',
  );
});
test('batch transfer commits successful members and reconciles lost POST/finalize replies without resending stored bytes', async t => {
  const { ConvexExchange } = await import('../dist/exchange-client.js'),
    s = fixture(),
    client = new ConvexExchange('https://example.convex.cloud', 'test-only', 'project', randomUUID(), null);
  let losePost = true,
    loseComplete = false,
    posts = 0;
  const calls = [],
    nativeFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = nativeFetch;
  });
  client.client = {
    query: async (ref, args) => objects[getFunctionName(ref).split(':')[1]]._handler(s.ctx, args),
    mutation: async (ref, args) => {
      const name = getFunctionName(ref).split(':')[1];
      calls.push(name);
      const result = await objects[name]._handler(s.ctx, args);
      if (name === 'completeBatch' && loseComplete) {
        loseComplete = false;
        throw new Error('lost finalize');
      }
      return result;
    },
  };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://fixture.invalid/upload');
    posts++;
    const id = await s.ctx.storage.store(new Blob([options.body], { type: options.headers['Content-Type'] }));
    if (losePost) {
      losePost = false;
      throw new Error('lost post reply');
    }
    return Response.json({ storageId: id });
  };
  const content = ['one', 'two'].map(value => ({
    pin: { sha256: digest(value), size: 3 },
    bytes: Buffer.from(value),
  }));
  await assert.rejects(
    client.uploadBatch(content),
    error => error.code === 'EXCHANGE_REQUEST_FAILED' && /Convex object upload/.test(error.message),
  );
  assert.equal(posts, 2);
  assert.equal([...s.tables.projectObjects.values()].filter(row => row.storageId).length, 1);
  assert.deepEqual(calls, ['prepareBatch', 'completeBatch']);
  assert.deepEqual(await client.uploadBatch(content), { uploadedObjects: 0, uploadedBytes: 0 });
  assert.equal(posts, 2);
  assert.equal([...s.tables.projectObjects.values()].filter(row => row.storageId).length, 2);
  const later = ['three', 'four'].map(value => ({
    pin: { sha256: digest(value), size: value.length },
    bytes: Buffer.from(value),
  }));
  loseComplete = true;
  await assert.rejects(client.uploadBatch(later), /lost finalize/);
  assert.equal(posts, 4);
  assert.deepEqual(await client.uploadBatch(later), { uploadedObjects: 0, uploadedBytes: 0 });
  assert.equal(posts, 4);
  s.caller('stranger');
  await assert.rejects(
    objects.prepareBatch._handler(s.ctx, {
      projectId: 'project',
      objects: [{ digest: digest('no'), size: 2 }],
    }),
  );
  const own = [...s.tables.projectObjects.values()][0];
  await assert.rejects(
    objects.completeBatch._handler(s.ctx, { objects: [{ id: own._id, storageId: own.storageId }] }),
  );
});
test('small-content batches verify all bytes and current access while larger content retains ranged downloads', async () => {
  const s = fixture(),
    tx = transport(s),
    contents = [Buffer.from('one'), Buffer.from('two')],
    pins = contents.map(bytes => ({ sha256: digest(bytes), size: bytes.length }));
  for (let i = 0; i < pins.length; i++) await tx.upload(pins[i], contents[i]);
  const args = { projectId: 'project', digests: pins.map(pin => pin.sha256) };
  const result = await actions.downloadBatch._handler(s.ctx, args);
  assert.deepEqual(
    result.map(row => Buffer.from(row.data)),
    contents,
  );
  s.caller('stranger');
  await assert.rejects(actions.downloadBatch._handler(s.ctx, args));
  s.caller('owner');
  const originalGet = s.ctx.storage.get;
  s.ctx.storage.get = async id => {
    const blob = await originalGet(id);
    s.tables.hostedProjects.get('project').removal = 'deleting';
    return blob;
  };
  await assert.rejects(actions.downloadBatch._handler(s.ctx, args));
  delete s.tables.hostedProjects.get('project').removal;
  s.ctx.storage.get = originalGet;
  const row = [...s.tables.projectObjects.values()].find(row => row.digest === pins[0].sha256);
  s.files.get(row.storageId).blob = new Blob(['bad']);
  await assert.rejects(actions.downloadBatch._handler(s.ctx, args));
  const { ConvexExchange } = await import('../dist/exchange-client.js'),
    client = new ConvexExchange('https://fixture.convex.cloud', 'fixture', 'project', 'op', null),
    large = Buffer.alloc(2 * 1024 * 1024 + 1, 42),
    largePin = { sha256: digest(large), size: large.length };
  let batches = 0,
    ranged = 0;
  client.client.mutation = async () => []; // no R2 objects
  client.client.action = async (_ref, args) => {
    batches++;
    return args.digests.map(id => {
      const index = pins.findIndex(pin => pin.sha256 === id);
      return { data: contents[index], digest: id, size: contents[index].length };
    });
  };
  client.download = async pin => {
    ranged++;
    assert.equal(pin.sha256, largePin.sha256);
    return large;
  };
  assert.deepEqual(await client.downloadBatch([...pins, largePin]), [...contents, large]);
  assert.equal(batches, 1);
  assert.equal(ranged, 1);
  client.client.action = async () => [
    { data: Buffer.from('bad'), digest: pins[0].sha256, size: pins[0].size },
  ];
  const cold = new ConvexExchange('https://fixture.convex.cloud', 'fixture', 'project', 'other', null);
  cold.client.mutation = async () => []; // no R2 objects
  cold.client.action = client.client.action;
  await assert.rejects(cold.downloadBatch([pins[0]]));
});

test('retiring an already absent exclusive archive reconciles when the provider rejects deleting a missing object', async () => {
  const s = fixture(),
    { removeExclusive } = await import(moduleUrl('../convex/projectStorage.ts')),
    original = s.ctx.storage.delete;
  s.ctx.storage.delete = async id => {
    assert.ok(s.files.has(id), 'Provider rejects missing storage deletion');
    return original(id);
  };
  const id = await s.ctx.storage.store(new Blob(['archive']));
  assert.equal(await removeExclusive(s.ctx, id), true);
  assert.equal(await removeExclusive(s.ctx, id), true);
  s.tables.projectBackups.set('still-referenced', { _id: 'still-referenced', storageId: id });
  assert.equal(await removeExclusive(s.ctx, id), false);
});

test('legacy metadata cache reconciles lost store replies, deduplicates and remains subject to current read authority', async () => {
  const s = fixture(),
    cache = modules.projectExchangeCache,
    bytes = Buffer.from('verified materialized bytes'),
    input = { projectId: 'project', actor: 'owner', digest: digest(bytes), size: bytes.length };
  const pending = await cache.prepare._handler(s.ctx, input),
    storageId = await s.ctx.storage.store(new Blob([bytes], { type: pending.contentType }));
  const retry = await cache.prepare._handler(s.ctx, input);
  assert.equal(retry.id, pending.id);
  assert.equal(retry.created, false);
  const reconciled = await cache.reconcile._handler(s.ctx, { id: pending.id, actor: 'owner', cursor: null });
  assert.equal(reconciled.stored, true);
  const duplicate = await s.ctx.storage.store(new Blob([bytes], { type: pending.contentType }));
  await cache.complete._handler(s.ctx, { id: pending.id, actor: 'owner', storageId: duplicate });
  assert(s.files.has(storageId));
  assert(!s.files.has(duplicate));
  await assert.rejects(cache.prepare._handler(s.ctx, { ...input, actor: 'stranger' }));
  await assert.rejects(cache.reconcile._handler(s.ctx, { id: pending.id, actor: 'stranger', cursor: null }));
  s.tables.hostedProjects.get('project').removal = 'deleted';
  s.tables.projectObjects.get(pending.id).removed = true;
  const late = await s.ctx.storage.store(new Blob([bytes], { type: pending.contentType }));
  await cache.complete._handler(s.ctx, { id: pending.id, actor: 'owner', storageId: late });
  assert(!s.files.has(late));
});
