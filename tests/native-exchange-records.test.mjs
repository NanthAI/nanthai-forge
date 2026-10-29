// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { pushNativeExchange, pullNativeExchange } from '../dist/native-exchange.js';
import { WorkStore } from '../dist/work-store.js';
import { resolveExchangeRoot } from '../dist/native-exchange-tree.js';
import { digest } from '../dist/hash.js';
test('production native v2 push pins concurrent Work for the next push and reuses original retry bytes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-record-push-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  initNative(root);
  const work = new WorkService(root),
    objects = new Map();
  let previous,
    writeDuringUpload = true;
  const transport = {
    metadataTrees: true,
    workRecords: true,
    checkpointKey: (id = previous) => id,
    missing: async pins => pins.filter(pin => !objects.has(pin.sha256)).map(pin => pin.sha256),
    upload: async (pin, bytes) => {
      assert.equal(digest(bytes), pin.sha256);
      objects.set(pin.sha256, Buffer.from(bytes));
      if (writeDuringUpload) {
        writeDuringUpload = false;
        work.execute({ action: 'intent', outcome: 'Arrived during upload' }, work.store.revision());
      }
    },
    publish: async pin => pin.sha256,
  };
  const revision = work.store.revision();
  const first = await pushNativeExchange(work.store, revision, randomUUID(), transport);
  previous = first.backupId;
  const read = pins => Promise.resolve(pins.map(pin => objects.get(pin.sha256)));
  const firstBytes = objects.get(first.digest);
  assert.equal(JSON.parse(firstBytes).schema, 2);
  const firstWork = JSON.parse((await resolveExchangeRoot(firstBytes, read)).work);
  assert.equal(firstWork.intents.length, 0);
  assert.equal(work.store.load().intents.length, 1);
  const operation = randomUUID(),
    nextRevision = work.store.revision();
  const next = await pushNativeExchange(work.store, nextRevision, operation, transport);
  const nextBytes = objects.get(next.digest),
    nextRoot = JSON.parse(nextBytes);
  assert.equal(nextRoot.schema, 2);
  assert(Array.isArray(nextRoot.ownerDiffstats));
  assert(Array.isArray(nextRoot.ownerViews));
  assert.ok(nextRoot.delta);
  assert.equal(
    JSON.parse((await resolveExchangeRoot(nextBytes, read)).work).intents[0].outcome,
    'Arrived during upload',
  );
  const retry = await pushNativeExchange(work.store, nextRevision, operation, transport);
  assert.equal(retry.digest, next.digest);
  assert.equal(retry.uploadedBytes, 0);
  const restored = `${root}-received`;
  const logical = new Map();
  t.after(() => rmSync(restored, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await pullNativeExchange(next.backupId, restored, {
    ...transport,
    manifest: async id => {
      const resolved = await resolveExchangeRoot(objects.get(id), read);
      logical.set(digest(resolved.work), resolved.work);
      return {
        json: resolved.manifest.toString('utf8'),
        digest: digest(resolved.manifest),
        size: resolved.manifest.length,
        sourceDigest: id,
      };
    },
    download: async pin => logical.get(pin.sha256) ?? objects.get(pin.sha256),
    downloadBatch: async pins => pins.map(pin => logical.get(pin.sha256) ?? objects.get(pin.sha256)),
  });
  assert.equal(new WorkStore(restored).load().intents[0].outcome, 'Arrived during upload');
});

test('publication receipt replay repairs a missing hint and the next format promotion sends a delta', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-record-replay-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  initNative(root);
  const store = new WorkStore(root),
    objects = new Map();
  const key = id => `synthetic/${id ?? 'previous'}`;
  const transport = {
    metadataTrees: true,
    workRecords: true,
    checkpointKey: key,
    missing: async pins => pins.filter(pin => !objects.has(pin.sha256)).map(pin => pin.sha256),
    upload: async (pin, bytes) => objects.set(pin.sha256, Buffer.from(bytes)),
    publish: async pin => pin.sha256,
  };
  const operationId = randomUUID(),
    revision = store.revision();
  const first = await pushNativeExchange(store, revision, operationId, transport);
  const hint = join(store.directory, `exchange-baseline-${digest(key(first.backupId))}.json`);
  rmSync(hint);
  transport.published = async () => first.backupId;
  const replay = await pushNativeExchange(store, revision, operationId, transport);
  assert.equal(replay.digest, first.digest);
  assert.equal(replay.uploadedBytes, 0);
  assert.equal(JSON.parse(JSON.parse(readFileSync(hint)).payload).manifest.id, operationId);
  const data = store.load();
  data.schema = 19;
  data.revision++;
  store.save(data);
  delete transport.published;
  transport.checkpointKey = id => key(id ?? first.backupId);
  const next = await pushNativeExchange(store, store.revision(), randomUUID(), transport);
  const nextRoot = JSON.parse(objects.get(next.digest));
  assert.ok(nextRoot.delta);
  const delta = JSON.parse(objects.get(nextRoot.delta.sha256));
  assert.equal(delta.base.root, JSON.parse(objects.get(first.digest)).records.sha256);
});

