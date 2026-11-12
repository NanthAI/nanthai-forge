// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { WorkService } from '../dist/work.js';
import { exportNativeWork, exportNativeSource, restoreNativeWork } from '../dist/native-backup.js';
import { digest } from '../dist/hash.js';
import { moduleUrl } from './convex-module.mjs';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { encodePhysicalEntries, physicalBucket } from '../dist/physical-manifest-codec.js';
import { encodePhysicalRoot } from '../dist/physical-manifest-root.js';
import { PhysicalManifestReader } from '../dist/physical-manifest.js';
import { writePhysicalManifest } from '../dist/physical-manifest-write.js';
import {
  physicalArchiveObjects,
  physicalArchiveEntries,
  physicalArchiveClosure,
} from '../dist/physical-source-archive.js';
const nonce = '11111111-1111-4111-8111-111111111111';
const pin = (source, bytes) => ({ sha256: source.put(Buffer.from(bytes)), size: bytes.length });
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-physical-archive-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(directory, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'a.txt'), 'initial file');
  initNative(root);
  const source = new NativeSource(root),
    store = new WorkStore(root),
    first = store.load().nativeHead;
  const put = bytes => pin(source, bytes);
  const statePin = id => ({ sha256: id, size: source.object(id).length });
  const legacyChunks = [];
  for (const file of source.state(first).files) {
    const member = { sha256: file.blob, size: source.object(file.blob).length },
      bytes = encodePhysicalEntries([member]);
    legacyChunks.push({
      ...put(bytes),
      bucket: physicalBucket(member.sha256),
      members: digest(member.sha256),
    });
  }
  const legacy = {
    schema: 1,
    kind: 'forge-physical-manifest',
    state: first,
    chunks: legacyChunks.sort((a, b) => a.bucket - b.bucket),
  };
  const additions = Array.from({ length: 8 }, (_, i) => ({
    path: `new-${i}.txt`,
    blob: source.put(Buffer.from(`member ${i}`)),
    mode: 'file',
  }));
  const second = source.writeState(
    [...source.state(first).files, ...additions],
    [first],
    'Nonce State',
    '2026-01-01T00:00:00Z',
  );
  const written = await writePhysicalManifest({
    state: second,
    members: source.state(second).files.map(file => file.blob),
    put,
    describe: async ids => ids.map(sha256 => ({ sha256, size: source.object(sha256).length, nonce })),
  });
  const original = written.root.chunks[0].pack;
  const carrier = put(
    Buffer.concat([
      Buffer.from('old leading metadata'),
      source.object(original.digest),
      Buffer.from('old trailing metadata'),
    ]),
  );
  const packed = {
    ...written.root,
    chunks: written.root.chunks.map(chunk => ({
      ...chunk,
      pack: {
        ...chunk.pack,
        digest: carrier.sha256,
        size: carrier.size,
        offset: chunk.pack.offset + 20,
        nonce,
      },
    })),
  };
  const skipped = source.writeState(
    source.state(second).files,
    [second],
    'Skipped root',
    '2026-01-01T00:00:01Z',
  );
  const privateBlob = source.put(Buffer.from('private unrelated Lane source'));
  const unrelated = source.writeState(
    [{ path: 'private.txt', blob: privateBlob, mode: 'file' }],
    [first],
    'Unrelated',
    '2026-01-01T00:00:02Z',
  );
  const unrelatedRoot = await writePhysicalManifest({
    state: unrelated,
    members: [privateBlob],
    put,
    describe: async ids => ids.map(sha256 => ({ sha256, size: source.object(sha256).length })),
  });
  const entries = [legacy, packed, unrelatedRoot.root].map(value => ({
    placement: 'archive',
    state: statePin(value.state),
    root: put(encodePhysicalRoot(value)),
    objects: physicalArchiveObjects(value),
  }));
  const inventory = put(
    Buffer.from(
      canonicalPayload({ kind: 'forge-source-physical-archive', schema: 1, previous: null, entries }),
    ),
  );
  store.locked(() => {
    const data = store.load();
    data.nativeHead = skipped;
    data.physicalSource = inventory;
    store.save(data);
  });
  const work = new WorkService(root);
  await work.dispatch(
    { action: 'intent', outcome: 'Private Work retained only in a Work export' },
    work.status().revision,
  );
  return {
    directory,
    root,
    source,
    store,
    entries,
    carrier,
    first,
    second,
    skipped,
    unrelated,
    privateBlob,
    statePin,
  };
}
for (const sourceOnly of [false, true])
  test(`Done-when5: ${sourceOnly ? 'Source' : 'Work'} archive restores legacy, nonce and skipped-root States with whole metadata packs`, async t => {
    const f = await fixture(t),
      exported = sourceOnly
        ? (await exportNativeSource(f.store, f.store.revision(), f.skipped)).result
        : (await exportNativeWork(f.store, f.store.revision(), true)).result,
      target = join(f.directory, 'restored');
    await restoreNativeWork(exported.archive.path, target);
    const store = new WorkStore(target),
      source = new NativeSource(target),
      data = store.load(),
      entries = [...physicalArchiveEntries(source, data.physicalSource)],
      closure = new Set(physicalArchiveClosure(source, data.physicalSource));
    assert.equal(data.nativeHead, f.skipped);
    assert(closure.has(f.carrier.sha256));
    assert.deepEqual(
      source.object(f.carrier.sha256),
      f.source.object(f.carrier.sha256),
      'copy the whole body including leading/trailing obsolete metadata',
    );
    const nonced = entries.find(entry => entry.state.sha256 === f.second);
    assert.equal(
      nonced.placement,
      'archive',
      'retained coordinates are never silently rebound to another project',
    );
    assert.equal(nonced.objects[0].nonce, nonce);
    assert.deepEqual(
      nonced.root,
      f.entries[1].root,
      'root bytes and exact nonce identities survive unchanged',
    );
    const read = async pin =>
      pin.pack
        ? source.object(pin.pack.digest).subarray(pin.pack.offset, pin.pack.offset + pin.size)
        : source.object(pin.sha256);
    const reader = await PhysicalManifestReader.open(f.second, nonced.root, read),
      files = source.state(f.second).files;
    assert.deepEqual(
      (await reader.lookup(files.map(file => file.blob))).map(row => row.sha256),
      files.map(file => file.blob),
    );
    assert(
      !entries.some(entry => entry.state.sha256 === f.skipped),
      'a skipped root keeps its complete logical source',
    );
    for (const file of source.state(f.skipped).files)
      assert.equal(source.object(file.blob).toString(), f.source.object(file.blob).toString());
    if (sourceOnly) {
      assert.equal(data.intents.length, 0);
      assert(!entries.some(entry => entry.state.sha256 === f.unrelated));
      assert(!closure.has(f.entries[2].root.sha256));
      assert.throws(() => source.object(f.privateBlob), /absent|unavailable|missing|ENOENT/i);
    } else {
      assert(data.intents.length > 0);
      assert(entries.some(entry => entry.state.sha256 === f.unrelated));
      assert.equal(source.object(f.privateBlob).toString(), 'private unrelated Lane source');
    }
    t.diagnostic(
      JSON.stringify({
        sourceOnly,
        roots: entries.length,
        wholePackBytes: f.carrier.size,
        rootBytes: nonced.root.size,
        convexCalls: 0,
      }),
    );
  });
