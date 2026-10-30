// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHostedSourceState } from '../dist/hosted-source-worker.js';
import { SourceWorkerReader } from '../dist/hosted-source-worker-reader.js';
import { NativeSource } from '../dist/native-source.js';
import { digest } from '../dist/hash.js';
import { buildObjectRecipe } from '../dist/object-chunks.js';

const at = '2026-01-01T00:00:00.000Z';
const pin = bytes => ({ sha256: digest(bytes), size: bytes.length });
function fixture() {
  const objects = new Map(),
    reads = [],
    uploads = [];
  let clock = 0;
  const put = bytes => {
    const ref = pin(bytes);
    objects.set(ref.sha256, bytes);
    return ref;
  };
  const json = value => put(Buffer.from(JSON.stringify(value)));
  const blob = put(Buffer.from('hello'));
  const file = { path: 'hello', blob: blob.sha256, mode: 'file' };
  const inventory = [{ object: blob, recipe: null }];
  const state = overrides =>
    json({
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files: [file],
      message: 'parent',
      at,
      ...overrides,
    });
  const plan = ({ files = [file], objects = inventory, parents = [], next = null } = {}) => {
    const page = json({ schema: 1, kind: 'forge-source-worker-page', objects, files, next });
    return json({ schema: 1, kind: 'forge-source-worker-state', parents, message: 'save', at, pages: page });
  };
  const transport = {
    async read(ref) {
      reads.push(ref);
      assert(objects.has(ref.sha256), 'fixture source must exist');
      return (async function* () {
        clock += 50000;
        yield objects.get(ref.sha256);
      })();
    },
    async upload(ref, stream) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      assert.deepEqual(pin(bytes), ref);
      uploads.push(ref);
      objects.set(ref.sha256, bytes);
    },
  };
  return {
    objects,
    reads,
    uploads,
    put,
    json,
    blob,
    file,
    inventory,
    plan,
    state,
    transport,
    now: () => clock,
  };
}