test('legacy unified baseline recovery preserves exact catalog property order and planned Intents', async t => {
  const { retainExchangeBaseline, exchangeBaseline } = await import('../dist/native-exchange-baseline.js');
  const { buildWorkRecords } = await import('../dist/work-exchange-records.js');
  const { workSchema } = await import('../dist/work-types.js');
  const { convertWorkTo18 } = await import('../dist/work-intent-converter.js');
  const { unifyIntent } = await import('../dist/work-intent-local.js');
  const directory = mkdtempSync(join(tmpdir(), 'forge-unified-hint-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const head = 'a'.repeat(64),
    source = convertWorkTo18(
      workSchema.parse({ schema: 17, revision: 7, nativeHead: head, intents: [], lanes: [], views: [] }),
    );
  source.intents.push(
    unifyIntent({
      id: randomUUID(),
      outcome: 'Planned',
      constraints: '',
      status: 'proposed',
      createdAt: 'now',
      notes: [],
    }),
  );
  const { schema, ...rest } = source,
    data = { ...rest, schema, opaque: { unchanged: true } },
    work = Buffer.from(JSON.stringify(data, null, 2)),
    id = randomUUID();
  const manifest = {
    schema: 1,
    kind: 'forge-native-work-backup',
    id,
    head,
    revision: data.revision,
    files: [{ path: 'work.json', sha256: digest(work), size: work.length }],
    unavailable: [],
    coverage: 'Synthetic',
  };
  const store = { native: true, directory },
    key = 'synthetic/legacy';
  mkdirSync(join(directory, `exchange-${id}`));
  writeFileSync(join(directory, `exchange-${id}`, 'work.json'), work);
  retainExchangeBaseline(store, key, manifest, data, [], []);
  const path = join(directory, `exchange-baseline-${digest(key)}.json`),
    envelope = JSON.parse(readFileSync(path)),
    value = JSON.parse(envelope.payload);
  delete value.data;
  const payload = JSON.stringify(value);
  writeFileSync(path, JSON.stringify({ payload, sha256: digest(payload) }));
  const recovered = exchangeBaseline(store, key);
  assert.equal(recovered.data.intents[0].base, undefined);
  assert.equal(buildWorkRecords(recovered.data).pin.sha256, buildWorkRecords(data).pin.sha256);
  assert.deepEqual(Object.keys(recovered.data), Object.keys(data));
});

test('record reseed uploads exact Work-bound count and View companions from existing owner facts', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-owner-index-pages-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.ts'), 'old\n');
  initNative(root);
  const work = new WorkService(root),
    execute = command => work.execute(command, work.store.revision()).result;
  const intent = execute({ action: 'intent', outcome: 'Count locally' });
  const lane = execute({ action: 'lane', intentId: intent.id, name: 'Edit' });
  const view = execute({
    action: 'compose',
    operationId: randomUUID(),
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: lane.head }],
  });
  const objects = new Map();
  const result = await pushNativeExchange(work.store, work.store.revision(), randomUUID(), {
    metadataTrees: true,
    workRecords: true,
    missing: async pins => pins.filter(p => !objects.has(p.sha256)).map(p => p.sha256),
    upload: async (pin, bytes) => {
      assert.equal(digest(bytes), pin.sha256);
      objects.set(pin.sha256, Buffer.from(bytes));
    },
    publish: async pin => pin.sha256,
  });
  const tree = JSON.parse(objects.get(result.digest));
  assert.equal(tree.ownerViews.length, 1);
  const provenance = tree.ownerViews[0];
  const page = JSON.parse(objects.get(provenance.sha256));
  assert.equal(page.work, tree.work.sha256);
  assert.equal(page.view[0], view.id);
  assert(page.view[2].some(row => row.collection === 'viewDetails'));
  const stats = tree.ownerDiffstats.flatMap(pin => {
    const page = JSON.parse(objects.get(pin.sha256));
    assert.equal(page.work, tree.work.sha256);
    return page.stats;
  });
  assert.deepEqual(stats.find(([key]) => key === `${view.base}:${view.head}`)[1], {
    files: 0,
    add: 0,
    del: 0,
  });
});
