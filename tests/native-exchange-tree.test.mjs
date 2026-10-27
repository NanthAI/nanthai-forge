import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildByteTree,
  readByteTree,
  buildExchangeRoot,
  resolveExchangeRoot,
} from '../dist/native-exchange-tree.js';
import { digest } from '../dist/hash.js';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { WorkStore } from '../dist/work-store.js';
import { pushNativeExchange, pullNativeExchange } from '../dist/native-exchange.js';
const reader = objects => async pins =>
  pins.map(pin => {
    assert(objects.has(pin.sha256), 'missing object');
    return objects.get(pin.sha256);
  });
test('metadata tree preserves exact bytes and reuses distant records after insertions, edits and removals', async () => {
  const records = Array.from({ length: 10000 }, (_, i) => ({
    id: randomUUID(),
    value: `record ${i} ` + 'x'.repeat(200),
  }));
  const original = Buffer.from(JSON.stringify({ unknown: { bytes: 'é\n' }, records }, null, 2)),
    before = new Map(),
    a = buildByteTree(original, before);
  assert.deepEqual(await readByteTree(a, reader(before)), original);
  records[100].value = 'changed';
  records.splice(500, 0, { id: randomUUID(), value: 'inserted' });
  records.splice(8500, 1);
  const next = Buffer.from(JSON.stringify({ unknown: { bytes: 'é\n' }, records }, null, 2)),
    after = new Map(),
    b = buildByteTree(next, after);
  assert.deepEqual(await readByteTree(b, reader(after)), next);
  const changed = [...after].filter(([hash]) => !before.has(hash));
  assert(changed.reduce((n, [, bytes]) => n + bytes.length, 0) < original.length / 5);
  const corrupt = new Map(after);
  corrupt.set(b.tree.sha256, Buffer.from('bad'));
  await assert.rejects(readByteTree(b, reader(corrupt)), e => e.code === 'INVALID_WORK_BACKUP');
  await assert.rejects(
    readByteTree({ ...b, size: b.size + 1 }, reader(after)),
    e => e.code === 'INVALID_WORK_BACKUP',
  );
});
test('tree rejects invalid descending ancestry and unequal logical Work pins', async () => {
  const bytes = Buffer.from(
      JSON.stringify({
        kind: 'forge-byte-tree',
        schema: 1,
        children: [
          { sha256: 'a'.repeat(64), size: 0, height: 1, length: 0 },
          { sha256: 'b'.repeat(64), size: 0, height: 0, length: 0 },
        ],
      }),
    ),
    tree = { sha256: digest(bytes), size: bytes.length, height: 1, length: 0 };
  await assert.rejects(
    readByteTree({ sha256: digest(''), size: 0, tree }, async () => [bytes]),
    e => e.code === 'INVALID_WORK_BACKUP',
  );
  const work = Buffer.from('{}'),
    manifest = Buffer.from(
      JSON.stringify({
        kind: 'forge-native-work-backup',
        schema: 1,
        id: randomUUID(),
        head: 'c'.repeat(64),
        revision: 1,
        files: [{ path: 'work.json', sha256: digest('different'), size: 9 }],
        unavailable: [],
        coverage: 'fixture',
      }),
    ),
    built = buildExchangeRoot(manifest, work);
  await assert.rejects(
    resolveExchangeRoot(built.bytes, reader(built.objects)),
    e => e.code === 'INVALID_WORK_BACKUP',
  );
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-metadata-tree-')),
    root = join(dir, 'owner');
  mkdirSync(root);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  initNative(root);
  const w = new WorkService(root),
    objects = new Map(),
    snapshots = new Map(),
    logical = new Map();
  const transport = {
    metadataTrees: true,
    missing: async pins => pins.filter(pin => !objects.has(pin.sha256)).map(pin => pin.sha256),
    upload: async (pin, bytes) => {
      assert.equal(digest(bytes), pin.sha256);
      objects.set(pin.sha256, Buffer.from(bytes));
    },
    publish: async pin => {
      snapshots.set(pin.sha256, pin);
      return pin.sha256;
    },
    manifest: async id => {
      const resolved = await resolveExchangeRoot(objects.get(id), reader(objects));
      logical.set(digest(resolved.work), resolved.work);
      return {
        json: resolved.manifest.toString(),
        digest: digest(resolved.manifest),
        size: resolved.manifest.length,
        sourceDigest: id,
      };
    },
    download: async pin => Buffer.from(logical.get(pin.sha256) ?? objects.get(pin.sha256)),
  };
  return { dir, root, w, objects, transport };
}
test('incremental metadata checkpoint retries after unknown publish and restores fresh without logical full objects', async t => {
  const f = fixture(t),
    intent = f.w.execute({ action: 'intent', outcome: 'Preserve metadata' }, f.w.status().revision).result;
  const data = f.w.store.load();
  data.intents = Array.from({ length: 1000 }, (_, i) => ({
    ...structuredClone(intent),
    id: randomUUID(),
    outcome: `Original record ${i}`,
    constraints: 'private retained constraint '.repeat(20),
  }));
  data.customExtension = { untouched: ['ordered', 42] };
  f.w.store.save(data);
  const revision = f.w.store.load().revision,
    op = randomUUID(),
    publish = f.transport.publish;
  f.transport.publish = async pin => {
    await publish(pin);
    throw new Error('unknown publication');
  };
  await assert.rejects(pushNativeExchange(f.w.store, revision, op, f.transport), /unknown publication/);
  f.transport.publish = publish;
  const saved = await pushNativeExchange(f.w.store, revision, op, f.transport);
  assert.equal(saved.uploadedBytes, 0);
  // Even an enabled preparation hint cannot add a Work-file read requirement
  // after this transport has reconciled a successful publication.
  f.transport.checkpointKey = id => id && `synthetic/${id}`;
  const staged = join(f.w.store.directory, `exchange-${op}`, 'work.json');
  renameSync(staged, `${staged}.unavailable`);
  try {
    const retry = await pushNativeExchange(f.w.store, revision, op, f.transport);
    assert.equal(retry.uploadedBytes, 0, 'stored retry does not reread or hash whole Work');
  } finally {
    renameSync(`${staged}.unavailable`, staged);
  }
  const root = JSON.parse(f.objects.get(saved.digest));
  assert.equal(root.kind, 'forge-native-exchange');
  assert.equal(f.objects.has(root.work.sha256), false);
  assert.equal(f.objects.has(root.manifest.sha256), true); // Tiny logical manifest is one reusable leaf.
  const target = join(f.dir, 'fresh');
  await pullNativeExchange(saved.backupId, target, f.transport);
  const restored = new WorkStore(target).load();
  assert.deepEqual(restored, f.w.store.load());
  const store = f.w.store,
    edited = store.load();
  edited.revision++;
  edited.intents[500].notes.push({
    kind: 'comment',
    text: 'Single record edit',
    at: new Date().toISOString(),
  });
  store.save(edited);
  const delta = await pushNativeExchange(store, edited.revision, randomUUID(), f.transport);
  assert(delta.uploadedBytes < 120000, `metadata delta ${delta.uploadedBytes}`);
  assert(delta.reusedObjects > 5);
  assert.equal(readFileSync(join(target, 'a.ts'), 'utf8'), 'export const a = 1;\n');
});
test('a source checkpoint restores through metadata trees while preserving earlier source ancestry', async t => {
  const f = fixture(t),
    act = command => f.w.execute(command, f.w.status().revision).result;
  const intent = act({ action: 'intent', outcome: 'Change source' }),
    lane = act({ action: 'lane', intentId: intent.id, name: 'Source' });
  await pushNativeExchange(f.w.store, f.w.status().revision, randomUUID(), f.transport);
  writeFileSync(join(f.w.store.path(lane.id), 'a.ts'), 'export const a = 2;\n');
  const observed = f.w.status().lanes[0];
  act({
    action: 'checkpoint',
    laneId: lane.id,
    expectedHead: observed.head,
    expectedTree: observed.indexTree,
    message: 'One source edit',
  });
  const result = await pushNativeExchange(f.w.store, f.w.status().revision, randomUUID(), f.transport),
    target = join(f.dir, 'source-restored');
  await pullNativeExchange(result.backupId, target, f.transport);
  const restored = new WorkStore(target);
  assert.equal(readFileSync(join(restored.path(lane.id), 'a.ts'), 'utf8'), 'export const a = 2;\n');
  assert.deepEqual(restored.load().lanes, f.w.store.load().lanes);
});

test('full metadata reads batch internal pages and leaves within the existing byte window', async t => {
  const objects = new Map(),
    parts = [],
    pages = [];
  const put = bytes => {
    const pin = { sha256: digest(bytes), size: bytes.length };
    objects.set(pin.sha256, bytes);
    return pin;
  };
  const page = children => ({
    ...put(Buffer.from(JSON.stringify({ kind: 'forge-byte-tree', schema: 1, children }))),
    height: Math.max(...children.map(c => c.height)) + 1,
    length: children.reduce((n, c) => n + c.length, 0),
  });
  for (let i = 0; i < 100; i++) {
    const children = [];
    for (let j = 0; j < 2; j++) {
      const bytes = Buffer.alloc(4096);
      bytes.writeUInt32LE(i * 2 + j);
      parts.push(bytes);
      children.push({ ...put(bytes), height: 0, length: bytes.length });
    }
    pages.push(page(children));
  }
  const bytes = Buffer.concat(parts),
    tree = page(pages);
  const windows = [];
  assert.deepEqual(
    await readByteTree(
      { sha256: digest(bytes), size: bytes.length, tree },
      async pins => {
        windows.push(pins);
        return reader(objects)(pins);
      },
      { batchSize: 100 },
    ),
    bytes,
  );
  assert.equal(windows.length, 4);
  assert(
    windows.every(pins => pins.length <= 100 && pins.reduce((n, p) => n + p.size, 0) <= 2 * 1024 * 1024),
  );
  t.diagnostic(
    JSON.stringify({ metadataReadWindows: windows.length, oldDepthFirstWindows: 201, maxPins: 100 }),
  );
});