test('canonical State matches NativeSource, preserves parents/modes/deletions and never executes repository code', async t => {
  const x = fixture(),
    dangerous = x.put(Buffer.from('process.exit(93); throw new Error("repository executed")'));
  const parent = x.state();
  const files = [
    { path: 'package.json', blob: dangerous.sha256, mode: 'file' },
    { path: 'postinstall.sh', blob: dangerous.sha256, mode: 'executable' },
    { path: 'outside', blob: dangerous.sha256, mode: 'symlink' },
    { path: '.gitmodules', blob: dangerous.sha256, mode: 'file' },
  ];
  const objects = [...x.inventory, { object: parent, recipe: null }, { object: dangerous, recipe: null }];
  const input = x.plan({ files, objects, parents: [parent.sha256] });
  const result = await buildHostedSourceState(input, x.transport);
  const root = mkdtempSync(join(tmpdir(), 'forge-source-expected-'));
  try {
    const source = new NativeSource(root);
    source.put(x.objects.get(parent.sha256));
    assert.equal(result.head, source.writeState(files, [parent.sha256], 'save', at));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const output = JSON.parse(x.objects.get(result.head));
  assert(!output.files.some(file => file.path === 'hello'));
  assert.equal(x.reads.filter(ref => ref.sha256 === dangerous.sha256).length, 1);
  assert.equal(x.uploads.length, 2);
  t.diagnostic(JSON.stringify(result.metrics));
});

test('rejects mismatched source hash and size before output publication', async () => {
  for (const wrong of [Buffer.from('HELLO'), Buffer.from('too long'), Buffer.alloc(0)]) {
    const x = fixture(),
      input = x.plan();
    x.objects.set(x.blob.sha256, wrong);
    await assert.rejects(buildHostedSourceState(input, x.transport), e => e.code === 'SOURCE_HASH_MISMATCH');
    assert.equal(x.uploads.length, 0);
  }
});

test('missing blob, missing ancestor and changed inventory pins do not produce a partial State', async () => {
  const x = fixture();
  for (const input of [
    x.plan({ objects: [] }),
    x.plan({ parents: ['a'.repeat(64)] }),
    x.plan({ objects: [...x.inventory, { object: { ...x.blob, size: 6 }, recipe: null }] }),
  ])
    await assert.rejects(
      buildHostedSourceState(input, x.transport),
      e => e.code === 'SOURCE_CLOSURE_INVALID',
    );
  assert.equal(x.uploads.length, 0);
});

test('native path validation rejects duplicate, overlapping, escaping and metadata paths', async () => {
  const x = fixture();
  for (const paths of [
    ['hello', 'hello'],
    ['a', 'a/b'],
    ['../escape'],
    ['.forge/native.json'],
    ['x/.git/config'],
  ])
    await assert.rejects(
      buildHostedSourceState(x.plan({ files: paths.map(path => ({ ...x.file, path })) }), x.transport),
    );
  assert.equal(x.uploads.length, 0);
});

test('recipe reconstruction verifies physical hashes, logical hash and tree closure', async () => {
  const x = fixture(),
    bytes = Buffer.alloc(3 * 1024 * 1024, 8),
    built = buildObjectRecipe(bytes);
  for (const [id, content] of built.objects) x.objects.set(id, content);
  const recipe = x.put(built.bytes),
    object = pin(bytes);
  const input = x.plan({ files: [{ ...x.file, blob: object.sha256 }], objects: [{ object, recipe }] });
  assert.equal((await buildHostedSourceState(input, x.transport)).state.sha256.length, 64);
  for (const alter of [
    value => ({ ...value, object: { ...value.object, sha256: 'c'.repeat(64) } }),
    value => ({ ...value, tree: { ...value.tree, length: value.tree.length + 1 } }),
    value => ({ ...value, tree: { ...value.tree, sha256: 'd'.repeat(64) } }),
  ]) {
    const changed = x.json(alter(built.recipe));
    await assert.rejects(
      buildHostedSourceState(
        x.plan({ files: [{ ...x.file, blob: object.sha256 }], objects: [{ object, recipe: changed }] }),
        x.transport,
      ),
    );
  }
  const first = built.objects.keys().next().value;
  x.objects.set(first, Buffer.alloc(built.objects.get(first).length));
  await assert.rejects(buildHostedSourceState(input, x.transport));
});

test('multi-page inventory retains every path and reads only the required source objects', async () => {
  const x = fixture(),
    unused = x.put(Buffer.from('unneeded source'));
  const last = x.json({
    schema: 1,
    kind: 'forge-source-worker-page',
    files: [{ ...x.file, path: 'last' }],
    objects: [],
    next: null,
  });
  const input = x.plan({ objects: [...x.inventory, { object: unused, recipe: null }], next: last });
  const result = await buildHostedSourceState(input, x.transport);
  assert.equal(result.metrics.pages, 2);
  assert.deepEqual(
    JSON.parse(x.objects.get(result.head)).files.map(file => file.path),
    ['hello', 'last'],
  );
  assert(!x.reads.some(ref => ref.sha256 === unused.sha256));
});

test('128 MiB raw source streams to disk with bounded chunks; cache prevents a second transfer', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-source-stream-'));
  try {
    const chunk = Buffer.alloc(1024 * 1024, 97),
      hash = createHash('sha256');
    for (let i = 0; i < 128; i++) hash.update(chunk);
    const object = { sha256: hash.digest('hex'), size: 128 * chunk.length };
    let requests = 0;
    const reader = new SourceWorkerReader(root, {
      async read(ref) {
        assert.deepEqual(ref, object);
        requests++;
        return (async function* () {
          for (let i = 0; i < 128; i++) yield chunk;
        })();
      },
      async upload() {
        assert.fail('no upload needed');
      },
    });
    await reader.file({ object, recipe: null });
    await reader.file({ object, recipe: null });
    assert.equal(requests, 1);
    assert.equal(reader.metrics.downloadedBytes, object.size);
    assert.equal(reader.metrics.maxChunkBytes, chunk.length);
    t.diagnostic(
      JSON.stringify({
        ...reader.metrics,
        rssBytes: process.memoryUsage().rss,
        maxRssBytes: process.resourceUsage().maxRSS * 1024,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('128 MiB recipe streams via bounded verified leaves and reconstructs its complete whole-file hash', async t => {
  const x = fixture(),
    chunk = Buffer.alloc(1024 * 1024, 98),
    leaf = x.put(chunk),
    hash = createHash('sha256');
  for (let i = 0; i < 128; i++) hash.update(chunk);
  const object = { sha256: hash.digest('hex'), size: 128 * chunk.length };
  const tree = x.json({
    kind: 'forge-byte-tree',
    schema: 1,
    children: Array.from({ length: 128 }, () => ({ ...leaf, height: 0, length: leaf.size })),
  });
  const recipe = x.json({
    kind: 'forge-object-recipe',
    schema: 1,
    object,
    tree: { ...tree, height: 1, length: object.size },
  });
  const result = await buildHostedSourceState(
    x.plan({ files: [{ ...x.file, blob: object.sha256 }], objects: [{ object, recipe }] }),
    x.transport,
  );
  assert.equal(result.metrics.downloadedBytes < 2 * 1024 * 1024, true);
  assert.equal(x.reads.filter(ref => ref.sha256 === leaf.sha256).length, 1);
  assert.equal(result.metrics.maxChunkBytes, chunk.length);
  t.diagnostic(JSON.stringify(result.metrics));
});

test('transport failures and lost output acknowledgements never send completed callbacks', async () => {
  const x = fixture();
  x.transport.upload = async () => {
    throw new Error('lost upload acknowledgement');
  };
  const input = x.plan();
  await assert.rejects(buildHostedSourceState(input, x.transport));
  assert.equal(x.uploads.length, 0);
});
