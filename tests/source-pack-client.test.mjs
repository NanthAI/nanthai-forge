// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  createReadStream,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { HostedCheckoutCache, checkoutPackMinimum } from '../dist/hosted-checkout-cache.js';
import { createSourcePack, unpackSourcePackObjects } from '../dist/source-pack-archive.js';
import { machineObjectsDirectory } from '../dist/machine-object-store.js';
import { SourceWorkerReader } from '../dist/hosted-source-worker-reader.js';
import { digest } from '../dist/hash.js';

/** Dogfood-scale tree (~3,000 files): the pack holds all but `changed` of them. */
function fixture(t, files = 3000, changed = 10) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-pack-client-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bytes = new Map(),
    packed = [];
  for (let i = 0; i < files; i++) {
    // Every 50th file repeats an earlier file's content: real trees share blobs across paths.
    const value = Buffer.from(
      i % 50 === 49 ? `file ${i - 1}\n${'x'.repeat((i - 1) % 97)}` : `file ${i}\n${'x'.repeat(i % 97)}`,
    );
    bytes.set(digest(value), value);
    packed.push({ path: `src/${i}.ts`, blob: digest(value), mode: 'file' });
  }
  const live = packed.map((file, i) => {
    if (i >= changed) return file;
    const value = Buffer.from(`changed ${i}`);
    bytes.set(digest(value), value);
    return { ...file, blob: digest(value) };
  });
  const source = join(directory, 'source');
  mkdirSync(source);
  for (const [id, value] of bytes) writeFileSync(join(source, id), value);
  return { directory, bytes, packed, live, source };
}

