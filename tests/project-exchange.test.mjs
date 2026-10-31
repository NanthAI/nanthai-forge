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
import { legacyObject } from './project-exchange-fixture.mjs';
import { digest } from '../dist/hash.js';
import { ConvexExchange } from '../dist/exchange-client.js';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';

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
  'projectObjectCommit',
  'projectObjectDownloads',
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
async function putR2(s, row, bytes) {
  const response = await fetch(row.target.url, { method: 'PUT', headers: row.target.headers, body: bytes });
  assert(response.ok || response.status === 412);
  await modules.projectObjectCommit.commitBatch._handler(s.ctx, { objects: [{ id: row.id }] });
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
      if (!row.stored) await putR2(s, row, bytes);
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
      const first = await actions.downloadPart._handler(s.ctx, {
        projectId: 'project',
        digest: p.sha256,
        offset: 0,
      });
      if (first.direct) {
        const [signed] = await modules.projectObjectDownloads.signDownloads._handler(s.ctx, {
          projectId: 'project',
          digests: [p.sha256],
        });
        return Buffer.from(await (await fetch(signed.url)).arrayBuffer());
      }
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
test('project object storage puts bytes in R2, deduplicates and preserves project isolation', async () => {
  const s = fixture(),
    bytes = Buffer.from('private source'),
    pin = { projectId: 'project', digest: digest(bytes), size: bytes.length };
  const row = await objects.prepare._handler(s.ctx, pin);
  assert.equal(row.created, true);
  assert.equal(row.target.kind, 'r2');
  await putR2(s, row, bytes);
  const retry = await objects.prepare._handler(s.ctx, pin);
  assert.equal(retry.id, row.id);
  assert.equal(retry.stored, true);
  assert.equal(retry.target, undefined);
  assert.equal(s.tables.projectObjects.get(row.id).location, 'r2');
  assert.equal(s.files.size, 0);
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
  }
  s.caller('owner');
  s.tables.hostedProjects.set('other', { ...s.tables.hostedProjects.get('project'), _id: 'other' });
  const other = await objects.prepare._handler(s.ctx, { ...pin, projectId: 'other' });
  assert.notEqual(other.id, row.id);
  assert.notEqual(other.target.url, row.target.url);
  assert.deepEqual(
    await objects.missing._handler(s.ctx, {
      projectId: 'other',
      objects: [{ digest: pin.digest, size: pin.size }],
    }),
    [pin.digest],
  );
});

test('explicit project deletion removes every object row, including unresolved uploads, and preserves foreign files', async () => {
  const s = fixture(),
    lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts')),
    t = transport(s);
  const pin = { sha256: digest('retained'), size: 8 };
  await t.upload(pin, Buffer.from('retained'));
  await objects.prepare._handler(s.ctx, { projectId: 'project', digest: digest('unknown'), size: 7 });
  const foreignId = await s.ctx.storage.store(new Blob(['keep'], { type: 'application/x-foreign' }));
  await lifecycle.permanentlyDelete._handler(s.ctx, {
    projectId: 'project',
    operationId: randomUUID(),
    expectedRevision: 0,
  });
  for (let n = 0; n < 20 && s.tables.hostedProjects.get('project').removal !== 'deleted'; n++) {
    await lifecycle.purge._handler(s.ctx, { projectId: 'project' });
    // The scheduled R2 prefix purge (tests/r2-maintenance.test.mjs) finishes before the tombstone.
    const project = s.tables.hostedProjects.get('project');
    if (project.r2Purge) project.r2PrefixPurged = true;
  }
  assert.equal(s.tables.hostedProjects.get('project').removal, 'deleted');
  assert.ok(s.tables.hostedProjects.get('project').r2Purge, 'every deletion purges its R2 prefix');
  assert.ok(s.files.has(foreignId));
  assert.equal(
    [...s.tables.projectObjects.values()].every(row => row.removed && !row.storageId),
    true,
  );
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
test('small legacy Convex batches verify all bytes and current access while larger content retains ranged downloads', async () => {
  const s = fixture(),
    contents = [Buffer.from('one'), Buffer.from('two')],
    pins = contents.map(bytes => ({ sha256: digest(bytes), size: bytes.length }));
  // Copies written before R2 was the only path stay readable from Convex until cleanup.
  for (const bytes of contents) await legacyObject(s, bytes);
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