test('Done-when5: a missing whole metadata body or forged chunk pin cannot pass an archive export', async t => {
  const f = await fixture(t),
    bad = { ...f.entries[1], objects: [] },
    root = pin(
      f.source,
      Buffer.from(
        canonicalPayload({
          kind: 'forge-source-physical-archive',
          schema: 1,
          previous: null,
          entries: [bad],
        }),
      ),
    );
  assert.throws(() => [...physicalArchiveClosure(f.source, root)], /every whole metadata key/);
  const original = f.source.object(f.entries[1].root.sha256);
  const { decodePhysicalRoot } = await import('../dist/physical-manifest-root.js');
  const decoded = decodePhysicalRoot(original);
  decoded.chunks[0].sha256 = 'f'.repeat(64);
  const forged = { ...f.entries[1], root: pin(f.source, encodePhysicalRoot(decoded)) };
  const index = pin(
    f.source,
    Buffer.from(
      canonicalPayload({
        kind: 'forge-source-physical-archive',
        schema: 1,
        previous: null,
        entries: [forged],
      }),
    ),
  );
  assert.throws(() => [...physicalArchiveClosure(f.source, index)], /chunk differs/);
});

for (const packed of [false, true])
  test(`Done-when5: an exported metadata closure survives pending and original-id retried ${packed ? 'pack' : 'raw'} uploads into another namespace`, async t => {
    const { setup, client } = await import('./r2-harness.mjs'),
      { uploadPhysicalObjects } = await import('../dist/exchange-upload.js'),
      { pullNativeExchange } = await import('../dist/native-exchange.js'),
      { makeFunctionReference } = await import('convex/server'),
      { readFileSync } = await import('node:fs');
    const f = await fixture(t),
      { s, fake } = await setup(t),
      exchange = client(s);
    const exported = (await exportNativeWork(f.store, f.store.revision(), false)).result,
      manifestBytes = readFileSync(join(exported.path, 'manifest.json')),
      manifest = JSON.parse(manifestBytes),
      manifestPin = { sha256: digest(manifestBytes), size: manifestBytes.length };
    const objects = [
      ...manifest.files.map(file => ({
        pin: { sha256: file.sha256, size: file.size },
        read: () => readFileSync(join(exported.path, file.path)),
      })),
      { pin: manifestPin, read: () => manifestBytes },
    ];
    const pending = [];
    await uploadPhysicalObjects(exchange.client, 'project', objects, {
      batchSize: 100,
      pack: packed,
      deferCommit: pending,
    });
    assert(pending.length > 0);
    assert(pending.every(({ id }) => !s.tables.projectObjects.get(id).r2Committed));
    const retried = [];
    await uploadPhysicalObjects(exchange.client, 'project', objects, {
      batchSize: 100,
      pack: packed,
      deferCommit: retried,
    });
    assert.deepEqual(
      [...new Set(retried.map(row => row.id))].sort(),
      [...new Set(pending.map(row => row.id))].sort(),
      'retry reconciles the original upload ids',
    );
    const commit = makeFunctionReference('projectObjectCommit:commitBatch');
    await exchange.client.action(commit, { objects: retried });
    await exchange.client.action(commit, { objects: pending });
    const compact = await import(moduleUrl('../convex/projectObjectCatalogCompact.ts'));
    const sourceIds = new Set(
      manifest.files.filter(file => file.path.startsWith('objects/')).map(file => file.sha256),
    );
    for (const row of s.tables.projectObjects.values())
      if (sourceIds.has(row.digest)) row.sourceReferenced = true;
    s.tables.hostedProjects.get('project').sourceManifestVersion = 2;
    const puts = fake.requests.filter(request => request.method === 'PUT').length;
    for (const points of [false, true]) {
      let after = null,
        result;
      do {
        result = JSON.parse(
          await s.transaction(() =>
            compact.step._handler(s.ctx, {
              projectId: 'project',
              actor: 'owner',
              operationId: points ? 'archive-points' : 'archive-catalog',
              after,
              ...(points ? { points: true } : {}),
            }),
          ),
        );
        after = result.after;
      } while (!result.done);
    }
    assert.equal(s.tables.projectObjectCatalog.size, 0);
    await exchange.client.action(commit, { objects: pending });
    assert.equal(
      fake.requests.filter(request => request.method === 'PUT').length,
      puts,
      'metadata retirement and old-id replay never reupload bytes',
    );
    const target = join(f.directory, 'transferred');
    exchange.manifest = async () => ({
      json: manifestBytes.toString(),
      digest: manifestPin.sha256,
      size: manifestPin.size,
    });
    await pullNativeExchange(manifestPin.sha256, target, exchange);
    const source = new NativeSource(target),
      data = new WorkStore(target).load();
    assert.equal(data.nativeHead, f.skipped);
    assert.deepEqual(source.object(f.carrier.sha256), f.source.object(f.carrier.sha256));
    assert.deepEqual([...physicalArchiveEntries(source, data.physicalSource)], f.entries);
    const { findObjects } = await import(moduleUrl('../convex/projectObjectFind.ts'));
    const retained = await findObjects(
      { ...s.ctx },
      'project',
      objects.map(row => row.pin.sha256),
    );
    assert(
      retained.every(
        (row, index) => row?.digest === objects[index].pin.sha256 && row.size === objects[index].pin.size,
      ),
    );
    t.diagnostic(
      JSON.stringify({
        packed,
        logicalObjects: objects.length,
        originalUploadIds: new Set(pending.map(row => row.id)).size,
        wholeMetadataBytes: f.carrier.size,
      }),
    );
  });