async function serve(t, path) {
  const server = createServer((request, response) => {
    response.writeHead(200);
    createReadStream(path).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/pack.gz`;
}

function transport(bytes, pack) {
  const calls = { objects: 0, sourcePack: 0, downloads: 0 };
  return {
    calls,
    objectPageSize: 100,
    async objects(digests) {
      calls.objects++;
      return digests.map(id => ({ sha256: id, size: bytes.get(id).length }));
    },
    async downloadToFile(pin, path) {
      calls.downloads++;
      writeFileSync(path, bytes.get(pin.sha256), { flag: 'wx', mode: 0o600 });
    },
    async sourcePack() {
      calls.sourcePack++;
      return pack;
    },
  };
}

async function packFor(t, data, stateRef = 'a'.repeat(64)) {
  const archive = join(data.directory, 'pack.gz');
  const object = await createSourcePack(stateRef, { files: data.packed }, data.source, archive);
  return { ...object, objectKey: 'k', createdAt: 1, url: await serve(t, archive) };
}

test('Lane open reads one pack plus changed objects, and a second root reads only the machine store', async t => {
  const data = fixture(t);
  const pack = await packFor(t, data);
  const machine = join(data.directory, 'machine');
  const ids = data.live.map(file => file.blob);

  const first = transport(data.bytes, pack);
  const cold = new HostedCheckoutCache(join(data.directory, 'a.forge-client'), first, undefined, machine);
  await cold.ensure(ids);
  // Budget: one pack read and one signing page for the 10 changed files (was 30 pages).
  assert.deepEqual(first.calls, { objects: 1, sourcePack: 1, downloads: 10 });
  assert.equal(cold.sourcePack, 'used');
  assert.equal(cold.packObjects, new Set(ids).size - 10);
  for (const id of ids) assert.deepEqual(readFileSync(join(cold.objects, id)), data.bytes.get(id));
  // The machine store keeps every verified object, including pack entries this tree no longer uses.
  assert.equal(readdirSync(machine).filter(name => !name.startsWith('.')).length, data.bytes.size);

  const second = transport(data.bytes, pack);
  const warm = new HostedCheckoutCache(join(data.directory, 'b.forge-client'), second, undefined, machine);
  await warm.ensure(ids);
  assert.deepEqual(second.calls, { objects: 0, sourcePack: 0, downloads: 0 });
  assert.equal(warm.machineObjects, new Set(ids).size);
  for (const id of ids) assert.deepEqual(readFileSync(join(warm.objects, id)), data.bytes.get(id));
});

test('a corrupt machine object is dropped and fetched again', async t => {
  const data = fixture(t, 20, 0);
  const machine = join(data.directory, 'machine');
  mkdirSync(machine);
  const [bad, ...rest] = data.live.map(file => file.blob);
  writeFileSync(join(machine, bad), 'tampered');
  for (const id of rest) writeFileSync(join(machine, id), data.bytes.get(id));
  const fake = transport(data.bytes, null);
  const cache = new HostedCheckoutCache(join(data.directory, 'c.forge-client'), fake, undefined, machine);
  await cache.ensure([bad, ...rest]);
  assert.equal(cache.machineObjects, rest.length);
  assert.equal(fake.calls.downloads, 1);
  assert.deepEqual(readFileSync(join(cache.objects, bad)), data.bytes.get(bad));
  assert.deepEqual(readFileSync(join(machine, bad)), data.bytes.get(bad));
});

test('missing, small or invalid packs fall back to per-object reads with exact bytes', async t => {
  const data = fixture(t, checkoutPackMinimum + 100);
  const ids = data.live.map(file => file.blob);
  const none = transport(data.bytes, null);
  const missing = new HostedCheckoutCache(join(data.directory, 'm.forge-client'), none, undefined, null);
  await missing.ensure(ids);
  assert.equal(missing.sourcePack, 'missing');
  assert.equal(none.calls.sourcePack, 1);
  assert.equal(none.calls.downloads, new Set(ids).size);

  const pack = await packFor(t, data);
  const small = transport(data.bytes, pack);
  const few = new HostedCheckoutCache(join(data.directory, 's.forge-client'), small, undefined, null);
  await few.ensure(ids.slice(0, checkoutPackMinimum - 1));
  assert.equal(small.calls.sourcePack, 0);

  const lying = transport(data.bytes, { ...pack, sha256: 'b'.repeat(64) });
  const failed = new HostedCheckoutCache(join(data.directory, 'f.forge-client'), lying, undefined, null);
  await failed.ensure(ids);
  assert.equal(failed.sourcePack, 'failed');
  assert.equal(failed.packObjects, 0);
  for (const id of ids) assert.deepEqual(readFileSync(join(failed.objects, id)), data.bytes.get(id));
  assert.deepEqual(readdirSync(failed.root).sort(), ['objects']);
});

test('pack objects are written only after their own digest matches', async t => {
  const data = fixture(t, 5, 0);
  const archive = join(data.directory, 'pack.gz');
  const object = await createSourcePack('a'.repeat(64), { files: data.packed }, data.source, archive);
  const out = join(data.directory, 'out');
  const written = await unpackSourcePackObjects(object, archive, out, () => true);
  assert.equal(written.length, 5);
  for (const id of written) assert.equal(digest(readFileSync(join(out, id))), id);
  // A pack whose inventory names one blob but carries other bytes writes nothing.
  const header = Buffer.from(
    JSON.stringify({
      version: 1,
      stateRef: 'a'.repeat(64),
      files: [{ path: 'a', blob: digest('a'), mode: 'file', size: 1 }],
    }),
  );
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(header.length);
  const forged = join(data.directory, 'forged.gz');
  writeFileSync(forged, gzipSync(Buffer.concat([prefix, header, Buffer.from('b')])));
  const empty = join(data.directory, 'empty');
  await assert.rejects(
    unpackSourcePackObjects({ ...object, fileCount: 1 }, forged, empty, () => true),
    error => error.code === 'SOURCE_HASH_MISMATCH',
  );
  assert.deepEqual(readdirSync(empty), []);
});

test('the machine store is off in test processes unless configured', () => {
  const saved = process.env.FORGE_OBJECT_CACHE;
  try {
    delete process.env.FORGE_OBJECT_CACHE;
    assert.equal(machineObjectsDirectory(), null);
    process.env.FORGE_OBJECT_CACHE = '/tmp/forge-objects-fixture';
    assert.equal(machineObjectsDirectory(), '/tmp/forge-objects-fixture');
    process.env.FORGE_OBJECT_CACHE = 'off';
    assert.equal(machineObjectsDirectory(), null);
  } finally {
    if (saved === undefined) delete process.env.FORGE_OBJECT_CACHE;
    else process.env.FORGE_OBJECT_CACHE = saved;
  }
});

test('Actions reads run bounded parallel GETs per window; the default stays one at a time', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-reader-parallel-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const values = Array.from({ length: 400 }, (_, i) => Buffer.from(`object ${i}`));
  const byId = new Map(values.map(value => [digest(value), value]));
  const run = async concurrency => {
    let active = 0,
      peak = 0;
    const cache = mkdtempSync(join(directory, 'cache-'));
    const reader = new SourceWorkerReader(
      cache,
      {
        describeBatch: async ids =>
          ids.map(id => ({ object: { sha256: id, size: byId.get(id).length }, recipe: null })),
        read: async pin => {
          active++;
          peak = Math.max(peak, active);
          await new Promise(resolve => setTimeout(resolve, 2));
          active--;
          return [byId.get(pin.sha256)];
        },
        upload: async () => {},
      },
      undefined,
      concurrency,
    );
    await reader.resolveMany([...byId.keys()]);
    for (const [id, value] of byId) assert.deepEqual(readFileSync(join(cache, id)), value);
    return peak;
  };
  assert.equal(await run(1), 1);
  const peak = await run(16);
  assert.ok(peak > 1 && peak <= 16, `peak ${peak}`);
});
